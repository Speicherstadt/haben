import { readFileSync } from "node:fs";
import { unzipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { fakeBrowser, runInConsole } from "./test-browser-skript.ts";

const script = readFileSync(new URL("../../../../public/lexware-sicherung.js", import.meta.url), "utf8");
const pdf = new TextEncoder().encode("%PDF-1.4\n%%EOF\n");

const item = (entityId: string, entitySubType: string, billingStatus = "open") => ({ entityId, entitySubType, entityType: "salesvoucher", billingStatus });
type Item = ReturnType<typeof item>;

async function backup(active: Item[], archived: Item[], largePdfId?: string) {
  const browser = fakeBrowser();
  const detailIds: string[] = [];
  const fetch = async (path: string) => {
    const url = new URL(path, "https://app.lexware.de");
    const id = url.pathname.split("/").at(-1)!;
    if (url.pathname === "/desmos-rest/contacts/v1/search") return Response.json({ elements: [] });
    if (url.pathname === "/grld-rest/voucherservice/1/v200/vouchers") {
      const list = url.searchParams.get("archived") === "true" ? archived : active;
      const first = Number(url.searchParams.get("firstRow"));
      return Response.json({ numFound: list.length, content: list.slice(first, first + 500) });
    }
    if (url.pathname.startsWith("/grld-rest/voucherservice/1/v100/voucherDetails/")) {
      detailIds.push(id);
      return Response.json({});
    }
    if (url.pathname.startsWith("/papyrus-rest/vouchers/sales-voucher/")) return Response.json({});
    if (url.pathname.startsWith("/salesdocgen/")) {
      // Ein großer Anhang löst die echte Teilgrenze aus, ohne Konstanten im Skript zu ersetzen.
      const bytes = id === largePdfId ? new Uint8Array(50 * 1024 * 1024) : pdf;
      if (id === largePdfId) bytes.set(pdf);
      return new Response(bytes, { headers: { "content-type": "application/pdf" } });
    }
    if (url.pathname.startsWith("/fis/finance-rest/financialtransactionservice/")) return Response.json({ content: [], totalPages: 1 });
    throw new Error(`Unerwarteter Pfad: ${url.pathname}`);
  };
  const location = { hostname: "app.lexware.de", origin: "https://app.lexware.de" };
  await runInConsole(`return ${script.slice(script.indexOf("(async () =>"))}`, { ...browser.globals, location, fetch, console: { log: () => {} } });
  const parts = (await browser.downloads()).map(({ bytes }) => {
    const entries = unzipSync(bytes, { filter: ({ name }) => name === "manifest.json" || name.startsWith("belege/") });
    return {
      manifest: JSON.parse(new TextDecoder().decode(entries["manifest.json"])),
      vouchers: Object.keys(entries).filter((name) => name.startsWith("belege/")),
    };
  });
  return { detailIds, parts };
}

describe("Lexware-Sicherung: bewusst weggelassene Vorgänge", () => {
  it("zählt jeden Vorgang einmal und schreibt dieselben Gesamtzahlen in jeden Teil", async () => {
    const firstInvoice = item("rechnung-1", "Invoice");
    const quote = item("angebot", "Quotation");
    const order = item("auftrag", "OrderConfirmation");
    const delivery = item("lieferschein", "DeliveryNote");
    const other = item("unbekannt", "UnbekannterVorgang");
    const active = [
      firstInvoice,
      quote,
      order,
      other,
      item("entwurf-angebot", "Quotation", "draft"),
      ...Array.from({ length: 494 }, (_, index) => item(`angebot-${index}`, "Quotation")),
      item("entwurf-rechnung", "Invoice", "draft"),
      delivery,
    ];
    const archived = [quote, order, delivery, firstInvoice, item("rechnung-2", "Invoice")];

    const { detailIds, parts } = await backup(active, archived, "rechnung-2");

    expect(detailIds).toEqual(["rechnung-1", "rechnung-2"]);
    const omitted = { drafts: 2, quotations: 495, orderConfirmations: 1, deliveryNotes: 1, other: 1 };
    expect(parts).toEqual([
      { manifest: expect.objectContaining({ version: 2, part: 1, vouchers: 1, failed: [], omitted }), vouchers: ["belege/rechnung-1.json"] },
      { manifest: expect.objectContaining({ version: 2, part: 2, vouchers: 1, failed: [], omitted }), vouchers: ["belege/rechnung-2.json"] },
    ]);
  });

  it("meldet ausdrücklich null ausgelassene Vorgänge, wenn keine gefunden wurden", async () => {
    const { parts } = await backup([], []);
    expect(parts).toEqual([
      {
        manifest: expect.objectContaining({ omitted: { drafts: 0, quotations: 0, orderConfirmations: 0, deliveryNotes: 0, other: 0 } }),
        vouchers: [],
      },
    ]);
  });
});
