import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { positionsFehler } from "../lib/editor-lines.ts";
import { lineState, parseLine, RecurringLineRow } from "./RecurringLines.tsx";

/*
 * Zeile einer Vorlage (#1277): Die Zellen stehen ohne `Field`; jede trägt bei ihrem Fehler selbst `aria-invalid` und zeigt per
 * `aria-describedby` auf ihre eigene Meldung unter der Zeile. Vor dem ersten Speichern ist nichts markiert.
 */

const line = lineState({ description: "", detail: "", quantity: 0, unit: "Psch.", unitPrice: 9500, taxRate: 1900 });

function render(nachDemSpeichern: boolean) {
  const fehler = positionsFehler(line);
  return renderToStaticMarkup(
    createElement(() =>
      RecurringLineRow({
        line,
        parsed: parseLine(line, false),
        index: 0,
        special: false,
        amountLabel: "Netto",
        units: [],
        meldung: (feld) => (nachDemSpeichern ? (fehler[feld] ?? undefined) : undefined),
        removable: false,
        arbeitskosten: false,
        update: () => undefined,
        remove: () => undefined,
      }),
    ),
  );
}

/** Das Eingabefeld mit diesem aria-label */
const eingabe = (html: string, label: string) => html.match(new RegExp(`<input[^>]*aria-label="${label}"[^>]*>`))?.[0] ?? "";

describe("RecurringLineRow", () => {
  it("markiert vor dem ersten Speichern nichts", () => {
    const html = render(false);
    expect(html).not.toContain("aria-invalid");
    expect(html).not.toContain("field-error");
  });

  it("markiert nach dem Speichern genau die Felder mit Fehler, jedes mit seiner Meldung", () => {
    const html = render(true);
    const id = (feld: string) => `pos-fehler-${line.key}-${feld}`;
    expect(eingabe(html, "Beschreibung Position 1")).toContain(`aria-invalid="true"`);
    expect(eingabe(html, "Beschreibung Position 1")).toContain(`aria-describedby="${id("beschreibung")}"`);
    expect(eingabe(html, "Menge Position 1")).toContain(`aria-invalid="true"`);
    expect(eingabe(html, "Menge Position 1")).toContain(`aria-describedby="${id("menge")}"`);
    expect(eingabe(html, "Einzelpreis Position 1 in Euro")).not.toContain("aria-invalid");
    expect(eingabe(html, "Einzelpreis Position 1 in Euro")).not.toContain("aria-describedby");
    expect(html).toContain(`<span id="${id("beschreibung")}" class="field-error">Trag die Beschreibung ein.</span>`);
    expect(html).toContain(`<span id="${id("menge")}" class="field-error">Trag eine Menge über 0 ein, etwa 2 oder 1,5.</span>`);
    expect(html.indexOf(`<span id="${id("beschreibung")}"`)).toBeLessThan(html.indexOf(`<span id="${id("menge")}"`));
  });
});
