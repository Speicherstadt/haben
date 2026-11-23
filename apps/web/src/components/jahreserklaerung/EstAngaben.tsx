import { formatDecimal, formatEuro, parseEuro } from "@haben/core";
import type { Dispatch, SetStateAction } from "react";
import { type ArbeitnehmerDraft, parseArbeitnehmer } from "../AnlageN.tsx";
import { Field } from "../Field.tsx";
import { Block } from "./Block.tsx";
import type { Data } from "./typen.ts";

type Est = Data["est"];
type Angaben = Est["angaben"];
type Kind = Angaben["kinder"][number];
/** Die sechs Arten, die der Vordruck für Einkommensersatzleistungen kennt (§ 32b EStG) */
const ERST_ARTEN = ["Arbeitslosengeld", "Elterngeld", "Insolvenzgeld", "Krankengeld", "Mutterschaftsgeld", "Verdienstausfallentschädigung"] as const;

export type KindDraft = Omit<Kind, "kinderbetreuung"> & { key: number; kinderbetreuung: string };

export const centsText = (cents: number | undefined) => (cents ? formatDecimal(cents) : "");

/** Ein Betragsfeld; leer heißt 0 */
export function Amount({ name, label, value, hint }: { name: string; label: string; value: number | undefined; hint?: string }) {
  return (
    <Field label={label} hint={hint && hint}>
      {(control) => <input {...control} name={name} inputMode="decimal" defaultValue={centsText(value)} placeholder="0,00" />}
    </Field>
  );
}

export const sumOf = (...values: (number | undefined)[]) => values.reduce<number>((s, v) => s + (v ?? 0), 0);
export const sumText = (cents: number) => (cents === 0 ? "nichts eingetragen" : formatEuro(cents));

/** Was neben den Feldern im Zustand der Seite liegt: Kinder und Anlage N, dazu die Vornamen für die Meldungen */
type Entwurf = { kinder: KindDraft[]; anA: ArbeitnehmerDraft; anB: ArbeitnehmerDraft; nameA: string; nameB: string };

/** Liest die Angaben zur Einkommensteuer aus dem Formular; die Bezeichnung jedes ungültigen Betrags landet in `bad` */
export function estAngabenAusFormular(form: FormData, est: Est, { kinder, anA, anB, nameA, nameB }: Entwurf, bad: string[]) {
  const amount = (name: string, label: string) => {
    const text = String(form.get(name) ?? "").trim();
    if (!text) return undefined;
    const cents = parseEuro(text);
    if (cents === null || cents < 0) {
      bad.push(label);
      return undefined;
    }
    return cents || undefined;
  };
  const kidAmount = (k: KindDraft) => {
    if (!k.kinderbetreuung.trim()) return undefined;
    const cents = parseEuro(k.kinderbetreuung);
    if (cents === null || cents < 0) bad.push(`Kinderbetreuung ${k.vorname}`);
    return cents || undefined;
  };
  const vorsorge = (p: "a" | "b") => ({
    rentenversicherung: amount(`${p}-rv`, "Rentenversicherung"),
    gkv: amount(`${p}-gkv`, "Krankenversicherung"),
    gpv: amount(`${p}-gpv`, "Pflegeversicherung"),
    gkvZusatz: amount(`${p}-gkvZusatz`, "Wahlleistungen"),
    pkv: amount(`${p}-pkv`, "Private Krankenversicherung"),
    ppv: amount(`${p}-ppv`, "Private Pflegeversicherung"),
    pkvErstattung: amount(`${p}-pkvErstattung`, "Erstattungen"),
    basisrente: amount(`${p}-basisrente`, "Basisrente"),
    pkvWahlleistungen: amount(`${p}-pkvWahlleistungen`, "Wahlleistungen der privaten KV"),
    agZuschussGkv: amount(`${p}-agZuschussGkv`, "Arbeitgeberzuschuss zur gesetzlichen KV"),
    agZuschussKv: amount(`${p}-agZuschussKv`, "Arbeitgeberzuschuss zur privaten KV"),
    agZuschussPv: amount(`${p}-agZuschussPv`, "Arbeitgeberzuschuss zur Pflegeversicherung"),
  });
  const ersatz = (p: "a" | "b") =>
    ERST_ARTEN.map((art) => ({ art, betrag: amount(`erst-${p}-${art}`, `Einkommensersatz ${art}`) ?? 0 })).filter((z) => z.betrag > 0);
  return {
    vorsorge: { a: vorsorge("a"), ...(est.zusammen ? { b: vorsorge("b") } : {}), sonstige: amount("sonstige", "Weitere Vorsorge") },
    sonderausgaben: {
      kirchensteuerGezahlt: amount("kistGezahlt", "Kirchensteuer"),
      kirchensteuerErstattet: amount("kistErstattet", "Kirchensteuer erstattet"),
      spenden: amount("spenden", "Spenden"),
    },
    krankheitskosten: amount("krankheitskosten", "Krankheitskosten"),
    haushaltsnah: {
      minijobs: amount("minijobs", "Minijobs"),
      dienstleistungen: amount("dienstleistungen", "Haushaltsnahe Dienstleistungen"),
      handwerker: amount("handwerker", "Handwerkerleistungen"),
    },
    kinder: kinder.map((k) => ({
      idnr: k.idnr?.trim() || undefined,
      vorname: k.vorname,
      name: k.name?.trim() || undefined,
      geburtsdatum: k.geburtsdatum,
      familienkasse: k.familienkasse?.trim() ?? "",
      kinderbetreuung: kidAmount(k),
    })),
    ersatzleistungen: {
      a: ersatz("a"),
      ...(est.zusammen ? { b: ersatz("b") } : {}),
    },
    kap: {
      guenstigerpruefung: form.get("guenstigerpruefung") === "on",
      ertraegeMitSteuerabzug: amount("kapMit", "Kapitalerträge"),
      sparerPauschbetrag: amount("kapSpb", "Sparer-Pauschbetrag"),
      ertraegeOhneSteuerabzugInland: amount("kapOhneInl", "Kapitalerträge ohne Steuerabzug"),
      ertraegeAusland: amount("kapAusl", "Ausländische Kapitalerträge"),
      kapitalertragsteuer: amount("kapESt", "Kapitalertragsteuer"),
      soli: amount("kapSoli", "Solidaritätszuschlag"),
      kirchensteuer: amount("kapKiSt", "Kirchensteuer auf Kapitalerträge"),
    },
    arbeitnehmer: {
      a: parseArbeitnehmer(anA, nameA, bad),
      ...(est.zusammen ? { b: parseArbeitnehmer(anB, nameB, bad) } : {}),
    },
  };
}

