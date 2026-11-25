import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AufteilungHinweis } from "./-beleg-betraege.tsx";
import { privatanteilFaelltWeg } from "./-beleg-pruefung.ts";

/** Der Hinweis, wie ihn die Beträge-Karte bei dieser Eingabe im Feld Privatanteil zeigt */
function hinweis(eingabe: string): string {
  const anteil = privatanteilFaelltWeg(eingabe, true);
  expect(anteil, eingabe).not.toBeNull();
  return renderToStaticMarkup(createElement(AufteilungHinweis, { anteil: anteil! }));
}

describe("Hinweis auf den wegfallenden Privatanteil", () => {
  // Gelesen wird über parseWholePercent; „25“, „25 %“, „25%“ und „ 25 “ sind derselbe Anteil
  it.each(["25", "25 %", "25%", " 25 "])("zeigt den gelesenen Anteil bei der Eingabe %s nur einmal als Prozent (#1914)", (eingabe) => {
    const html = hinweis(eingabe);
    expect(html).toContain("Die eingetragenen 25\u00a0% fallen weg");
    expect(html).not.toContain("% %");
    expect(html.match(/%/g)).toHaveLength(1);
  });

  it("sagt, dass der Vorsteueranteil den Privatanteil nicht ersetzt", () => {
    const html = hinweis("25");
    expect(html).toContain("Vorsteueranteil auf den betrieblichen Teil");
    expect(html).toContain("der private Anteil bleibt aber samt Steuer Aufwand");
    expect(html).toContain("statt als Entnahme zu laufen");
  });
});
