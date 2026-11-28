import { describe, expect, it } from "vitest";
import { EBILANZ_KONTEN } from "./ebilanz.ts";
import { postenOf } from "./hgb.ts";
import { euerZuordnung } from "./journal-euer.ts";
import {
  fruehereKontoNamen,
  fruehereKonten,
  heutigesKonto,
  KONTENAENDERUNGEN,
  kontoImBuchungsjahr,
  zeilenFuersJournal,
  zeilenImBuchungsjahr,
} from "./kontenaenderungen.ts";
import { kontoImKontenrahmen } from "./kontenrahmen-wechsel.ts";
import { ledgerManagedAccounts, SACHENTNAHME_KONTEN } from "./manual.ts";
import { heuteBebuchteKonten, reservedAccountNumbers } from "./own-accounts.ts";
import { PAUSCHALE_KONTEN } from "./pauschalen.ts";
import { ACCOUNTS, type Kontenrahmen } from "./posting.ts";

/*
 * Kontenänderungen (#2043): DATEV gibt SKR03 und SKR04 je Jahr heraus. Laut den Programmänderungen zu Kanzlei-Rechnungswesen
 * 13.3 (https://apps.datev.de/myupdates/product-change/details/rel.1037625.productversion_i20241002140543480010133) gibt es
 * die Tagespauschale 4287 bzw. 6347 und die steuerfreien Kleinunternehmererlöse 8192 bzw. 4184 „ab dem Jahr 2025“.
 */

const RAHMEN = ["SKR03", "SKR04"] as const;

describe("Konto nach dem Buchungsjahr", () => {
  it.each([
    ["SKR03", "4287", "4288"],
    ["SKR04", "6347", "6348"],
  ] as const)("%s: Homeoffice-Pauschale bis 2024 auf %s → %s, ab 2025 auf dem Konto der Tagespauschale", (kr, heute, frueher) => {
    expect(PAUSCHALE_KONTEN.homeoffice[kr].konto).toBe(heute);
    expect([2019, 2023, 2024].map((jahr) => kontoImBuchungsjahr(kr, heute, jahr, "pauschale"))).toEqual([frueher, frueher, frueher]);
    expect([2025, 2026, 2027].map((jahr) => kontoImBuchungsjahr(kr, heute, jahr, "pauschale"))).toEqual([heute, heute, heute]);
    // 4288 bzw. 6348 ist auch das Konto des Arbeitszimmers: Nur die Pauschale wandert, ein Beleg auf 4287 bleibt dort
    expect(kontoImBuchungsjahr(kr, heute, 2024, "document")).toBe(heute);
    expect(kontoImBuchungsjahr(kr, heute, 2024)).toBe(heute);
  });

  it.each([
    ["SKR03", "8192", "8195"],
    ["SKR04", "4184", "4185"],
  ] as const)("%s: Kleinunternehmererlöse bis 2024 auf %s → %s, ab 2025 auf dem steuerfreien Erlöskonto", (kr, heute, frueher) => {
    expect(ACCOUNTS[kr].erloeseSonder.kleinunternehmer).toBe(heute);
    for (const herkunft of ["invoice", "kasse", "allocation", undefined]) {
      expect(kontoImBuchungsjahr(kr, heute, 2024, herkunft)).toBe(frueher);
      expect(kontoImBuchungsjahr(kr, heute, 2025, herkunft)).toBe(heute);
    }
  });

  it("eine Korrektur von Haben gilt für jedes Jahr: Sachentnahme 7 % im SKR04 nie mehr auf 4630", () => {
    expect(SACHENTNAHME_KONTEN.SKR04[700]).toBe("4610");
    expect([2020, 2024, 2026].map((jahr) => kontoImBuchungsjahr("SKR04", "4610", jahr))).toEqual(["4610", "4610", "4610"]);
  });

  it("lässt jedes andere Konto, auch ein früheres, wie es ist", () => {
    for (const kr of RAHMEN) {
      expect(kontoImBuchungsjahr(kr, ACCOUNTS[kr].bank, 2020)).toBe(ACCOUNTS[kr].bank);
      expect(kontoImBuchungsjahr(kr, ACCOUNTS[kr].erloese[1900], 2020)).toBe(ACCOUNTS[kr].erloese[1900]);
      for (const f of fruehereKonten(kr)) {
        expect(kontoImBuchungsjahr(kr, f.konto, 2020, f.aenderung.nurHerkunft)).toBe(f.konto);
        expect(kontoImBuchungsjahr(kr, f.konto, 2026, f.aenderung.nurHerkunft)).toBe(f.konto);
      }
    }
    // Die Nummern gelten je Kontenrahmen: 8192 bedeutet im SKR04 nichts
    expect(kontoImBuchungsjahr("SKR04", "8192", 2024)).toBe("8192");
  });

  it("überträgt die Zeilen einer Buchung, Beträge und Steuerschlüssel bleiben", () => {
    const zeilen = [
      { account: "1000", debit: 10_000, credit: 0, taxCode: null },
      { account: "8192", debit: 0, credit: 10_000, taxCode: "KU" },
    ];
    expect(zeilenImBuchungsjahr("SKR03", 2024, "kasse", zeilen)).toEqual([
      { account: "1000", debit: 10_000, credit: 0, taxCode: null },
      { account: "8195", debit: 0, credit: 10_000, taxCode: "KU" },
    ]);
    expect(zeilenImBuchungsjahr("SKR03", 2025, "kasse", zeilen)).toEqual(zeilen);
  });
});

