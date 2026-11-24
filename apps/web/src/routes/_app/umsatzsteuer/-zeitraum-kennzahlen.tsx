import { formatEuro } from "@haben/core";
import { KzFehler, kzFeld, kzOffen } from "./-zeitraum-feldfehler.tsx";
import { type PageData, SourcesTable, SourcesToggle } from "./-zeitraum-quellen.tsx";
import { kennzahlZeilen, type Ustva } from "./-zeitraum-zeilen.ts";

export type FieldKey =
  | "kz81"
  | "kz86"
  | "kz21"
  | "kz45"
  | "kz48"
  | "kz50"
  | "kz66"
  | "kz46"
  | "kz47"
  | "kz84"
  | "kz85"
  | "kz67"
  | "kz39"
  | "kz41"
  | "kz43"
  | "kz89"
  | "kz93"
  | "kz61"
  | "kz62";

/** Was jede Zeile der Tabelle zum Eintragen und zum Aufklappen der Buchungen braucht */
type KzEingabe = {
  locked: boolean;
  editable: boolean;
  values: Record<FieldKey, string>;
  /** Fehler je Feld nach dem ersten Speichern (useSubmitCheck, #1270) */
  fehler: (field: FieldKey) => string | undefined;
  update: (field: FieldKey, value: string) => void;
  openSources: string | null;
  toggleSources: (kz: string) => void;
};

/** Was die Teile der Tabelle unter den Umsätzen brauchen */
type TeilProps = { data: PageData; zeilen: ReturnType<typeof kennzahlZeilen>; shown: Ustva; computed: Ustva; eingabe: KzEingabe };

/** Kennzahlen mit Bemessung und Steuer, berechnet oder von Hand, darunter die Zahllast (Kz 83) */
export function KennzahlenTabelle({ data, shown, computed, eingabe }: Omit<TeilProps, "zeilen">) {
  const zeilen = kennzahlZeilen(data, shown, computed, eingabe.editable);
  const { rows, igeRows } = zeilen;
  const { locked, editable, values, update, openSources, toggleSources } = eingabe;
  return (
    <div className="kz-table">
      <div className="kz-row head">
        <div>Kz</div>
        <div>Bezeichnung</div>
        <div style={{ textAlign: "right" }}>Bemessung</div>
        <div style={{ textAlign: "right" }}>Steuer</div>
      </div>
      {rows.map((row) => (
        <div key={row.kz}>
          <div className="kz-row">
            <div className="kz-num">{row.kz}</div>
            <div className="kz-label">
              <label htmlFor={`kz-${row.kz}`}>{row.label}</label>
              {!locked && (
                <SourcesToggle
                  kind="revenue"
                  rows={row.sources}
                  open={openSources === row.kz}
                  controls={`kz-${row.kz}-quellen`}
                  onToggle={() => toggleSources(row.kz)}
                />
              )}
            </div>
            {editable ? (
              <input
                id={`kz-${row.kz}`}
                inputMode="decimal"
                value={values[row.field]}
                onChange={(event) => update(row.field, event.target.value)}
                {...kzFeld(eingabe, row.field, `kz-${row.kz}`, "kz-hint")}
              />
            ) : (
              <output id={`kz-${row.kz}`} className="kz-amount">
                {formatEuro(row.base)}
              </output>
            )}
            <div className="kz-amount">{row.tax === null ? "" : formatEuro(row.tax)}</div>
            <KzFehler eingabe={eingabe} field={row.field} id={`kz-${row.kz}`} />
          </div>
          {!locked && openSources === row.kz && <SourcesTable id={`kz-${row.kz}-quellen`} kind="revenue" rows={row.sources} />}
        </div>
      ))}
      {igeRows.map((row) => (
        <div key={row.kz}>
          <div className="kz-row">
            <div className="kz-num">{row.kz}</div>
            <div className="kz-label">
              <label htmlFor={`kz-${row.kz}`}>{row.label}</label>
              {!locked && (
                <SourcesToggle
                  kind="inputTax"
                  rows={row.sources}
                  open={openSources === row.kz}
                  controls={`kz-${row.kz}-quellen`}
                  onToggle={() => toggleSources(row.kz)}
                />
              )}
            </div>
            {editable ? (
              <input
                id={`kz-${row.kz}`}
                inputMode="decimal"
                value={values[row.field]}
                onChange={(event) => update(row.field, event.target.value)}
                {...kzFeld(eingabe, row.field, `kz-${row.kz}`)}
              />
            ) : (
              <output id={`kz-${row.kz}`} className="kz-amount">
                {formatEuro(shown[row.field])}
              </output>
            )}
            <div className="kz-amount">{formatEuro(row.tax)}</div>
            <KzFehler eingabe={eingabe} field={row.field} id={`kz-${row.kz}`} />
          </div>
          {!locked && openSources === row.kz && <SourcesTable id={`kz-${row.kz}-quellen`} kind="inputTax" rows={row.sources} />}
        </div>
      ))}
      <BezugsZeilen data={data} zeilen={zeilen} shown={shown} computed={computed} eingabe={eingabe} />
      <WeitereZeilen data={data} zeilen={zeilen} shown={shown} computed={computed} eingabe={eingabe} />
      <div className="kz-row total">
        <div className="kz-num">83</div>
        <div>{shown.kz83 < 0 ? "Verbleibender Überschuss (Erstattung)" : "Verbleibende Umsatzsteuer-Vorauszahlung"}</div>
        <div />
        <div className="kz-amount">{formatEuro(shown.kz83)}</div>
      </div>
    </div>
  );
}

