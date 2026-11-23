import { describe, expect, it } from "vitest";
import { compareWisoGoBd } from "./gobd-abgleich.ts";

const bytes = (header: string, rows: string[]) => new TextEncoder().encode([header, ...rows].join("\r\n"));
const buchungen = (rows: string[]) => bytes("Konto;Gegenkonto;Betrag;SollHaben", rows);
const susa = (rows: string[]) => bytes("KontoNummer;AnfangssaldoSoll;AnfangssaldoHaben;BuchungsSummeSoll;BuchungsSummeHaben;SaldoSoll;SaldoHaben", rows);

describe("WISO-GoBD-Abgleich je Konto", () => {
  const goBd = buchungen(["9000;320;61.250,00;H", "320;9000;61.250,00;S", "1200;0;71,40;H", "4920;1200;60,00;S", "1576;1200;11,40;S"]);
  const liste = [
    "0320;61.250,00 €;0,00;0,00;0,00;0,00;61.250,00 €",
    "9000;0,00;61.250,00;0,00;0,00;61.250,00;0,00",
    "1200;0,00;0,00;0,00;71,40;71,40;0,00",
    "4920;0,00;0,00;60,00;0,00;0,00;60,00",
    "1576;0,00;0,00;11,40;0,00;0,00;11,40",
  ];

  it("trennt Saldovortrag, Bruttogeldbewegung und Nettobuchungen, ohne Gegenkonten ein zweites Mal zu summieren", () => {
    expect(compareWisoGoBd(goBd, susa(liste))).toEqual({ accounts: 5, differences: [] });
  });

  it("meldet Startsaldo, Bewegung und Endsaldo getrennt und zählt fehlende Konten mit", () => {
    const result = compareWisoGoBd(goBd, susa([...liste.slice(0, 2), "1200;0,00;0,10;0,00;71,41;71,51;0,00", "4920;0;0;60;0;0;60", "4799;0;0;0;0;0;0"]));
    expect(result.differences).toMatchObject([
      { account: "1200", fields: ["openingCredit", "movementCredit", "balance"] },
      { account: "1576", fields: ["movementDebit", "balance"] },
    ]);
    expect(result.differences[0]!.bookingList).toMatchObject({ movementCredit: 7140, balance: -7140 });
    expect(result.differences[0]!.trialBalance).toMatchObject({ movementCredit: 7141, balance: -7151 });
  });

  it("lehnt doppelte Kontonummern sowie unlesbare Beträge oder Soll-/Haben-Seiten ab", () => {
    expect(() => compareWisoGoBd(goBd, susa([liste[0]!, liste[0]!.replace("0320", "320")]))).toThrow(/320/);
    expect(() => compareWisoGoBd(buchungen(["1200;0;falsch;H"]), susa(liste))).toThrow(/Betrag/);
    expect(() => compareWisoGoBd(buchungen(["1200;0;1,00;X"]), susa(liste))).toThrow(/SollHaben/);
  });
});
