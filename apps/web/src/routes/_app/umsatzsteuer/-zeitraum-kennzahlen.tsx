import { type computeUstva, formatEuro } from "@haben/core";
import { type PageData, SourcesTable, SourcesToggle } from "./-zeitraum-quellen.tsx";

export type FieldKey =
  | "kz81"
  | "kz86"
  | "kz21"
  | "kz45"
  | "kz48"
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

type Ustva = ReturnType<typeof computeUstva>;

/** Was jede Zeile der Tabelle zum Eintragen und zum Aufklappen der Buchungen braucht */
type KzEingabe = {
  locked: boolean;
  editable: boolean;
  values: Record<FieldKey, string>;
  parsed: Record<FieldKey, number | null>;
  update: (field: FieldKey, value: string) => void;
  openSources: string | null;
  toggleSources: (kz: string) => void;
};

/** Zeilen der Umsätze, des § 13b und des innergemeinschaftlichen Erwerbs, je mit den Buchungen dahinter */
function kennzahlZeilen(data: PageData, shown: Ustva, computed: Ustva, editable: boolean) {
  const revenue = (rate: number) => data.figures.revenue.filter((r) => r.treatment === "regulaer" && r.rate === rate);
  const treated = (treatment: string) => data.figures.revenue.filter((r) => r.treatment === treatment);
  const rows = [
    { kz: "81", field: "kz81" as const, label: "Steuerpflichtige Umsätze 19 %", base: shown.kz81, tax: shown.tax81 as number | null, sources: revenue(1900) },
    { kz: "86", field: "kz86" as const, label: "Steuerpflichtige Umsätze 7 %", base: shown.kz86, tax: shown.tax86 as number | null, sources: revenue(700) },
    {
      kz: "21",
      field: "kz21" as const,
      label: "Nicht steuerbare sonstige Leistungen im EU-Ausland (Reverse Charge)",
      base: shown.kz21,
      tax: null,
      sources: treated("reverse_charge"),
    },
    {
      kz: "45",
      field: "kz45" as const,
      label: "Übrige nicht steuerbare Umsätze (Leistungsort nicht im Inland)",
      base: shown.kz45,
      tax: null,
      sources: treated("drittland"),
    },
    { kz: "48", field: "kz48" as const, label: "Steuerfreie Umsätze ohne Vorsteuerabzug", base: shown.kz48, tax: null, sources: treated("steuerfrei") },
    {
      kz: "41",
      field: "kz41" as const,
      label: "Steuerfreie innergemeinschaftliche Lieferungen an Abnehmer mit USt-IdNr.",
      base: shown.kz41,
      tax: null,
      sources: treated("ig_lieferung"),
    },
    {
      kz: "43",
      field: "kz43" as const,
      label: "Weitere steuerfreie Umsätze mit Vorsteuerabzug (Ausfuhrlieferungen)",
      base: shown.kz43,
      tax: null,
      sources: treated("ausfuhr"),
    },
    // Kz 21, 45, 48, 41 und 43 nur zeigen, wenn es dort etwas gibt oder von Hand eingetragen wird
  ].filter((row) => ["81", "86"].includes(row.kz) || editable || row.base !== 0 || computed[row.field] !== 0);
  // § 13b als Leistungsempfänger: Bemessungsgrundlage und Steuer, nur wenn belegt oder von Hand
  const rcSources = (kind: "eu" | "drittland") => data.figures.reverseCharge.filter((r) => r.reverseCharge === kind);
  const rcRows = [
    {
      kz: "46",
      taxKz: "47",
      base: "kz46" as const,
      tax: "kz47" as const,
      label: "Sonstige Leistungen eines Unternehmers aus dem EU-Ausland (§ 13b Abs. 1 UStG)",
      sources: rcSources("eu"),
    },
    {
      kz: "84",
      taxKz: "85",
      base: "kz84" as const,
      tax: "kz85" as const,
      label: "Andere Leistungen, für die du die Steuer schuldest (§ 13b Abs. 2 UStG)",
      sources: rcSources("drittland"),
    },
  ].filter((row) => editable || shown[row.base] !== 0 || shown[row.tax] !== 0 || computed[row.base] !== 0 || computed[row.tax] !== 0);
  // Innergemeinschaftlicher Erwerb: Bemessungsgrundlage 89/93, die Steuer rechnet das Formular daraus; Vorsteuer in Kz 61
  const igeSources = (rate: number) => data.figures.igErwerb.filter((r) => r.rate === rate);
  const igeRows = [
    { kz: "89", field: "kz89" as const, label: "Steuerpflichtige innergemeinschaftliche Erwerbe 19 %", tax: shown.tax89, sources: igeSources(1900) },
    { kz: "93", field: "kz93" as const, label: "Steuerpflichtige innergemeinschaftliche Erwerbe 7 %", tax: shown.tax93, sources: igeSources(700) },
  ].filter((row) => editable || shown[row.field] !== 0 || computed[row.field] !== 0);
  return { rows, rcRows, igeRows };
}