/** Beiträge zur Vorsorge je Person, bei Zusammenveranlagung für beide; der Titel nennt die gespeicherte Summe */
export function VorsorgeBlock({ est }: { est: Est }) {
  const a = est.angaben;
  const vorsorgeFields = (p: "a" | "b", v: Angaben["vorsorge"]["a"] | undefined) => (
    <div className="form-grid">
      <Amount name={`${p}-rv`} label="Gesetzliche Rentenversicherung" value={v?.rentenversicherung} />
      <Amount name={`${p}-gkv`} label="Gesetzliche Krankenversicherung" value={v?.gkv} hint="ohne Anteil für Krankengeld" />
      <Amount name={`${p}-gpv`} label="Soziale Pflegeversicherung" value={v?.gpv} />
      <Amount name={`${p}-gkvZusatz`} label="Gesetzlich: Krankengeldanteil, Wahlleistungen" value={v?.gkvZusatz} />
      <Amount name={`${p}-pkv`} label="Private Krankenversicherung (Basis)" value={v?.pkv} hint="laut Bescheinigung der Versicherung" />
      <Amount name={`${p}-ppv`} label="Private Pflege-Pflichtversicherung" value={v?.ppv} />
      <Amount name={`${p}-pkvErstattung`} label="Erstattungen der privaten KV/PV" value={v?.pkvErstattung} />
      <Amount name={`${p}-basisrente`} label="Zertifizierte Basisrente (Rürup)" value={v?.basisrente} hint="neben der gesetzlichen Rentenversicherung" />
      <Amount name={`${p}-pkvWahlleistungen`} label="Private KV: Wahlleistungen" value={v?.pkvWahlleistungen} hint="über der Basisabsicherung" />
      <Amount name={`${p}-agZuschussGkv`} label="Arbeitgeberzuschuss zur gesetzlichen KV" value={v?.agZuschussGkv} hint="steuerfrei, Bescheinigung Nr. 24 a" />
      <Amount name={`${p}-agZuschussKv`} label="Arbeitgeberzuschuss zur privaten KV" value={v?.agZuschussKv} hint="steuerfrei, Bescheinigung Nr. 24 b" />
      <Amount name={`${p}-agZuschussPv`} label="Arbeitgeberzuschuss zur Pflegeversicherung" value={v?.agZuschussPv} hint="steuerfrei, Bescheinigung Nr. 24 c" />
    </div>
  );
  const v = (p: "a" | "b") => {
    const x = a.vorsorge[p];
    return sumOf(x?.rentenversicherung, x?.gkv, x?.gpv, x?.gkvZusatz, x?.pkv, x?.ppv, x?.basisrente, x?.pkvWahlleistungen);
  };
  const total = v("a") + (est.zusammen ? v("b") : 0) + (a.vorsorge.sonstige ?? 0);
  return (
    <Block title="Vorsorgeaufwand" summary={sumText(total)} open={false}>
      <h4 className="est-sub">{est.zusammen ? (est.person.a ?? "Person A") : "Beiträge"}</h4>
      {vorsorgeFields("a", a.vorsorge.a)}
      {est.zusammen && (
        <>
          <h4 className="est-sub">{est.person.b ?? "Ehegatte"}</h4>
          {vorsorgeFields("b", a.vorsorge.b)}
        </>
      )}
      <div className="form-grid">
        <Amount name="sonstige" label="Weitere Vorsorge (Haftpflicht, Unfall, Risikoleben)" value={a.vorsorge.sonstige} />
      </div>
    </Block>
  );
}

