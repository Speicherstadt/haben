import type { ReactNode } from "react";
import { Field } from "./Field.tsx";
import { HOECHSTZAHL } from "./kapg-angaben-pruefung.ts";

/* Anteilseigner in den Angaben zur Körperschaft- und Gewerbesteuererklärung (KapgAngaben.tsx) */

export type Person = {
  name: string;
  strasse: string;
  plzOrt: string;
  nummer: string;
  beteiligung: string;
  anteil: string;
  geaendert: boolean;
  /** Kirchensteuerabzugsmerkmal für Ausschüttungen: Satz und Religionsschlüssel */
  kirchensteuer: 0 | 8 | 9;
  religionsschluessel: string;
  /** Für die Steuerbescheinigung (Muster II): Name der kirchensteuererhebenden Religionsgemeinschaft */
  religionsgemeinschaft: string;
};

const leererAnteilseigner: Person = {
  name: "",
  strasse: "",
  plzOrt: "",
  nummer: "",
  beteiligung: "",
  anteil: "",
  geaendert: true,
  kirchensteuer: 0,
  religionsschluessel: "",
  religionsgemeinschaft: "",
};

/** fehler: Meldung aus useSubmitCheck für ein Feld dieser Zeile (#1277) */
type Zeile = { p: Person; i: number; set: (patch: Partial<Person>) => void; fehler: (feld: keyof Person) => string | undefined };

/** Beschriftung mit der Nummer des Anteilseigners für Screenreader */
const Label = ({ text, i }: { text: ReactNode; i: number }) => (
  <>
    {text}
    <span className="visually-hidden"> Anteilseigner {i + 1}</span>
  </>
);

function Anschrift({ p, i, set, fehler }: Zeile) {
  return (
    <div className="form-row cols-3">
      <Field label={<Label text="Name" i={i} />} error={fehler("name")}>
        {(control) => <input {...control} value={p.name} onChange={(e) => set({ name: e.target.value })} required maxLength={200} />}
      </Field>
      <Field label={<Label text="Straße und Hausnummer" i={i} />} error={fehler("strasse")}>
        {(control) => <input {...control} value={p.strasse} onChange={(e) => set({ strasse: e.target.value })} required maxLength={200} />}
      </Field>
      <Field label={<Label text="PLZ und Ort" i={i} />} error={fehler("plzOrt")}>
        {(control) => <input {...control} value={p.plzOrt} onChange={(e) => set({ plzOrt: e.target.value })} required maxLength={200} />}
      </Field>
    </div>
  );
}

function Beteiligung({ p, i, set, fehler }: Zeile) {
  return (
    <div className="form-row cols-3">
      <Field label={<Label text="Identifikationsnummer oder Steuernummer" i={i} />} hint="11 oder 13 Ziffern" error={fehler("nummer")}>
        {(control) => <input {...control} inputMode="numeric" value={p.nummer} onChange={(e) => set({ nummer: e.target.value })} required />}
      </Field>
      <Field label={<Label text="Beteiligung in Euro" i={i} />} error={fehler("beteiligung")}>
        {(control) => <input {...control} inputMode="decimal" value={p.beteiligung} onChange={(e) => set({ beteiligung: e.target.value })} required />}
      </Field>
      <Field label={<Label text="Anteil in Prozent" i={i} />} hint="Über 0 bis 100 %, höchstens zwei Nachkommastellen" error={fehler("anteil")}>
        {(control) => <input {...control} inputMode="decimal" value={p.anteil} onChange={(e) => set({ anteil: e.target.value })} required />}
      </Field>
    </div>
  );
}

function Kirchensteuer({ p, i, set, fehler }: Zeile) {
  return (
    <div className="form-row cols-3">
      <Field label={<Label text="Kirchensteuer bei Ausschüttungen" i={i} />}>
        {(control) => (
          <select {...control} value={p.kirchensteuer} onChange={(e) => set({ kirchensteuer: Number(e.target.value) as Person["kirchensteuer"] })}>
            <option value={0}>keine</option>
            <option value={8}>8 % (Bayern, Baden-Württemberg)</option>
            <option value={9}>9 %</option>
          </select>
        )}
      </Field>
      {p.kirchensteuer > 0 && (
        <Field label={<Label text="Religionsschlüssel" i={i} />} hint="Sechs Ziffern aus dem Kirchensteuerabzugsmerkmal" error={fehler("religionsschluessel")}>
          {(control) => (
            <input
              {...control}
              inputMode="numeric"
              value={p.religionsschluessel}
              onChange={(e) => set({ religionsschluessel: e.target.value })}
              placeholder="z. B. 010100"
              required
            />
          )}
        </Field>
      )}
      {p.kirchensteuer > 0 && (
        <Field label={<Label text="Kirchensteuererhebende Religionsgemeinschaft" i={i} />}>
          {(control) => (
            <input
              {...control}
              value={p.religionsgemeinschaft}
              onChange={(e) => set({ religionsgemeinschaft: e.target.value })}
              placeholder="z. B. römisch-katholisch"
              maxLength={200}
            />
          )}
        </Field>
      )}
    </div>
  );
}

function Anteilseigner({ remove, ...zeile }: Zeile & { remove: () => void }) {
  const { p, i, set } = zeile;
  return (
    <div className="stack sub-group" style={{ gap: 12 }} role="group" aria-label={`Anteilseigner ${i + 1}`}>
      <div className="sub-group-title" aria-hidden="true">
        Anteilseigner {i + 1}
      </div>
      <Anschrift {...zeile} />
      <Beteiligung {...zeile} />
      <Kirchensteuer {...zeile} />
      <div className="actions" style={{ justifyContent: "space-between" }}>
        <label className="checkbox">
          <input type="checkbox" checked={p.geaendert} onChange={(e) => set({ geaendert: e.target.checked })} />
          Angaben gegenüber dem Vorjahr geändert
        </label>
        <button type="button" className="btn btn-sm btn-danger" onClick={remove}>
          Anteilseigner {i + 1} entfernen
        </button>
      </div>
    </div>
  );
}

export function KapgAnteilseigner({
  personen,
  setPersonen,
  error,
}: {
  personen: Person[];
  setPersonen: (p: Person[]) => void;
  /** Meldung aus useSubmitCheck zum Schlüssel `anteilseigner.<Zeile>.<Feld>` */
  error: (key: string) => string | undefined;
}) {
  const setPerson = (i: number, patch: Partial<Person>) => setPersonen(personen.map((p, j) => (j === i ? { ...p, ...patch } : p)));
  return (
    <fieldset className="stack fieldset-plain" style={{ gap: 16 }}>
      <legend>Anteilseigner</legend>
      {personen.map((p, i) => (
        <Anteilseigner
          key={i}
          p={p}
          i={i}
          set={(patch) => setPerson(i, patch)}
          fehler={(feld) => error(`anteilseigner.${i}.${feld}`)}
          remove={() => setPersonen(personen.filter((_, j) => j !== i))}
        />
      ))}
      {/* Mehr nimmt der Server nicht an (kapgErklaerungSchema) */}
      {personen.length < HOECHSTZAHL ? (
        <div>
          <button type="button" className="btn" onClick={() => setPersonen([...personen, { ...leererAnteilseigner }])}>
            Anteilseigner hinzufügen
          </button>
        </div>
      ) : (
        <p className="small muted">Höchstens {HOECHSTZAHL} Anteilseigner.</p>
      )}
    </fieldset>
  );
}
