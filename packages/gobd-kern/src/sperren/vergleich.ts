import type { Momentaufnahme, ReplicaVorgabe, Sollbestand, Standardwert, Zeilensicherheit } from "./bestand.ts";
import type { Eingebaute, Eintrag, Gefunden, Katalogobjekte, Erweiterungen } from "./katalog.ts";

/** Art eines fremden Objekts, das einen Aufruf übernehmen kann */
export type Objektart = "funktion" | "operator" | "relation";

/**
 * Ein Befund als Daten; den Text dazu macht die App. `tabelle` ist der Name mit Schema, wie er im Sollbestand steht,
 * bei Zeilensicherheit und Policies der Name ohne Schema.
 */
export type Befund =
  | { art: "replica"; vorgabe: ReplicaVorgabe }
  | { art: "trigger-fehlt" | "trigger-veraendert"; tabelle: string; trigger: string }
  | { art: "trigger-aus"; tabelle: string; trigger: string; zustand: "D" | "R" }
  /** `tabelle` ist die Tabelle des ersten Triggers, der die Funktion aufruft, oder null */
  | { art: "funktion-fehlt" | "funktion-veraendert"; tabelle: string | null; funktion: string }
  | { art: "standardwert-fehlt" | "standardwert-veraendert" | "standardwert-zusaetzlich"; tabelle: string; spalte: string }
  | { art: "zeilensicherheit-eingeschaltet" | "zeilensicherheit-erzwungen"; tabelle: string }
  | { art: "policy"; tabelle: string; policy: string }
  /** im Systemschema pg_catalog angelegt */
  | { art: "objekt-im-systemschema"; objektart: Objektart; name: string }
  /** überdeckt ein gleichnamiges eingebautes oder eigenes Objekt */
  | { art: "objekt-ueberdeckt"; objektart: Objektart; name: string }
  | { art: "cast"; name: string }
  | { art: "schema-im-suchpfad"; schema: string }
  | { art: "pg-catalog-nicht-vorn" }
  | { art: "eingebaute-fehlt" | "eingebaute-veraendert" | "eingebaute-ersetzt"; funktion: string };

/** Ein Hinweis: zusätzlich, aber kein Beleg für eine beschädigte Sperre */
export type Hinweis =
  | { art: "trigger-zusaetzlich"; tabelle: string; trigger: string }
  | { art: "objekt-zusaetzlich"; objektart: Exclude<Objektart, "relation">; name: string }
  | { art: "eingebaute-nicht-geprueft"; soll: number; ist: number };

const nachName = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Vergleicht eine Momentaufnahme mit dem ausgelieferten Sollbestand. Der Sollbestand stammt aus frischen Migrationen,
 * niemals aus der geprüften Instanz. Befunde in fester Reihenfolge: Vorgaben, Trigger, Funktionen, Standardwerte,
 * Zeilensicherheit, fremde Objekte, eingebaute Funktionen.
 */
