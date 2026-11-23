import { isValidIdnr } from "@haben/elster/idnr";
import { type ArbeitnehmerDraft, anlageNLesen } from "./anlage-n-pruefung.ts";
import { betragLesen, type Fehler } from "./eingabe-pruefung.ts";
import type { Data } from "./typen.ts";

type Kind = Data["est"]["angaben"]["kinder"][number];
export type KindDraft = Omit<Kind, "kinderbetreuung"> & { key: number; kinderbetreuung: string };

/** Die sechs Arten, die der Vordruck für Einkommensersatzleistungen kennt (§ 32b EStG) */
export const ERST_ARTEN = ["Arbeitslosengeld", "Elterngeld", "Insolvenzgeld", "Krankengeld", "Mutterschaftsgeld", "Verdienstausfallentschädigung"] as const;

/** Höchstzahl der Kinder wie im Schema des Servers */
export const HOECHSTENS_KINDER = 15;

/** Schlüssel eines Felds eines Kinds für useSubmitCheck */
export const kindSchluessel = (key: number, feld: string) => `kind-${key}-${feld}`;

/** Was neben den Feldern mit `name` im Zustand der Seite liegt: Kinder und Anlage N */
type Entwurf = { kinder: KindDraft[]; anA: ArbeitnehmerDraft; anB: ArbeitnehmerDraft };

/** Die Felder mit `name`: beim Absenden FormData, beim Rendern der zuletzt gelesene Stand des Formulars */
export type Formularwerte = { get(name: string): FormDataEntryValue | null };

function kindLesen(k: KindDraft, fehler: Fehler) {
  const s = (feld: string) => kindSchluessel(k.key, feld);
  const idnr = k.idnr?.replace(/\s+/g, "") ?? "";
  fehler[s("vorname")] = k.vorname.trim() ? null : "Trag den Vornamen des Kindes ein.";
  fehler[s("geburtsdatum")] = k.geburtsdatum ? null : "Wähle das Geburtsdatum.";
  fehler[s("idnr")] = idnr === "" || isValidIdnr(idnr) ? null : "Trag eine gültige Steuer-ID mit 11 Ziffern ein, oder lass das Feld leer.";
  fehler[s("familienkasse")] = k.familienkasse?.trim() ? null : "Trag die zuständige Familienkasse ein.";
  return {
    idnr: k.idnr?.trim() || undefined,
    vorname: k.vorname,
    name: k.name?.trim() || undefined,
    geburtsdatum: k.geburtsdatum,
    familienkasse: k.familienkasse?.trim() ?? "",
    kinderbetreuung: betragLesen(fehler, s("kinderbetreuung"), k.kinderbetreuung),
  };
}

/**
 * Liest die Angaben zur Einkommensteuer (#1277): Beträge der Felder mit `name` unter ihrem Namen, Kinder und Anlage N je
 * Zeile. `fehler` hat für jedes Feld einen Eintrag, mit der Meldung für useSubmitCheck oder null; Grenzen wie der Server.
 */
export function estAngabenLesen(form: Formularwerte, zusammen: boolean, { kinder, anA, anB }: Entwurf) {
  const fehler: Fehler = {};
  const amount = (name: string) => betragLesen(fehler, name, String(form.get(name) ?? ""));
  const vorsorge = (p: "a" | "b") => ({
    rentenversicherung: amount(`${p}-rv`),
    gkv: amount(`${p}-gkv`),
    gpv: amount(`${p}-gpv`),
    gkvZusatz: amount(`${p}-gkvZusatz`),
    pkv: amount(`${p}-pkv`),
    ppv: amount(`${p}-ppv`),
    pkvErstattung: amount(`${p}-pkvErstattung`),
    basisrente: amount(`${p}-basisrente`),
    pkvWahlleistungen: amount(`${p}-pkvWahlleistungen`),
    agZuschussGkv: amount(`${p}-agZuschussGkv`),
    agZuschussKv: amount(`${p}-agZuschussKv`),
    agZuschussPv: amount(`${p}-agZuschussPv`),
  });
  const ersatz = (p: "a" | "b") => ERST_ARTEN.map((art) => ({ art, betrag: amount(`erst-${p}-${art}`) ?? 0 })).filter((z) => z.betrag > 0);
  const angaben = {
    vorsorge: { a: vorsorge("a"), ...(zusammen ? { b: vorsorge("b") } : {}), sonstige: amount("sonstige") },
    sonderausgaben: { kirchensteuerGezahlt: amount("kistGezahlt"), kirchensteuerErstattet: amount("kistErstattet"), spenden: amount("spenden") },
    krankheitskosten: amount("krankheitskosten"),
    haushaltsnah: { minijobs: amount("minijobs"), dienstleistungen: amount("dienstleistungen"), handwerker: amount("handwerker") },
    kinder: kinder.map((k) => kindLesen(k, fehler)),
    ersatzleistungen: { a: ersatz("a"), ...(zusammen ? { b: ersatz("b") } : {}) },
    kap: {
      guenstigerpruefung: form.get("guenstigerpruefung") === "on",
      ertraegeMitSteuerabzug: amount("kapMit"),
      sparerPauschbetrag: amount("kapSpb"),
      ertraegeOhneSteuerabzugInland: amount("kapOhneInl"),
      ertraegeAusland: amount("kapAusl"),
      kapitalertragsteuer: amount("kapESt"),
      soli: amount("kapSoli"),
      kirchensteuer: amount("kapKiSt"),
    },
    arbeitnehmer: { a: anlageNLesen(anA, "a", fehler), ...(zusammen ? { b: anlageNLesen(anB, "b", fehler) } : {}) },
  };
  return { angaben, fehler };
}