/** Bezogene Leistungen: Vorsteuer aus Rechnungen (Kz 66) und § 13b als Leistungsempfänger (Kz 46/47, 84/85) */
function BezugsZeilen({ data, zeilen, shown, eingabe }: TeilProps) {
  const { rcRows } = zeilen;
  const { locked, editable, values, update, openSources, toggleSources } = eingabe;
  return (
    <>
      <div className="kz-row">
        <div className="kz-num">66</div>
        <div className="kz-label">
          <label htmlFor="kz-66">Vorsteuer aus Rechnungen anderer Unternehmer</label>
          {!locked && (
            <SourcesToggle
              kind="inputTax"
              rows={data.figures.inputTax}
              open={openSources === "66"}
              controls="kz-66-quellen"
              onToggle={() => toggleSources("66")}
            />
          )}
        </div>
        <div />
        {editable ? (
          <input
            id="kz-66"
            inputMode="decimal"
            value={values.kz66}
            onChange={(event) => update("kz66", event.target.value)}
            {...kzFeld(eingabe, "kz66", "kz-66")}
          />
        ) : (
          <output id="kz-66" className="kz-amount">
            {formatEuro(shown.kz66)}
          </output>
        )}
        <KzFehler eingabe={eingabe} field="kz66" id="kz-66" />
      </div>
      {!locked && openSources === "66" && <SourcesTable id="kz-66-quellen" kind="inputTax" rows={data.figures.inputTax} />}
      {rcRows.map((row) => (
        <div key={row.kz}>
          <div className="kz-row">
            <div className="kz-num">
              {row.kz}/{row.taxKz}
            </div>
            <div className="kz-label">
              <label htmlFor={`kz-${row.kz}`}>{row.label}</label>
              {!locked && (
                <SourcesToggle
                  kind="inputTax"
                  rows={row.sources}
                  open={openSources === row.kz}
                  controls={`kz-${row.kz}-quellen`}
                  onToggle={() => toggleSources(row.kz)}
                />
              )}
            </div>
            {editable ? (
              <>
                <input
                  id={`kz-${row.kz}`}
                  inputMode="decimal"
                  value={values[row.base]}
                  onChange={(event) => update(row.base, event.target.value)}
                  {...kzFeld(eingabe, row.base, `kz-${row.kz}`)}
                />
                <input
                  id={`kz-${row.taxKz}`}
                  aria-label={`Steuer zu Kz ${row.kz} (Kz ${row.taxKz})`}
                  inputMode="decimal"
                  value={values[row.tax]}
                  onChange={(event) => update(row.tax, event.target.value)}
                  {...kzFeld(eingabe, row.tax, `kz-${row.taxKz}`)}
                />
              </>
            ) : (
              <>
                <output id={`kz-${row.kz}`} className="kz-amount">
                  {formatEuro(shown[row.base])}
                </output>
                <div className="kz-amount">{formatEuro(shown[row.tax])}</div>
              </>
            )}
            <KzFehler eingabe={eingabe} field={row.base} id={`kz-${row.kz}`} />
            <KzFehler eingabe={eingabe} field={row.tax} id={`kz-${row.taxKz}`} />
          </div>
          {!locked && openSources === row.kz && <SourcesTable id={`kz-${row.kz}-quellen`} kind="inputTax" rows={row.sources} />}
        </div>
      ))}
    </>
  );
}

