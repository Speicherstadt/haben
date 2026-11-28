import { describe, expect, it } from "vitest";
import { auslesungAktiv, type QueueOverview } from "./-auslesung-aktiv.ts";

const leer: QueueOverview = { waiting: 0, running: 0, failed: 0, paused: false };
const zeile = (extractionStatus: string, status = "neu") => ({ status, extractionStatus });

describe("auslesungAktiv: Wann sich die Belegliste auffrischt (#2085)", () => {
  it("frischt auf, solange die Warteschlange läuft oder ungehalten wartet", () => {
    expect(auslesungAktiv({ ...leer, running: 1 }, [])).toBe(true);
    expect(auslesungAktiv({ ...leer, waiting: 2 }, [])).toBe(true);
    expect(auslesungAktiv({ ...leer, waiting: 2, paused: true }, [])).toBe(false);
    expect(auslesungAktiv({ ...leer, failed: 1 }, [zeile("fertig"), zeile("fehler")])).toBe(false);
  });

  it("frischt weiter auf, wenn die Liste einen Beleg noch als „Wird ausgelesen“ zeigt, die Übersicht aber nicht mehr", () => {
    // Die Auslesung endete zwischen den Abfragen der Belege und der Warteschlange im Loader
    expect(auslesungAktiv({ ...leer, failed: 1 }, [zeile("fertig"), zeile("fehler"), zeile("laeuft")])).toBe(true);
  });

  it("frischt weiter auf, wenn die Liste einen Beleg noch als wartend zeigt und die Auslesung nicht angehalten ist", () => {
    expect(auslesungAktiv(leer, [zeile("wartet")])).toBe(true);
    expect(auslesungAktiv({ ...leer, paused: true }, [zeile("wartet")])).toBe(false);
  });

  it("frischt nicht auf für gebuchte Belege, die beim Buchen noch warteten oder ausgelesen wurden", () => {
    // Die Warteschlange lässt gebuchte Belege aus; ihr Stand der Auslesung bleibt so stehen
    expect(auslesungAktiv(leer, [zeile("wartet", "gebucht"), zeile("laeuft", "gebucht")])).toBe(false);
  });
});
