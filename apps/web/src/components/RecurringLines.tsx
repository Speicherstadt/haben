import {
  formatDecimal,
  formatEuro,
  formatQuantity,
  ITEM_NUMBER_MAX,
  LINE_DETAIL_MAX,
  lineAmount,
  parseEuro,
  parseQuantity,
  RECURRING_PLACEHOLDERS,
} from "@haben/core";
import type { ReactNode } from "react";
import { positionsSchluessel } from "../lib/editor-lines.ts";
import { unitOptions } from "../lib/units.ts";
import { ArbeitskostenField, LineArbeitskosten, useArbeitskostenSchalter } from "./ArbeitskostenField.tsx";
import { FormattedTextarea } from "./FormattedTextarea.tsx";
import { Icon } from "./Icon.tsx";
import { LineAmount, LineCell } from "./LineCell.tsx";
import { type PositionsMeldung, PositionsMeldungen, zellenAttribute } from "./PositionsFehler.tsx";

/* Positionen einer Vorlage für wiederkehrende Rechnungen (RecurringForm.tsx) */

export type Rate = 1900 | 700 | 0;

export type RecurringLine = {
  description: string;
  detail: string;
  itemNumber?: string;
  quantity: number;
  unit: string;
  unitPrice: number;
  taxRate: Rate;
  /** § 35a EStG (#712); fehlt bei Vorlagen von vor dem Feld */
  arbeitskosten?: boolean;
};

export interface LineState {
  key: number;
  description: string;
  /** Mehrzeilige Beschreibung unter der Bezeichnung */
  detail: string;
  /** Artikelnummer (BT-155), geht in jede Rechnung aus der Vorlage */
  itemNumber: string;
  quantity: string;
  unit: string;
  unitPrice: string;
  taxRate: Rate;
  /** Arbeits-, Maschinen- und Fahrtkosten (§ 35a EStG), geht in jede Rechnung aus der Vorlage */
  arbeitskosten: boolean;
}

let nextKey = 1;

export const lineState = (line: RecurringLine): LineState => ({
  key: nextKey++,
  description: line.description,
  detail: line.detail,
  itemNumber: line.itemNumber ?? "",
  quantity: formatQuantity(line.quantity),
  unit: line.unit,
  unitPrice: line.unitPrice ? formatDecimal(line.unitPrice) : "",
  taxRate: line.taxRate,
  arbeitskosten: line.arbeitskosten ?? false,
});

/** Neue Position mit Einheit und Steuersatz der letzten */
export const newLine = (last: LineState | undefined): LineState => ({
  key: nextKey++,
  description: "",
  detail: "",
  itemNumber: "",
  quantity: "1",
  unit: last?.unit ?? "Psch.",
  unitPrice: "",
  taxRate: last?.taxRate ?? 1900,
  arbeitskosten: false,
});

export type ParsedLine = RecurringLine & { itemNumber: string; arbeitskosten: boolean; valid: boolean };

/** Position mit gelesenen Zahlen; ohne Steuerausweis (special) immer 0 % */
export function parseLine(line: LineState, special: boolean): ParsedLine {
  const quantity = parseQuantity(line.quantity);
  const unitPrice = parseEuro(line.unitPrice);
  return {
    description: line.description.trim(),
    detail: line.detail.trim(),
    itemNumber: line.itemNumber.trim(),
    quantity: quantity ?? 0,
    unit: line.unit,
    unitPrice: unitPrice ?? 0,
    taxRate: special ? (0 as Rate) : line.taxRate,
    arbeitskosten: line.arbeitskosten,
    valid: quantity !== null && quantity > 0 && unitPrice !== null && line.description.trim() !== "",
  };
}

type RowProps = {
  line: LineState;
  parsed: ParsedLine;
  index: number;
  special: boolean;
  amountLabel: string;
  units: readonly string[];
  /** Fehler je Feld der Position aus der Prüfung beim Speichern */
  meldung: PositionsMeldung;
  removable: boolean;
  /** Auswahl „Material oder Arbeit“ zeigen (§ 35a EStG) */
  arbeitskosten: boolean;
  update: (patch: Partial<LineState>) => void;
  remove: () => void;
};

function LineTitle({ line, index, update, arbeitskosten, meldung }: Pick<RowProps, "line" | "index" | "update" | "arbeitskosten" | "meldung">) {
  return (
    <div className={arbeitskosten ? "line-title with-kind" : "line-title"}>
      <input
        className="line-item"
        placeholder="Art.-Nr."
        aria-label={`Artikelnummer Position ${index + 1} (optional)`}
        value={line.itemNumber}
        maxLength={ITEM_NUMBER_MAX}
        autoComplete="off"
        onChange={(e) => update({ itemNumber: e.target.value })}
      />
      <input
        className="line-desc"
        placeholder={`Beschreibung Position ${index + 1}, z. B. Wartung {monat} {jahr}`}
        aria-label={`Beschreibung Position ${index + 1}`}
        value={line.description}
        onChange={(e) => update({ description: e.target.value })}
        {...zellenAttribute(meldung, line.key, "beschreibung")}
      />
      {arbeitskosten && <LineArbeitskosten index={index} value={line.arbeitskosten} onChange={(value) => update({ arbeitskosten: value })} />}
    </div>
  );
}