describe("Zeilen, wie sie ins Journal kommen", () => {
  const konten = (kr: Kontenrahmen, buchung: { jahr: number; herkunft: string; ursprungsjahr?: number | null }, ...accounts: string[]) =>
    zeilenFuersJournal(kr, { ...buchung, zeilen: accounts.map((account) => ({ account })) }).map((z) => z.account);

  it("eine neue Buchung steht auf den Konten ihres Buchungsjahres", () => {
    expect(konten("SKR03", { jahr: 2024, herkunft: "kasse" }, "1000", "8192")).toEqual(["1000", "8195"]);
    expect(konten("SKR03", { jahr: 2025, herkunft: "kasse" }, "1000", "8192")).toEqual(["1000", "8192"]);
    expect(konten("SKR04", { jahr: 2024, herkunft: "pauschale" }, "6347", "2180")).toEqual(["6348", "2180"]);
    // Ein früheres Konto, das eine neue Buchung nennt, bleibt
    expect(konten("SKR03", { jahr: 2026, herkunft: "pauschale" }, "4288", "1890")).toEqual(["4288", "1890"]);
  });

  it("freie Buchung, Datenimport und Eröffnung behalten die angegebenen Konten", () => {
    for (const herkunft of ["manuell", "import", "eroeffnung"]) {
      expect(konten("SKR03", { jahr: 2024, herkunft }, "1000", "8192")).toEqual(["1000", "8192"]);
      expect(konten("SKR03", { jahr: 2026, herkunft, ursprungsjahr: 2024 }, "8195", "1000")).toEqual(["8195", "1000"]);
    }
  });

  it("eine Gegenbuchung im Jahr ihrer Ursprungsbuchung spiegelt deren Konten", () => {
    // Bestand: 2024 nachgetragen, als Haben jedes Jahr nach der neuesten Ausgabe buchte
    expect(konten("SKR03", { jahr: 2024, herkunft: "pauschale", ursprungsjahr: 2024 }, "1890", "4287")).toEqual(["1890", "4287"]);
    // Bestand: 2026 auf dem früheren Konto, von vor der Umstellung
    expect(konten("SKR03", { jahr: 2026, herkunft: "kasse", ursprungsjahr: 2026 }, "8195", "1000")).toEqual(["8195", "1000"]);
    expect(konten("SKR04", { jahr: 2025, herkunft: "asset", ursprungsjahr: 2025 }, "4630", "2100")).toEqual(["4630", "2100"]);
  });

  // DATEV hat 8195 bzw. 4185 im Jahr 2026 gelöscht (Kontenerläuterung Dok.-Nr. 5360713): Das Storno einer Bareinnahme von
  // 2024, gebucht 2026, darf dort nicht landen
  it("eine Gegenbuchung in einem anderen Jahr steht auf den Konten dieses Jahres", () => {
    expect(konten("SKR03", { jahr: 2026, herkunft: "kasse", ursprungsjahr: 2024 }, "8195", "1000")).toEqual(["8192", "1000"]);
    expect(konten("SKR04", { jahr: 2026, herkunft: "allocation", ursprungsjahr: 2024 }, "4185", "1800")).toEqual(["4184", "1800"]);
    expect(konten("SKR03", { jahr: 2025, herkunft: "pauschale", ursprungsjahr: 2024 }, "1890", "4288")).toEqual(["1890", "4287"]);
    // Das Arbeitszimmer selbst (kein Storno einer Pauschale) bleibt
    expect(konten("SKR03", { jahr: 2025, herkunft: "document", ursprungsjahr: 2024 }, "1600", "4288")).toEqual(["1600", "4288"]);
    // Eine berichtigte Zuordnung von Haben wird in keinem Jahr neu bebucht
    expect(konten("SKR04", { jahr: 2026, herkunft: "asset", ursprungsjahr: 2025 }, "4630", "2100")).toEqual(["4610", "2100"]);
    // Zurück in ein Jahr vor dem heutigen Konto
    expect(konten("SKR03", { jahr: 2024, herkunft: "kasse", ursprungsjahr: 2025 }, "8192", "1000")).toEqual(["8195", "1000"]);
  });
});