export function vergleiche(soll: Sollbestand, ist: Momentaufnahme, schema: string): { befunde: Befund[]; hinweise: Hinweis[] } {
  const befunde: Befund[] = ist.replica.map((vorgabe) => ({ art: "replica", vorgabe }));
  const hinweise: Hinweis[] = [];
  const schluessel = (trigger: Sollbestand["triggers"][number]) => `${trigger.table}.${trigger.name}`;
  const triggers = new Map(ist.bestand.triggers.map((trigger) => [schluessel(trigger), trigger]));
  const funktionen = new Map(ist.bestand.functions.map((fn) => [fn.name, fn]));
  for (const trigger of soll.triggers) {
    const gefunden = triggers.get(schluessel(trigger));
    const ort = { tabelle: trigger.table, trigger: trigger.name };
    if (!gefunden) {
      befunde.push({ art: "trigger-fehlt", ...ort });
      continue;
    }
    // O feuert im normalen Betrieb, A immer; D ist aus, R feuert nur im Replikat.
    // https://www.postgresql.org/docs/18/catalog-pg-trigger.html
    if (gefunden.enabled !== "O" && gefunden.enabled !== "A") befunde.push({ art: "trigger-aus", ...ort, zustand: gefunden.enabled === "D" ? "D" : "R" });
    if (gefunden.definition !== trigger.definition || gefunden.function !== trigger.function) befunde.push({ art: "trigger-veraendert", ...ort });
    triggers.delete(schluessel(trigger));
  }
  for (const fn of soll.functions) {
    const gefunden = funktionen.get(fn.name);
    const tabelle = soll.triggers.find((trigger) => trigger.function === fn.name)?.table ?? null;
    if (!gefunden) befunde.push({ art: "funktion-fehlt", tabelle, funktion: fn.name });
    else if (JSON.stringify(gefunden) !== JSON.stringify(fn)) befunde.push({ art: "funktion-veraendert", tabelle, funktion: fn.name });
  }
  befunde.push(...standardwertBefunde(soll.defaults, ist.bestand.defaults));
  befunde.push(...zeilensicherheitBefunde(ist.zeilensicherheit));
  // Fremde Objekte, die Aufrufe der Prüffunktionen übernehmen können
  const fremde = katalogBefunde(ist.katalog, {
    schema,
    suchpfad: ist.suchpfad,
    temp: ist.temp,
    funktionen: soll.functions.map((fn) => fn.name),
    erweiterungen: soll.extensions,
  });
  const eingebaute = eingebauteBefunde(soll.builtins, ist.bestand.builtins);
  befunde.push(...fremde.befunde, ...eingebaute.befunde);
  // Eigene Betreibertrigger gehören nicht zum Sollbestand und beweisen keine beschädigte Sperre, auch wenn sie aus sind.
  for (const trigger of triggers.values()) hinweise.push({ art: "trigger-zusaetzlich", tabelle: trigger.table, trigger: trigger.name });
  hinweise.push(...fremde.hinweise, ...eingebaute.hinweise);
  return { befunde, hinweise };
}

/**
 * Auch ein zusätzlicher Standardwert ist ein Befund: Wo der Sollbestand keinen nennt, erwartet eine Prüfung der Siegel NULL.
 * Spalten werden ohne Schema der Tabelle verglichen.
 */
function standardwertBefunde(soll: Standardwert[], ist: Standardwert[]): Befund[] {
  const befunde: Befund[] = [];
  const spalte = (eintrag: Standardwert) => `${eintrag.table.slice(eintrag.table.indexOf(".") + 1)}.${eintrag.column}`;
  const vorhanden = new Map(ist.map((eintrag) => [spalte(eintrag), eintrag]));
  for (const eintrag of soll) {
    const gefunden = vorhanden.get(spalte(eintrag));
    const ort = { tabelle: eintrag.table, spalte: eintrag.column };
    if (!gefunden) befunde.push({ art: "standardwert-fehlt", ...ort });
    else if (gefunden.expression !== eintrag.expression) befunde.push({ art: "standardwert-veraendert", ...ort });
    vorhanden.delete(spalte(eintrag));
  }
  for (const eintrag of vorhanden.values()) befunde.push({ art: "standardwert-zusaetzlich", tabelle: eintrag.table, spalte: eintrag.column });
  return befunde;
}

/** Jede Zeilensicherheit ist ein Befund; nach Tabelle sortiert, je Tabelle die Zeilensicherheit vor den Policies */
function zeilensicherheitBefunde(gefunden: Zeilensicherheit): Befund[] {
  const tabellen = [...new Set([...gefunden.tables.map((eintrag) => eintrag.table), ...gefunden.policies.map((eintrag) => eintrag.table)])].sort(nachName);
  return tabellen.flatMap((tabelle): Befund[] => {
    const schalter = gefunden.tables.find((eintrag) => eintrag.table === tabelle);
    const policies = gefunden.policies
      .filter((eintrag) => eintrag.table === tabelle)
      .map((eintrag) => eintrag.name)
      .sort(nachName);
    return [
      ...(schalter?.enabled ? [{ art: "zeilensicherheit-eingeschaltet" as const, tabelle }] : []),
      ...(schalter?.forced ? [{ art: "zeilensicherheit-erzwungen" as const, tabelle }] : []),
      ...policies.map((policy) => ({ art: "policy" as const, tabelle, policy })),
    ];
  });
}

/**
 * Befunde und Hinweise zu fremden Objekten. `suchpfad` ist current_schemas(true) der prüfenden Verbindung, `temp` ihr
 * temporäres Schema; `funktionen` sind die Funktionen des Sollbestands, `erweiterungen` die Mitglieder der Erweiterungen
 * einer frischen Installation. Eine Funktion oder ein Operator mit eigenem Namen kann keinen Aufruf übernehmen und ist wie
 * ein zusätzlicher Trigger nur ein Hinweis.
 */