/** Vorsteuer aus § 13b (Kz 67) und aus dem Erwerb (Kz 61), Einfuhrumsatzsteuer (Kz 62), Sondervorauszahlung (Kz 39) */
function WeitereZeilen({ zeilen, shown, computed, eingabe }: TeilProps) {
  const { rcRows, igeRows } = zeilen;
  const { editable, values, update } = eingabe;
  return (
    <>
      {(rcRows.length > 0 || shown.kz67 !== 0) && (
        <div className="kz-row">
          <div className="kz-num">67</div>
          <div className="kz-label">
            <label htmlFor="kz-67">Vorsteuer aus Leistungen nach § 13b UStG</label>
          </div>
          <div />
          {editable ? (
            <input
              id="kz-67"
              inputMode="decimal"
              value={values.kz67}
              onChange={(event) => update("kz67", event.target.value)}
              {...kzFeld(eingabe, "kz67", "kz-67")}
            />
          ) : (
            <output id="kz-67" className="kz-amount">
              {formatEuro(shown.kz67)}
            </output>
          )}
          <KzFehler eingabe={eingabe} field="kz67" id="kz-67" />
        </div>
      )}
      {(igeRows.length > 0 || shown.kz61 !== 0) && (
        <div className="kz-row">
          <div className="kz-num">61</div>
          <div className="kz-label">
            <label htmlFor="kz-61">Vorsteuer aus dem innergemeinschaftlichen Erwerb von Gegenständen</label>
          </div>
          <div />
          {editable ? (
            <input
              id="kz-61"
              inputMode="decimal"
              value={values.kz61}
              onChange={(event) => update("kz61", event.target.value)}
              {...kzFeld(eingabe, "kz61", "kz-61")}
            />
          ) : (
            <output id="kz-61" className="kz-amount">
              {formatEuro(shown.kz61)}
            </output>
          )}
          <KzFehler eingabe={eingabe} field="kz61" id="kz-61" />
        </div>
      )}
      {(shown.kz62 !== 0 || computed.kz62 !== 0 || kzOffen(eingabe, "kz62")) && (
        <div className="kz-row">
          <div className="kz-num">62</div>
          <div className="kz-label">
            <label htmlFor="kz-62">Entstandene Einfuhrumsatzsteuer (§ 15 Abs. 1 Satz 1 Nr. 2 UStG)</label>
          </div>
          <div />
          {editable ? (
            <input
              id="kz-62"
              inputMode="decimal"
              value={values.kz62}
              onChange={(event) => update("kz62", event.target.value)}
              {...kzFeld(eingabe, "kz62", "kz-62")}
            />
          ) : (
            <output id="kz-62" className="kz-amount">
              {formatEuro(shown.kz62)}
            </output>
          )}
          <KzFehler eingabe={eingabe} field="kz62" id="kz-62" />
        </div>
      )}
      {(shown.kz39 !== 0 || computed.kz39 !== 0 || kzOffen(eingabe, "kz39")) && (
        <div className="kz-row">
          <div className="kz-num">39</div>
          <div className="kz-label">
            <label htmlFor="kz-39">Abzug der festgesetzten Sondervorauszahlung (Dauerfristverlängerung)</label>
          </div>
          <div />
          {editable ? (
            <input
              id="kz-39"
              inputMode="decimal"
              value={values.kz39}
              onChange={(event) => update("kz39", event.target.value)}
              {...kzFeld(eingabe, "kz39", "kz-39")}
            />
          ) : (
            <output id="kz-39" className="kz-amount">
              {formatEuro(shown.kz39)}
            </output>
          )}
          <KzFehler eingabe={eingabe} field="kz39" id="kz-39" />
        </div>
      )}
    </>
  );
}
