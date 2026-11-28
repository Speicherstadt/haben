import { gzipSync, strToU8, zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { EntpackGrenzeError, gunzipBegrenzt, maxUnpackedBytes, unzipBegrenzt } from "./entpack-grenze.ts";

const budget = (left: number) => ({ left });

describe("Grenze beim Entpacken", () => {
  const nullen = new Uint8Array(10_000);

  it("rechnet das Zwanzigfache plus 64 MiB, höchstens 2 GiB", () => {
    expect(maxUnpackedBytes(0)).toBe(64 * 1024 ** 2);
    expect(maxUnpackedBytes(1024 ** 2)).toBe(84 * 1024 ** 2);
    expect(maxUnpackedBytes(100 * 1024 ** 2)).toBe(2 * 1024 ** 3);
    expect(maxUnpackedBytes(1024 ** 4)).toBe(2 * 1024 ** 3);
  });

  it("entpackt ZIPs unter der Grenze wie bisher", () => {
    const zip = zipSync({ "a.txt": strToU8("hallo"), "b/c.csv": nullen });
    const files = unzipBegrenzt(zip, budget(20_000));
    expect(Object.keys(files).sort()).toEqual(["a.txt", "b/c.csv"]);
    expect(files["b/c.csv"]!.length).toBe(10_000);
  });

  it("lehnt ein ZIP ab, das über die Grenze anschwillt, auch verteilt auf mehrere Einträge", () => {
    expect(() => unzipBegrenzt(zipSync({ gross: nullen }), budget(5_000))).toThrow(EntpackGrenzeError);
    expect(() => unzipBegrenzt(zipSync({ a: nullen, b: nullen }), budget(15_000))).toThrow(EntpackGrenzeError);
  });

  it("meldet ein kaputtes ZIP weiter mit dem Fehler von fflate, nicht als Grenze", () => {
    let fehler: unknown;
    try {
      unzipBegrenzt(strToU8("kein zip"));
    } catch (error) {
      fehler = error;
    }
    expect(fehler).toBeInstanceOf(Error);
    expect(fehler).not.toBeInstanceOf(EntpackGrenzeError);
  });

  it("verschachtelte Archive teilen sich ein Budget: das innere bekommt keine eigene, größere Grenze", () => {
    const inner = zipSync({ belege: nullen });
    const outer = zipSync({ "Belege.zip": inner, "a.csv": nullen });
    const shared = budget(15_000);
    const files = unzipBegrenzt(outer, shared);
    // Das innere ZIP allein passte in eine eigene Grenze, zusammen mit dem äußeren ist das Budget aufgebraucht
    expect(() => unzipBegrenzt(files["Belege.zip"]!, shared)).toThrow(EntpackGrenzeError);
    expect(unzipBegrenzt(files["Belege.zip"]!)["belege"]!.length).toBe(10_000);
  });

  it("begrenzt gzip beim Entpacken", () => {
    const gz = gzipSync(nullen);
    expect(gunzipBegrenzt(gz, budget(20_000)).length).toBe(10_000);
    expect(() => gunzipBegrenzt(gz, budget(5_000))).toThrow(EntpackGrenzeError);
  });
});
