import { describe, expect, it } from "vitest";
import { antragJahre, type Basis, type Data, naechstesQuartal, prepaymentLetter } from "./-finanzamt-daten.ts";

/* #1329: Der Antrag geht als ELSTER-Datenart AnpassungVorauszahlung mit Quartal und Jahr; der Brief wird zur Begründung. */
describe("Antrag auf Anpassung der Vorauszahlungen", () => {
  it("schlägt das Quartal des nächsten Fälligkeitstermins vor (10.3., 10.6., 10.9., 10.12.)", () => {
    expect(naechstesQuartal("2026-01-02")).toBe("Q1");
    expect(naechstesQuartal("2026-03-10")).toBe("Q1");
    expect(naechstesQuartal("2026-03-11")).toBe("Q2");
    expect(naechstesQuartal("2026-06-10")).toBe("Q2");
    expect(naechstesQuartal("2026-09-10")).toBe("Q3");
    expect(naechstesQuartal("2026-11-27")).toBe("Q4");
    expect(naechstesQuartal("2026-12-31")).toBe("Q4");
  });

  it("bietet die Jahre an, die ELSTER annimmt: eins voraus, drei zurück", () => {
    expect(antragJahre("2026-11-27")).toEqual([2027, 2026, 2025, 2024, 2023]);
  });

  const data = { company: { name: "Mustermann IT" } } as Data;
  const basis = {
    year: 2026,
    until: "2026-11-27",
    profitSoFar: 1_000_000,
    profitForecast: 1_100_000,
    profitLastYear: 2_000_000,
    einkunftsart: "selbstaendig",
    prognose: { einkommensteuer: 50_000, soli: 0, kirchensteuer: 0 },
  } as unknown as Basis;
  const ersterAbsatz = (text: string) => text.split("\n\n")[1];

  it("nennt Quartal, Fälligkeit und Jahr aus der Auswahl", () => {
    const text = prepaymentLetter(data, basis, { quartal: "Q4", jahr: 2026 }, null, 250_000, "", false);
    expect(ersterAbsatz(text)).toBe(
      "hiermit beantrage ich, die Vorauszahlungen zur Einkommensteuer für 2026 ab dem 4. Quartal (fällig 10.12.2026) auf 2.500,00\u00a0€ je Quartal herabzusetzen (§ 37 Abs. 3 EStG).",
    );
  });

  it("nachträgliche Vorauszahlung: ohne Betrag je Quartal", () => {
    const text = prepaymentLetter(data, basis, { quartal: "nVz", jahr: 2025 }, null, 250_000, "", false);
    expect(ersterAbsatz(text)).toBe("hiermit beantrage ich, die nachträgliche Vorauszahlung zur Einkommensteuer für 2025 herabzusetzen (§ 37 Abs. 3 EStG).");
  });
});