describe("frühere Konten in den Auswertungen", () => {
  it("heutigesKonto: ein früheres Konto als das, das Haben heute für denselben Zweck bebucht", () => {
    expect(heutigesKonto("SKR03", "8195")).toBe("8192");
    expect(heutigesKonto("SKR04", "4185")).toBe("4184");
    expect(heutigesKonto("SKR04", "4630")).toBe("4610");
    // Im SKR03 ist 4630 das Konto der Geschenke, kein früheres Konto
    expect(heutigesKonto("SKR03", "4630")).toBe("4630");
    // Das Arbeitszimmer: nur eine Pauschale dort ist die Tagespauschale
    expect(heutigesKonto("SKR03", "4288", "pauschale")).toBe("4287");
    expect(heutigesKonto("SKR04", "6348", "pauschale")).toBe("6347");
    expect(heutigesKonto("SKR03", "4288")).toBe("4288");
    expect(heutigesKonto("SKR03", "4288", "manuell")).toBe("4288");
    expect(heutigesKonto("SKR03", "1200")).toBe("1200");
  });

  it("die Liste nennt je früherem Konto das heutige, den Namen und die Quelle", () => {
    const zeile = (kr: Kontenrahmen) => fruehereKonten(kr).map((f) => [f.konto, f.heute, f.aenderung.bisJahr ?? null]);
    expect(zeile("SKR03")).toEqual([
      ["4288", "4287", 2024],
      ["8195", "8192", 2024],
    ]);
    expect(zeile("SKR04")).toEqual([
      ["6348", "6347", 2024],
      ["4185", "4184", 2024],
      ["4630", "4610", null],
    ]);
    expect(fruehereKontoNamen("SKR03")).toEqual({
      "4288": "Aufwendungen für ein häusliches Arbeitszimmer (abziehbarer Anteil)",
      "8195": "Erlöse als Kleinunternehmer § 19 UStG",
    });
    expect(fruehereKontoNamen("SKR04")["4630"]).toBe("Verwendung von Gegenständen für Zwecke außerhalb des Unternehmens 7 % USt");
    for (const a of KONTENAENDERUNGEN) expect(a.quelle).toMatch(/#\d+/);
  });

  // Jede Zeile der Liste, auch eine künftige: Was für das heutige Konto gilt, gilt für das frühere
  describe.each(RAHMEN.flatMap((kr) => fruehereKonten(kr).map((f) => [kr, f.konto, f.heute, f] as const)))("%s %s (heute %s)", (kr, konto, heute, f) => {
    const herkunft = f.aenderung.nurHerkunft;

    it("das heutige Konto der Liste ist das, auf das Haben bucht", () => {
      expect(heuteBebuchteKonten(kr).has(heute)).toBe(true);
    });

    // DATEV kann eine reservierte Nummer nach zwei Jahren neu belegen (Dok.-Nr. 1029365). Nimmt Haben sie dann für etwas
    // anderes, läse jede Auswertung die alten Buchungen falsch: Dann braucht die Zuordnung das Buchungsjahr
    // (docs/adr/kontenrahmen-ausgaben.md).
    it("die frühere Nummer ist heute nicht für etwas anderes belegt", () => {
      expect(heuteBebuchteKonten(kr).has(konto)).toBe(false);
      expect(fruehereKonten(kr).filter((anderes) => anderes.konto === konto)).toHaveLength(1);
    });

    it("bleibt für eigene Konten gesperrt und behält seinen Namen", () => {
      expect(reservedAccountNumbers(kr).has(konto)).toBe(true);
      expect(fruehereKontoNamen(kr)[konto]).toBeTruthy();
    });

    it("zählt in der EÜR wie das heutige Konto", () => {
      const zeile = euerZuordnung(kr, heute, herkunft ?? "sonst");
      expect(zeile).not.toBeNull();
      expect(euerZuordnung(kr, konto, herkunft ?? "sonst")).toBe(zeile);
    });

    // Nicht, wo das frühere Konto bei DATEV eine eigene Bedeutung hat (Arbeitszimmer): Dort gilt sie, außer für die Pauschale
    if (!herkunft) {
      it("steht in Bilanz, GuV und E-Bilanz und im Nebenbuch wie das heutige Konto", () => {
        expect(postenOf(kr, konto)).toBe(postenOf(kr, heute));
        expect(EBILANZ_KONTEN[kr][konto]).toEqual(EBILANZ_KONTEN[kr][heute]);
        expect(ledgerManagedAccounts(kr).get(konto)).toBe(ledgerManagedAccounts(kr).get(heute));
      });
    }

    it("wandert beim Wechsel des Kontenrahmens mit", () => {
      const nach = kr === "SKR03" ? "SKR04" : "SKR03";
      // Ein Konto mit eigener Bedeutung (Arbeitszimmer) auf dasselbe Konto dort, jedes andere auf das heutige seines Zwecks
      const ziel = herkunft ? f.aenderung[nach].frueher?.konto : f.aenderung[nach].heute;
      expect(kontoImKontenrahmen(kr, nach, konto)).toBe(ziel);
    });
  });

  it("Arbeitszimmer ohne Pauschale zählt nicht als Tagespauschale", () => {
    expect(euerZuordnung("SKR03", "4288", "sonst")).not.toBe("pauschale:homeoffice");
    expect(euerZuordnung("SKR03", "4288", "pauschale")).toBe("pauschale:homeoffice");
  });
});