/** Was die Teile der Tabelle unter den Umsätzen brauchen */
type TeilProps = { data: PageData; zeilen: ReturnType<typeof kennzahlZeilen>; shown: Ustva; computed: Ustva; eingabe: KzEingabe };

/** Kennzahlen mit Bemessung und Steuer, berechnet oder von Hand, darunter die Zahllast (Kz 83) */
export function KennzahlenTabelle({ data, shown, computed, eingabe }: Omit<TeilProps, "zeilen">) {
  const zeilen = kennzahlZeilen(data, shown, computed, eingabe.editable);
  const { rows, igeRows } = zeilen;
  const { locked, editable, values, parsed, update, openSources, toggleSources } = eingabe;
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
                aria-invalid={parsed[row.field] === null}
                aria-describedby="kz-hint"
              />
            ) : (
              <output id={`kz-${row.kz}`} className="kz-amount">
                {formatEuro(row.base)}
              </output>
            )}
            <div className="kz-amount">{row.tax === null ? "" : formatEuro(row.tax)}</div>
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
                aria-invalid={parsed[row.field] === null}
              />
            ) : (
              <output id={`kz-${row.kz}`} className="kz-amount">
                {formatEuro(shown[row.field])}
              </output>
            )}
            <div className="kz-amount">{formatEuro(row.tax)}</div>
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
  const { locked, editable, values, parsed, update, openSources, toggleSources } = eingabe;
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
            aria-invalid={parsed.kz66 === null}
          />
        ) : (
          <output id="kz-66" className="kz-amount">
            {formatEuro(shown.kz66)}
          </output>
        )}
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
                  aria-invalid={parsed[row.base] === null}
                />
                <input
                  aria-label={`Steuer zu Kz ${row.kz} (Kz ${row.taxKz})`}
                  inputMode="decimal"
                  value={values[row.tax]}
                  onChange={(event) => update(row.tax, event.target.value)}
                  aria-invalid={parsed[row.tax] === null}
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
  const { editable, values, parsed, update } = eingabe;
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
              aria-invalid={parsed.kz67 === null}
            />
          ) : (
            <output id="kz-67" className="kz-amount">
              {formatEuro(shown.kz67)}
            </output>
          )}
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
              aria-invalid={parsed.kz61 === null}
            />
          ) : (
            <output id="kz-61" className="kz-amount">
              {formatEuro(shown.kz61)}
            </output>
          )}
        </div>
      )}
      {(shown.kz62 !== 0 || computed.kz62 !== 0) && (
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
              aria-invalid={parsed.kz62 === null}
            />
          ) : (
            <output id="kz-62" className="kz-amount">
              {formatEuro(shown.kz62)}
            </output>
          )}
        </div>
      )}
      {(shown.kz39 !== 0 || computed.kz39 !== 0) && (
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
              aria-invalid={parsed.kz39 === null}
            />
          ) : (
            <output id="kz-39" className="kz-amount">
              {formatEuro(shown.kz39)}
            </output>
          )}
        </div>
      )}
    </>
  );
}