function LineNumbers({ line, index, special, units, update, meldung }: Pick<RowProps, "line" | "index" | "special" | "units" | "update" | "meldung">) {
  return (
    <>
      <LineCell label="Menge">
        <input
          className="num"
          inputMode="decimal"
          aria-label={`Menge Position ${index + 1}`}
          value={line.quantity}
          onChange={(e) => update({ quantity: e.target.value })}
          {...zellenAttribute(meldung, line.key, "menge")}
        />
      </LineCell>
      <LineCell label="Einheit">
        {/* biome-ignore lint/plugin: Zeile einer Positionstabelle: Spaltenkopf und aria-label benennen die Zelle, ein Feldname je Zelle gäbe jeder Zeile eine Hülle `.field` */}
        <select aria-label={`Einheit Position ${index + 1}`} value={line.unit} onChange={(e) => update({ unit: e.target.value })}>
          {unitOptions(units, line.unit).map((unit) => (
            <option key={unit}>{unit}</option>
          ))}
        </select>
      </LineCell>
      <LineCell label="Einzelpreis">
        <input
          className="num"
          inputMode="decimal"
          aria-label={`Einzelpreis Position ${index + 1} in Euro`}
          value={line.unitPrice}
          placeholder="0,00"
          onChange={(e) => update({ unitPrice: e.target.value })}
          {...zellenAttribute(meldung, line.key, "einzelpreis")}
        />
      </LineCell>
      <LineCell label="USt">
        {/* biome-ignore lint/plugin: Zeile einer Positionstabelle: Spaltenkopf und aria-label benennen die Zelle, ein Feldname je Zelle gäbe jeder Zeile eine Hülle `.field` */}
        <select
          aria-label={`Steuersatz Position ${index + 1}`}
          value={special ? 0 : line.taxRate}
          disabled={special}
          onChange={(e) => update({ taxRate: Number(e.target.value) as Rate })}
        >
          <option value={1900}>19 %</option>
          <option value={700}>7 %</option>
          <option value={0}>0 %</option>
        </select>
      </LineCell>
    </>
  );
}

export function RecurringLineRow(props: RowProps) {
  const { line, parsed: p, index, amountLabel, arbeitskosten, meldung, removable, update, remove } = props;
  return (
    <div className="line-row">
      <LineTitle line={line} index={index} update={update} arbeitskosten={arbeitskosten} meldung={meldung} />
      <FormattedTextarea
        className="line-detail"
        rows={line.detail ? Math.min(6, line.detail.split("\n").length) : 1}
        placeholder="Text zur Position (optional, mehrzeilig)"
        aria-label={`Text zu Position ${index + 1} (optional)`}
        value={line.detail}
        maxLength={LINE_DETAIL_MAX}
        onChange={(e) => update({ detail: e.target.value })}
      />
      <LineNumbers {...props} />
      <LineAmount label={amountLabel}>{p.valid ? formatEuro(lineAmount(p.quantity, p.unitPrice)) : "–"}</LineAmount>
      <div className="line-actions">
        <button type="button" className="icon-btn" aria-label={`Position ${index + 1} entfernen`} disabled={!removable} onClick={remove}>
          <Icon name="close" size={16} />
        </button>
      </div>
      <PositionsMeldungen meldung={meldung} lineKey={line.key} />
    </div>
  );
}

export function RecurringPositions(props: {
  lines: LineState[];
  setLines: (update: (prev: LineState[]) => LineState[]) => void;
  parsed: ParsedLine[];
  special: boolean;
  amountLabel: string;
  units: readonly string[];
  error: (key: string) => string | undefined;
  /** Einleitung über den Positionen */
  kopf: ReactNode;
  /** Hinweis und Eigentumsvorbehalt unter den Positionen */
  fuss: ReactNode;
}) {
  const { lines, setLines } = props;
  const updateLine = (key: number, patch: Partial<LineState>) => setLines((prev) => prev.map((line) => (line.key === key ? { ...line, ...patch } : line)));
  // § 35a EStG (#712), dieselbe Regel wie im Rechnungseditor
  const [arbeitskosten, setArbeitskosten] = useArbeitskostenSchalter(lines, setLines);
  return (
    <section className="card" aria-labelledby="recurring-lines">
      <h2 id="recurring-lines">Positionen</h2>
      {props.kopf}
      <div className="line-row head" aria-hidden="true">
        <div className="num">Menge</div>
        <div>Einheit</div>
        <div className="num">Einzelpreis</div>
        <div>USt</div>
        <div className="num">{props.amountLabel}</div>
        <div />
      </div>
      {lines.map((line, index) => (
        <RecurringLineRow
          key={line.key}
          line={line}
          parsed={props.parsed[index]!}
          index={index}
          special={props.special}
          amountLabel={props.amountLabel}
          units={props.units}
          meldung={(feld) => props.error(positionsSchluessel(line.key, feld))}
          removable={lines.length > 1}
          arbeitskosten={arbeitskosten}
          update={(patch) => updateLine(line.key, patch)}
          remove={() => setLines((prev) => prev.filter((l) => l.key !== line.key))}
        />
      ))}
      <div className="actions">
        <button type="button" className="btn btn-dashed" onClick={() => setLines((prev) => [...prev, newLine(prev.at(-1))])}>
          <Icon name="plus" size={16} /> Position hinzufügen
        </button>
      </div>
      {props.fuss}
      <ArbeitskostenField checked={arbeitskosten} onChange={setArbeitskosten} />
      <p className="small muted" style={{ margin: 0 }}>
        Platzhalter in Einleitung, Beschreibung, Text zur Position und Hinweis:{" "}
        {Object.entries(RECURRING_PLACEHOLDERS)
          .map(([key, label]) => `${key} (${label})`)
          .join(", ")}
        . Sie beziehen sich auf den Leistungszeitraum, ohne Leistungszeitraum auf das Rechnungsdatum.
      </p>
    </section>
  );
}
