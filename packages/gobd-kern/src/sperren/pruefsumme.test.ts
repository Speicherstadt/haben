import { describe, expect, it } from "vitest";
import type { Sollbestand } from "./bestand.ts";
import { pruefsumme } from "./pruefsumme.ts";

const bestand: Sollbestand = {
  triggers: [
    { table: "public.belege", name: "belege_a", enabled: "O", definition: "CREATE TRIGGER belege_a …", function: "public.probe_a()" },
    { table: "public.belege", name: "belege_b", enabled: "O", definition: "CREATE TRIGGER belege_b …", function: "public.probe_b()" },
  ],
  functions: [
    { name: "public.probe_a()", sourceHash: "s", definitionHash: "d", config: ["search_path=pg_catalog"], language: "plpgsql", securityDefiner: false },
  ],
  sealedTables: ["public.belege"],
  defaults: [{ table: "public.belege", column: "betrag_cent", expression: "0" }],
  builtins: { major: 18, functions: [{ name: "pg_catalog.age(timestamp without time zone)", hash: "a" }] },
  extensions: { functions: [], operators: [], casts: [] },
};

describe("Prüfsumme eines Bestands", () => {
  it("ist ein SHA-256 in Hex und hängt nicht von Reihenfolge oder Schlüsselfolge ab", () => {
    const umgestellt: Sollbestand = {
      extensions: bestand.extensions,
      defaults: bestand.defaults,
      builtins: bestand.builtins,
      sealedTables: bestand.sealedTables,
      functions: bestand.functions.map(({ securityDefiner, language, config, definitionHash, sourceHash, name }) => ({
        securityDefiner,
        language,
        config,
        definitionHash,
        sourceHash,
        name,
      })),
      triggers: [...bestand.triggers].reverse(),
    };
    expect(pruefsumme(bestand)).toMatch(/^[0-9a-f]{64}$/);
    expect(pruefsumme(umgestellt)).toBe(pruefsumme(bestand));
  });

  // Die eingebauten Funktionen unterscheiden sich zwischen Versionen von PostgreSQL
  it("lässt die eingebauten Funktionen aus", () => {
    expect(pruefsumme({ ...bestand, builtins: { major: 17, functions: [] } })).toBe(pruefsumme(bestand));
  });

  it("ändert sich mit einem abgeschalteten Trigger, einer geänderten Funktion oder einem Standardwert", () => {
    const [erster, zweiter] = bestand.triggers;
    expect(pruefsumme({ ...bestand, triggers: [{ ...erster!, enabled: "D" }, zweiter!] })).not.toBe(pruefsumme(bestand));
    expect(pruefsumme({ ...bestand, functions: [{ ...bestand.functions[0]!, sourceHash: "x" }] })).not.toBe(pruefsumme(bestand));
    expect(pruefsumme({ ...bestand, defaults: [] })).not.toBe(pruefsumme(bestand));
  });
});
