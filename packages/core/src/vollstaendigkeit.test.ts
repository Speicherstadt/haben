import { describe, expect, it } from "vitest";
import { kontenNurBis, stichtag, unvollstaendig, unvollstaendigText, type OffeneVorgaenge } from "./vollstaendigkeit.ts";

/* Hinweis auf Unvollständiges in der BWA (#1635); Ostern 2026 ist am 5. April */

const april = { von: "2026-04-01", bis: "2026-04-30" };
const maerz = { von: "2026-03-01", bis: "2026-03-31" };
const nichts: OffeneVorgaenge = { ausgaben: 0, eingaenge: 0, belege: 0, rechnungsentwuerfe: 0 };

describe("stichtag", () => {
  it("ist das Ende eines vergangenen Zeitraums, an einem Bankarbeitstag", () => {
    expect(stichtag(maerz, "2026-11-28")).toBe("2026-03-31");
  });

  it("geht vom Wochenende am Ende des Zeitraums auf den Freitag zurück", () => {
    // 31.10.2026 ist ein Samstag
    expect(stichtag({ von: "2026-10-01", bis: "2026-10-31" }, "2026-11-28")).toBe("2026-10-30");
  });

  it("ist im laufenden Zeitraum gestern, über Ostermontag, Wochenende und Karfreitag zurück auf Gründonnerstag", () => {
    expect(stichtag(april, "2026-04-15")).toBe("2026-04-14");
    expect(stichtag(april, "2026-04-07")).toBe("2026-04-02");
  });

  it("ist null, solange noch kein Bankarbeitstag des Zeitraums vorbei ist", () => {
    expect(stichtag(april, "2026-04-01")).toBeNull();
    expect(stichtag(april, "2026-04-02")).toBe("2026-04-01");
    // Neujahr ist kein Bankarbeitstag
    expect(stichtag({ von: "2026-01-01", bis: "2026-01-31" }, "2026-01-02")).toBeNull();
    expect(stichtag({ von: "2027-01-01", bis: "2027-12-31" }, "2026-11-28")).toBeNull();
  });
});

describe("kontenNurBis", () => {
  const konto = (bis: string | null) => ({ id: "k", name: "Girokonto", bis });

  it("meldet ein Konto, dessen Umsätze im Zeitraum vor dem Stichtag aufhören", () => {
    expect(kontenNurBis([konto("2026-03-20")], maerz, "2026-11-28")).toEqual([{ id: "k", name: "Girokonto", bis: "2026-03-20" }]);
    expect(kontenNurBis([konto("2026-03-01")], maerz, "2026-11-28")).toHaveLength(1);
  });

  it("schweigt bis zum Stichtag und ohne Import", () => {
    expect(kontenNurBis([konto("2026-03-31")], maerz, "2026-11-28")).toEqual([]);
    expect(kontenNurBis([konto("2026-05-10")], maerz, "2026-11-28")).toEqual([]);
    expect(kontenNurBis([konto(null)], maerz, "2026-11-28")).toEqual([]);
  });

  it("meldet auch ein Konto, dessen Umsätze vor dem Zeitraum aufhören", () => {
    expect(kontenNurBis([konto("2026-02-27")], maerz, "2026-11-28")).toEqual([{ id: "k", name: "Girokonto", bis: "2026-02-27" }]);
    expect(kontenNurBis([konto("2025-10-20")], maerz, "2026-11-28")).toHaveLength(1);
  });

  it("verlangt im laufenden Monat nur bis zum letzten Bankarbeitstag vor heute", () => {
    // Montag, 30.11.2026: Der Auszug bis Freitag reicht
    const november = { von: "2026-11-01", bis: "2026-11-30" };
    expect(kontenNurBis([konto("2026-11-27")], november, "2026-11-30")).toEqual([]);
    expect(kontenNurBis([konto("2026-11-26")], november, "2026-11-30")).toHaveLength(1);
    // Nach Ostern reicht der Gründonnerstag
    expect(kontenNurBis([konto("2026-04-02")], april, "2026-04-07")).toEqual([]);
  });
});

