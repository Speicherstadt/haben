import { describe, expect, it } from "vitest";
import { kindPatch } from "./AssetForm.tsx";
import { methodChoices } from "./AssetFormTeile.tsx";

describe("Wahl der Art im Anlageformular (#312)", () => {
  it("Fahrzeug schlägt sechs Jahre vor, Sonstige Transportmittel lässt sie nicht stehen", () => {
    expect(kindPatch("kfz")).toMatchObject({ kind: "kfz", method: "linear", years: "6" });
    expect(kindPatch("transport")).toEqual({ kind: "transport", method: "linear", years: "" });
  });

  it("Elektro-AfA (§ 7 Abs. 2a EStG) nur bei Fahrzeugen, nicht bei sonstigen Transportmitteln", () => {
    expect(methodChoices("kfz", false, true)).toContain("elektro");
    expect(methodChoices("transport", false, true)).not.toContain("elektro");
    expect(methodChoices("kfz", false, false)).not.toContain("elektro");
  });
});