/** Kinder mit Steuer-ID, Familienkasse und Betreuungskosten; die Liste liegt im Zustand der Seite */
export function KinderBlock({ kinder, setKinder }: { kinder: KindDraft[]; setKinder: Dispatch<SetStateAction<KindDraft[]>> }) {
  const updateKind = (key: number, patch: Partial<KindDraft>) => setKinder((list) => list.map((k) => (k.key === key ? { ...k, ...patch } : k)));
  return (
    <Block title="Kinder" summary={kinder.length === 0 ? "keine" : `${kinder.length} ${kinder.length === 1 ? "Kind" : "Kinder"}`} open={false}>
      {kinder.map((k, index) => (
        <div key={k.key} className="form-grid" role="group" aria-label={`Kind ${index + 1}`}>
          <Field label="Vorname">
            {(control) => <input {...control} value={k.vorname} onChange={(e) => updateKind(k.key, { vorname: e.target.value })} required />}
          </Field>
          <Field label="Geburtsdatum">
            {(control) => (
              <input {...control} type="date" value={k.geburtsdatum} onChange={(e) => updateKind(k.key, { geburtsdatum: e.target.value })} required />
            )}
          </Field>
          <Field label="Steuer-ID">
            {(control) => <input {...control} inputMode="numeric" value={k.idnr ?? ""} onChange={(e) => updateKind(k.key, { idnr: e.target.value })} />}
          </Field>
          <Field label="Familienkasse">
            {(control) => <input {...control} required value={k.familienkasse ?? ""} onChange={(e) => updateKind(k.key, { familienkasse: e.target.value })} />}
          </Field>
          <Field label="Abweichender Nachname">
            {(control) => <input {...control} value={k.name ?? ""} onChange={(e) => updateKind(k.key, { name: e.target.value })} />}
          </Field>
          <Field label="Kinderbetreuungskosten (€)">
            {(control) => (
              <input
                {...control}
                inputMode="decimal"
                value={k.kinderbetreuung}
                onChange={(e) => updateKind(k.key, { kinderbetreuung: e.target.value })}
                placeholder="0,00"
              />
            )}
          </Field>
          <div className="actions" style={{ gridColumn: "1 / -1" }}>
            <button type="button" className="btn btn-danger" onClick={() => setKinder((list) => list.filter((x) => x.key !== k.key))}>
              Kind entfernen
            </button>
          </div>
        </div>
      ))}
      <div>
        <button
          type="button"
          className="btn"
          onClick={() =>
            setKinder((list) => [...list, { key: Math.max(-1, ...list.map((x) => x.key)) + 1, vorname: "", geburtsdatum: "", kinderbetreuung: "" }])
          }
        >
          + Kind hinzufügen
        </button>
      </div>
    </Block>
  );
}

/** Steuerfreie Leistungen, die den Steuersatz erhöhen, je Person; der Titel nennt die gespeicherte Summe */
export function ErsatzBlock({ est }: { est: Est }) {
  const a = est.angaben;
  const liste = (p: "a" | "b") => a.ersatzleistungen?.[p] ?? [];
  const summe = (p: "a" | "b") => sumOf(...liste(p).map((z) => z.betrag));
  const total = summe("a") + (est.zusammen ? summe("b") : 0);
  const felder = (p: "a" | "b") => (
    <div className="form-grid">
      {ERST_ARTEN.map((art) => (
        <Amount key={art} name={`erst-${p}-${art}`} label={art} value={liste(p).find((z) => z.art === art)?.betrag} hint="steuerfrei, erhöht den Steuersatz" />
      ))}
    </div>
  );
  return (
    <Block title="Einkommensersatzleistungen (Progressionsvorbehalt)" summary={sumText(total)} open={false}>
      <h4 className="est-sub">{est.zusammen ? (est.person.a ?? "Person A") : "Leistungen"}</h4>
      {felder("a")}
      {est.zusammen && (
        <>
          <h4 className="est-sub">{est.person.b ?? "Ehegatte"}</h4>
          {felder("b")}
        </>
      )}
    </Block>
  );
}
