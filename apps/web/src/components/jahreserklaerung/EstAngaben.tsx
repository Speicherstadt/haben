import { formatDecimal, formatEuro } from "@haben/core";
import { createContext, type Dispatch, type SetStateAction, useContext } from "react";
import { Field } from "../Field.tsx";
import { Block } from "./Block.tsx";
import { ERST_ARTEN, HOECHSTENS_KINDER, type KindDraft, kindSchluessel } from "./est-pruefung.ts";
import type { Data } from "./typen.ts";

type Est = Data["est"];
type Angaben = Est["angaben"];

export const centsText = (cents: number | undefined) => (cents ? formatDecimal(cents) : "");

/**
 * Fehler je Feld aus useSubmitCheck der Einkommensteuer (#1277), über den Schlüssel des Felds: bei Beträgen ihr `name`,
 * bei Kindern und Anlage N `kindSchluessel` und `anSchluessel`. So braucht nicht jeder Block die Prüfung als Eigenschaft.
 */
export const EstFehler = createContext<(key: string) => string | undefined>(() => undefined);

/** Ein Betragsfeld; leer heißt 0 */
export function Amount({ name, label, value, hint }: { name: string; label: string; value: number | undefined; hint?: string }) {
  const fehler = useContext(EstFehler);
  return (
    <Field label={label} hint={hint && hint} error={fehler(name)}>
      {(control) => <input {...control} name={name} inputMode="decimal" defaultValue={centsText(value)} placeholder="0,00" />}
    </Field>
  );
}

export const sumOf = (...values: (number | undefined)[]) => values.reduce<number>((s, v) => s + (v ?? 0), 0);
export const sumText = (cents: number) => (cents === 0 ? "nichts eingetragen" : formatEuro(cents));

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
  const fehler = useContext(EstFehler);
  return (
    <Block title="Kinder" summary={kinder.length === 0 ? "keine" : `${kinder.length} ${kinder.length === 1 ? "Kind" : "Kinder"}`} open={false}>
      {kinder.map((k, index) => (
        <div key={k.key} className="form-grid" role="group" aria-label={`Kind ${index + 1}`}>
          <Field label="Vorname" error={fehler(kindSchluessel(k.key, "vorname"))}>
            {(control) => <input {...control} value={k.vorname} onChange={(e) => updateKind(k.key, { vorname: e.target.value })} required maxLength={100} />}
          </Field>
          <Field label="Geburtsdatum" error={fehler(kindSchluessel(k.key, "geburtsdatum"))}>
            {(control) => (
              <input {...control} type="date" value={k.geburtsdatum} onChange={(e) => updateKind(k.key, { geburtsdatum: e.target.value })} required />
            )}
          </Field>
          <Field label="Steuer-ID" error={fehler(kindSchluessel(k.key, "idnr"))}>
            {(control) => <input {...control} inputMode="numeric" value={k.idnr ?? ""} onChange={(e) => updateKind(k.key, { idnr: e.target.value })} />}
          </Field>
          <Field label="Familienkasse" error={fehler(kindSchluessel(k.key, "familienkasse"))}>
            {(control) => (
              <input
                {...control}
                required
                maxLength={100}
                value={k.familienkasse ?? ""}
                onChange={(e) => updateKind(k.key, { familienkasse: e.target.value })}
              />
            )}
          </Field>
          <Field label="Abweichender Nachname">
            {(control) => <input {...control} value={k.name ?? ""} onChange={(e) => updateKind(k.key, { name: e.target.value })} maxLength={100} />}
          </Field>
          <Field label="Kinderbetreuungskosten (€)" error={fehler(kindSchluessel(k.key, "kinderbetreuung"))}>
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
      {/* Mehr nimmt der Server nicht an; ohne Platz fehlt der Knopf (DESIGN.md, Gesperrte Knöpfe) */}
      {kinder.length < HOECHSTENS_KINDER ? (
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
      ) : (
        <p className="small muted" style={{ margin: 0 }}>
          Haben nimmt höchstens {HOECHSTENS_KINDER} Kinder auf.
        </p>
      )}
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
