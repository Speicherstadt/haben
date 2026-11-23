import { describe, expect, it } from "vitest";
import { isRecurrence, parseRecurrence, RECURRENCE_KEYS, recurrenceLabel, recurrenceParts } from "./recurrence.ts";

describe("Intervall als Dauer nach ISO 8601 (#1691)", () => {
  it("kennt acht Intervalle, kürzestes zuerst", () => {
    expect(RECURRENCE_KEYS).toEqual(["P1W", "P2W", "P4W", "P1M", "P2M", "P3M", "P6M", "P1Y"]);
    expect(RECURRENCE_KEYS.map(recurrenceLabel)).toEqual([
      "wöchentlich",
      "alle 2 Wochen",
      "alle 4 Wochen",
      "monatlich",
      "alle 2 Monate",
      "vierteljährlich",
      "halbjährlich",
      "jährlich",
    ]);
    expect(recurrenceLabel("P12M")).toBe("–");
    expect(isRecurrence("toString")).toBe(false);
  });

  it("zerlegt in Wochen oder Monate, ein Jahr sind 12 Monate", () => {
    expect(recurrenceParts("P2W")).toEqual({ weeks: 2, months: null });
    expect(recurrenceParts("P6M")).toEqual({ weeks: null, months: 6 });
    expect(recurrenceParts("P1Y")).toEqual({ weeks: null, months: 12 });
  });

  it("liest fremde Schreibweisen", () => {
    expect(parseRecurrence("P0Y0M1W")).toBe("P1W");
    expect(parseRecurrence("P0Y0M2W")).toBe("P2W");
    expect(parseRecurrence("P0Y0M4W")).toBe("P4W");
    expect(parseRecurrence("P14D")).toBe("P2W");
    expect(parseRecurrence("P0Y1M")).toBe("P1M");
    expect(parseRecurrence("P0Y2M")).toBe("P2M");
    expect(parseRecurrence("P12M")).toBe("P1Y");
    expect(parseRecurrence("P1Y0M")).toBe("P1Y");
    expect(parseRecurrence(" P3M ")).toBe("P3M");
  });

  it("lehnt ab, was Haben nicht kennt", () => {
    for (const value of ["P0Y0M3W", "P10D", "P0Y1M1W", "P5M", "P2Y", "P", "", null, undefined, "1W", "p1w"]) expect(parseRecurrence(value)).toBeNull();
  });
});
