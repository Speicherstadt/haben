import { describe, expect, it } from "vitest";
import { isKapitalgesellschaft, ownerLabels, privatZulaessig, RECHTSFORM_KEYS } from "./rechtsform.ts";

describe("Rechtsform", () => {
  it("kennt einen Privatanteil nur im Einzelunternehmen (#1975)", () => {
    expect(RECHTSFORM_KEYS.filter(privatZulaessig)).toEqual(["einzelunternehmen"]);
  });

  it("GmbH und UG sind Kapitalgesellschaften, das Einzelunternehmen nicht", () => {
    expect(RECHTSFORM_KEYS.filter(isKapitalgesellschaft)).toEqual(["gmbh", "ug"]);
  });

  it("nennt Geld vom und an den Inhaber je nach Rechtsform", () => {
    expect(ownerLabels("einzelunternehmen").bank).toBe("Privat (Entnahme oder Einlage)");
    expect(ownerLabels("gmbh").bank).toBe("Gesellschafter (Verrechnungskonto)");
    expect(ownerLabels("ug").cashOut).toBe("An den Gesellschafter");
  });
});
