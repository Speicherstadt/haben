import { gzipSync, strToU8, zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { EntpackGrenzeError, gunzipBegrenzt, maxUnpackedBytes, unzipBegrenzt } from "./entpack-grenze.ts";

describe("Grenze beim Entpacken", () => {
  const nullen = new Uint8Array(10_000);

  it("rechnet das Zwanzigfache plus 64 MiB, höchstens 2 GiB", () => {
    expect(maxUnpackedBytes(0)).toBe(64 * 1024 ** 2);
    expect(maxUnpackedBytes(1024 ** 4)).toBe(2 * 1024 ** 3);
  });

  it("entpackt ZIPs unter der Grenze wie bisher", () => {
    const zip = zipSync({ "a.txt": strToU8("hallo"), "b/c.csv": nullen });
    const files = unzipBegrenzt(zip, 20_000);
    expect(Object.keys(files).sort()).toEqual(["a.txt", "b/c.csv"]);
    expect(files["b/c.csv"]!.length).toBe(10_000);
  });

  it("lehnt ein ZIP ab, das über die Grenze anschwillt, auch verteilt auf mehrere Einträge", () => {
    expect(() => unzipBegrenzt(zipSync({ gross: nullen }), 5_000)).toThrow(EntpackGrenzeError);
    expect(() => unzipBegrenzt(zipSync({ a: nullen, b: nullen }), 15_000)).toThrow(EntpackGrenzeError);
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

  it("begrenzt gzip beim Entpacken", () => {
    const gz = gzipSync(nullen);
    expect(gunzipBegrenzt(gz, 20_000).length).toBe(10_000);
    expect(() => gunzipBegrenzt(gz, 5_000)).toThrow(EntpackGrenzeError);
  });
});