describe("unvollstaendig", () => {
  const offen: OffeneVorgaenge = { ausgaben: 2, eingaenge: 1, belege: 3, rechnungsentwuerfe: 4 };
  const konten = [{ id: "k", name: "Visa", bis: "2026-03-20" }];
  const kurz = (form: "form43" | "form01") => unvollstaendig(offen, konten, form).map((h) => [h.art, h.ton, h.anzahl, h.link]);

  it("Form 43 nach Zahlung: offene Umsätze, Belege und Konten warnen, Entwürfe fehlen", () => {
    expect(kurz("form43")).toEqual([
      ["ausgaben", "warn", 2, "/bank"],
      ["eingaenge", "warn", 1, "/bank"],
      ["belege", "warn", 3, "/belege"],
      ["konto", "warn", 1, "/bank"],
    ]);
  });

  it("Form 01 periodengerecht: Eingänge und Entwürfe nur als Hinweis", () => {
    expect(kurz("form01")).toEqual([
      ["ausgaben", "warn", 2, "/bank"],
      ["eingaenge", "info", 1, "/bank"],
      ["belege", "warn", 3, "/belege"],
      ["rechnungsentwuerfe", "info", 4, "/rechnungen"],
      ["konto", "warn", 1, "/bank"],
    ]);
  });

  it("ohne Offenes keine Hinweise", () => {
    expect(unvollstaendig(nichts, [], "form43")).toEqual([]);
    expect(unvollstaendig(nichts, [], "form01")).toEqual([]);
  });
});

describe("unvollstaendigText", () => {
  const texte = (offen: OffeneVorgaenge, form: "form43" | "form01") => unvollstaendig(offen, [], form).map((h) => unvollstaendigText(h, maerz));

  it("Einzahl und Mehrzahl", () => {
    expect(texte({ ausgaben: 1, eingaenge: 1, belege: 1, rechnungsentwuerfe: 1 }, "form01")).toEqual([
      "1 Ausgabe im Zeitraum ohne Beleg oder Zuordnung; sie fehlt in den Kosten.",
      "1 Zahlungseingang im Zeitraum noch nicht zugeordnet; ohne Rechnung fehlt der Erlös.",
      "1 Beleg im Zeitraum oder ohne Datum noch nicht gebucht.",
      "1 Rechnungsentwurf mit Datum im Zeitraum; Erlöse zählen erst festgeschrieben.",
    ]);
    expect(texte({ ausgaben: 2, eingaenge: 3, belege: 4, rechnungsentwuerfe: 5 }, "form43")).toEqual([
      "2 Ausgaben im Zeitraum ohne Beleg oder Zuordnung; sie fehlen in den Kosten.",
      "3 Zahlungseingänge im Zeitraum noch nicht zugeordnet; sie fehlen in den Erlösen.",
      "4 Belege im Zeitraum oder ohne Datum noch nicht gebucht.",
    ]);
    expect(texte({ ...nichts, eingaenge: 1 }, "form43")).toEqual(["1 Zahlungseingang im Zeitraum noch nicht zugeordnet; er fehlt in den Erlösen."]);
  });

  const bis = (datum: string, zeitraum: { von: string; bis: string }) =>
    unvollstaendigText(unvollstaendig(nichts, [{ id: "k", name: "Visa", bis: datum }], "form43")[0]!, zeitraum);

  it("nennt Konto und letzten Tag, ohne Jahr, wenn Zeitraum und Tag im selben Jahr liegen", () => {
    expect(bis("2026-03-05", maerz)).toBe("Umsätze von Konto „Visa“ nur bis 05.03.");
    expect(bis("2026-02-27", maerz)).toBe("Umsätze von Konto „Visa“ nur bis 27.02.");
  });

  it("nennt das Jahr, sobald der Tag in einem anderen Jahr liegt oder der Zeitraum über den Jahreswechsel geht", () => {
    expect(bis("2025-10-20", maerz)).toBe("Umsätze von Konto „Visa“ nur bis 20.10.2025");
    const winter = { von: "2025-12-01", bis: "2026-01-31" };
    expect(bis("2025-12-19", winter)).toBe("Umsätze von Konto „Visa“ nur bis 19.12.2025");
    expect(bis("2026-01-09", winter)).toBe("Umsätze von Konto „Visa“ nur bis 09.01.2026");
  });
});