function katalogBefunde(
  objekte: Katalogobjekte,
  erwartet: { schema: string; suchpfad: string[]; temp: string | null; funktionen: string[]; erweiterungen: Erweiterungen },
): { befunde: Befund[]; hinweise: Hinweis[] } {
  const befunde: Befund[] = [];
  const hinweise: Hinweis[] = [];
  const eigene = new Set(erwartet.funktionen);
  const eigeneNamen = new Set(erwartet.funktionen.map((name) => name.slice(name.indexOf(".") + 1, name.indexOf("("))));
  const bekannt = (liste: Eintrag[]) => new Set(liste.map((eintrag) => `${eintrag.name}\n${eintrag.hash}`));
  const mitglieder = {
    functions: bekannt(erwartet.erweiterungen.functions),
    operators: bekannt(erwartet.erweiterungen.operators),
    casts: bekannt(erwartet.erweiterungen.casts),
  };
  const ausgeliefert = (menge: Set<string>, eintrag: Gefunden) => eintrag.extension && menge.has(`${eintrag.name}\n${eintrag.hash}`);
  const beurteile = (objektart: "funktion" | "operator", eintrag: Gefunden, kollidiert: boolean) => {
    if (eintrag.schema === "pg_catalog") befunde.push({ art: "objekt-im-systemschema", objektart, name: eintrag.name });
    else if (kollidiert) befunde.push({ art: "objekt-ueberdeckt", objektart, name: eintrag.name });
    else hinweise.push({ art: "objekt-zusaetzlich", objektart, name: eintrag.name });
  };
  for (const fn of objekte.functions) {
    if (eigene.has(fn.name) || ausgeliefert(mitglieder.functions, fn)) continue;
    beurteile("funktion", fn, fn.builtin || eigeneNamen.has(fn.proname));
  }
  for (const operator of objekte.operators) if (!ausgeliefert(mitglieder.operators, operator)) beurteile("operator", operator, operator.builtin);
  for (const cast of objekte.casts) if (!ausgeliefert(mitglieder.casts, cast)) befunde.push({ art: "cast", name: cast.name });
  for (const relation of objekte.relations) {
    befunde.push({ art: relation.schema === "pg_catalog" ? "objekt-im-systemschema" : "objekt-ueberdeckt", objektart: "relation", name: relation.name });
  }
  // Vor dem geprüften Schema liest PostgreSQL pg_catalog und, wenn es existiert, das Schema mit dem Namen der Anmeldung
  // ("$user"). Das temporäre Schema der Sitzung überspringt es für Funktionen und Operatoren, erkannt an seiner OID, nicht
  // am Namen. https://www.postgresql.org/docs/18/ddl-schemas.html#DDL-SCHEMAS-PATH
  const pfad = erwartet.suchpfad.filter((schema) => schema !== erwartet.temp);
  for (const schema of pfad) if (schema !== "pg_catalog" && schema !== erwartet.schema) befunde.push({ art: "schema-im-suchpfad", schema });
  if (pfad[0] !== "pg_catalog") befunde.push({ art: "pg-catalog-nicht-vorn" });
  return { befunde, hinweise };
}

/** Befunde zu eingebauten Funktionen; auf einer anderen Hauptversion als der des Sollbestands nur ein Hinweis */
export function eingebauteBefunde(soll: Eingebaute, ist: Eingebaute): { befunde: Befund[]; hinweise: Hinweis[] } {
  if (ist.major !== soll.major) return { befunde: [], hinweise: [{ art: "eingebaute-nicht-geprueft", soll: soll.major, ist: ist.major }] };
  const gefunden = new Map(ist.functions.map((fn) => [fn.name, fn.hash]));
  const bekannt = new Set(soll.functions.map((fn) => fn.name));
  const befunde: Befund[] = [];
  for (const fn of soll.functions) {
    const hash = gefunden.get(fn.name);
    if (hash === undefined) befunde.push({ art: "eingebaute-fehlt", funktion: fn.name });
    else if (hash !== fn.hash) befunde.push({ art: "eingebaute-veraendert", funktion: fn.name });
  }
  for (const fn of ist.functions) if (!bekannt.has(fn.name)) befunde.push({ art: "eingebaute-ersetzt", funktion: fn.name });
  return { befunde, hinweise: [] };
}
