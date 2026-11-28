import { describe, expect, it } from "vitest";
import { recipientLines } from "./pdf.ts";
import { sampleBuyer, sampleDocument } from "./samples.ts";
import type { Buyer } from "./types.ts";
import { buildEInvoice } from "./xml.ts";

/*
 * Adresszusatz des Käufers (#914): Abteilung, c/o, Gebäude oder Stockwerk. Im PDF eine eigene Zeile im Empfängerblock
 * vor der Straße, in der E-Rechnung BT-51 „Buyer address line 2“ (EN 16931-1): CII `LineTwo`, UBL
 * `AdditionalStreetName`, jeweils direkt hinter Zeile 1. Ohne Zusatz bleibt alles wie bisher. Namen erfunden.
 */
const mit: Buyer = { ...sampleBuyer, adresszusatz: "Abteilung Einkauf" };

describe("Adresszusatz", () => {
  it("steht im Empfängerblock vor der Straße, ohne Zusatz wie bisher", () => {
    expect(recipientLines(mit)).toEqual([mit.name, "Abteilung Einkauf", mit.strasse, `${mit.plz} ${mit.ort}`]);
    expect(recipientLines({ ...mit, ansprechpartner: { name: "Mara Beispiel", email: "", telefon: "", funktion: "" } })).toEqual([
      mit.name,
      "z. Hd. Mara Beispiel",
      "Abteilung Einkauf",
      mit.strasse,
      `${mit.plz} ${mit.ort}`,
    ]);
    expect(recipientLines(sampleBuyer)).toEqual([sampleBuyer.name, sampleBuyer.strasse, `${sampleBuyer.plz} ${sampleBuyer.ort}`]);
  });

  it("ist in CII und UBL BT-51, direkt hinter Zeile 1", async () => {
    const cii = (await buildEInvoice(sampleDocument({ buyer: mit, format: "xrechnung-cii" }))).xml;
    expect(cii).toMatch(/<ram:BuyerTradeParty>[\s\S]*<ram:LineOne>Hafenweg 3<\/ram:LineOne>\s*<ram:LineTwo>Abteilung Einkauf<\/ram:LineTwo>/);
    const ubl = (await buildEInvoice(sampleDocument({ buyer: mit, format: "xrechnung-ubl" }))).xml;
    expect(ubl).toMatch(
      /<cac:AccountingCustomerParty>[\s\S]*<cbc:StreetName>Hafenweg 3<\/cbc:StreetName>\s*<cbc:AdditionalStreetName>Abteilung Einkauf<\/cbc:AdditionalStreetName>/,
    );
    const ohne = (await buildEInvoice(sampleDocument({ format: "xrechnung-ubl" }))).xml;
    expect(ohne).not.toContain("AdditionalStreetName");
  });
});
