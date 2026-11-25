import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AufteilungHinweis } from "./-beleg-betraege.tsx";
import { type AufteilungVorsteuer, aufteilungVorsteuer, privatanteilFaelltWeg } from "./-beleg-pruefung.ts";

/** Firmendaten und Belegangaben, wie die Beträge-Karte sie an den Hinweis gibt */
const einzelunternehmen = { kleinunternehmer: false, ohneVorsteuerabzug: false };
const ohneVorsteuerabzug = { kleinunternehmer: false, ohneVorsteuerabzug: true };

/** Der Hinweis, wie ihn die Beträge-Karte bei dieser Eingabe im Feld Privatanteil zeigt */
function hinweis(
  eingabe: string,
  beleg = { value: "", company: einzelunternehmen, booked: false, storedDeduction: true },
  saetze = [{ vorsteuerAnteil: "" }],
): string {
  const anteil = privatanteilFaelltWeg(eingabe, true);
  expect(anteil, eingabe).not.toBeNull();
  const vorsteuer: AufteilungVorsteuer = aufteilungVorsteuer(beleg, saetze);
  return renderToStaticMarkup(createElement(AufteilungHinweis, { anteil: anteil!, vorsteuer }));
}

describe("Hinweis auf den wegfallenden Privatanteil", () => {
  // Gelesen wird über parseWholePercent; „25“, „25 %“, „25%“ und „ 25 “ sind derselbe Anteil
  it.each(["25", "25 %", "25%", " 25 "])("zeigt den gelesenen Anteil bei der Eingabe %s nur einmal als Prozent (#1914)", (eingabe) => {
    const html = hinweis(eingabe);
    expect(html).toContain("Die eingetragenen 25\u00a0% fallen weg");
    expect(html).not.toContain("% %");
    // Der Anteil selbst steht genau einmal da; „100 %“ im Folgesatz ist ein anderer Wert
    expect(html.match(/25\u00a0%/g)).toHaveLength(1);
  });

  it("sagt ohne Abzug, dass keine Vorsteuer abziehbar ist (Kleinunternehmer oder Firmenvorgabe)", () => {
    for (const company of [{ kleinunternehmer: true, ohneVorsteuerabzug: false }, ohneVorsteuerabzug]) {
      const html = hinweis("25", { value: "", company, booked: false, storedDeduction: true });
      expect(html).toContain("Dann ist keine Vorsteuer abziehbar.");
      expect(html).not.toContain("voll ab");
    }
  });

  it("nennt bei voller Vorgabe den Grund der vollen Vorsteuer", () => {
    expect(hinweis("25")).toContain("Die Vorsteuer zieht Haben dann voll ab (Vorsteueranteil 100 %).");
  });

  it("sagt bei abweichendem Vorsteueranteil, dass nur dieser Teil abziehbar ist", () => {
    const html = hinweis("25", { value: "50", company: einzelunternehmen, booked: false, storedDeduction: true });
    expect(html).toContain("Vorsteuer zieht Haben dann nur zu 50 % ab; der Rest bleibt Aufwand.");
  });

  it("sagt bei verschiedenen Sätzen, dass jeder Satz seinen eigenen Anteil hat", () => {
    const html = hinweis("25", { value: "", company: einzelunternehmen, booked: false, storedDeduction: true }, [
      { vorsteuerAnteil: "" },
      { vorsteuerAnteil: "50" },
    ]);
    expect(html).toContain("je Steuersatz nach dessen Vorsteueranteil");
  });

  it("nennt die Folge für Aufwand und Entnahme und den Weg zurück", () => {
    const html = hinweis("25");
    expect(html).toContain("der ganze Nettobetrag bleibt Aufwand statt als Entnahme zu laufen");
    expect(html).toContain("Nimm die Aufteilung zurück");
    expect(html).not.toContain("Vorsteueranteil auf den betrieblichen Teil");
  });
});
