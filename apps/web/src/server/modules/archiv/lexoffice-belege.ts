import { LexofficeApiError, mapPayments, mapSalesDocument, mapVoucher, type LegacyVoucher, type LexFile, type LexofficeSource } from "@haben/import";
import { desc, eq } from "drizzle-orm";
import { withActor } from "../../db/actor.ts";
import { db, schema, type Tx } from "../../db/index.ts";
import type { LexofficeImportProgress } from "../../db/schema.ts";
import { recordFileState } from "./dateistand.ts";
import { attachVoucherFiles, storeLegacyVoucher } from "./legacy-store.ts";
import { fallbackName, progressMessage } from "./umzug-gemeinsam.ts";

export const SALES_TYPES = ["invoice", "creditnote", "downpaymentinvoice"] as const;
type SalesType = (typeof SALES_TYPES)[number];

function isSalesType(type: string): type is SalesType {
  return (SALES_TYPES as readonly string[]).includes(type);
}

type DateiEintrag = { role: "pdf" | "xml" | "anhang"; lexofficeFileId: string | null; file: LexFile };
type OffeneDatei = { voucherId: string; number: string; type: string; role: "pdf" | "xml" | "anhang"; fileId: string | null };

/**
 * Belege mit einer offenen Datei, je Datei der jüngste Stand. Der Stand nennt Rolle und Kennung in der Quelle; offen ist
 * eine Datei, solange kein späterer Stand genau diese Rolle und Kennung ablöst. Offen sind beide Stände: ein
 * fehlgeschlagener Abruf (`abruf_fehlgeschlagen`) und ein fehlender Anhang (`anhang_fehlt`, etwa das XML einer
 * E-Rechnung). Ein späterer Lauf holt deshalb jede offene Datei nach und nicht nur eine je Beleg (#1504, #1624). PDF und
 * XML der Rechnung tragen keine Kennung; sie kommen nur mit dem Beleg selbst und stehen deshalb mit leerer Kennung da.
 */
export async function offeneDateien(): Promise<Map<string, OffeneDatei[]>> {
  const rows = await db
    .selectDistinctOn([schema.legacyFileStates.voucherId, schema.legacyFileStates.role, schema.legacyFileStates.sourceFileId], {
      lexofficeId: schema.lexofficeVouchers.lexofficeId,
      number: schema.lexofficeVouchers.number,
      type: schema.lexofficeVouchers.type,
      voucherId: schema.legacyFileStates.voucherId,
      role: schema.legacyFileStates.role,
      fileId: schema.legacyFileStates.sourceFileId,
      state: schema.legacyFileStates.state,
    })
    .from(schema.legacyFileStates)
    .innerJoin(schema.lexofficeVouchers, eq(schema.lexofficeVouchers.id, schema.legacyFileStates.voucherId))
    .where(eq(schema.lexofficeVouchers.source, "lexoffice"))
    .orderBy(
      schema.legacyFileStates.voucherId,
      schema.legacyFileStates.role,
      schema.legacyFileStates.sourceFileId,
      desc(schema.legacyFileStates.createdAt),
      desc(schema.legacyFileStates.id),
    );
  const out = new Map<string, OffeneDatei[]>();
  for (const row of rows) {
    if ((row.state !== "abruf_fehlgeschlagen" && row.state !== "anhang_fehlt") || !row.role) continue;
    const liste = out.get(row.lexofficeId) ?? [];
    liste.push({ voucherId: row.voucherId, number: row.number, type: row.type, role: row.role, fileId: row.fileId });
    out.set(row.lexofficeId, liste);
  }
  return out;
}

/** Holt die offenen Dateien eines früheren Belegs nach; true, wenn mindestens eine ankam */
export async function nachladenDateien(
  actor: string,
  importId: string,
  client: LexofficeSource,
  item: { id: string; type: string },
  offen: OffeneDatei[],
  progress: LexofficeImportProgress,
): Promise<boolean> {
  // Das PDF und ein XML der Rechnung hängen nicht an einer Kennung; sie kommen über den Beleg selbst
  const salesType = isSalesType(item.type) ? item.type : null;
  const anfragen: (readonly ["pdf" | "xml" | "anhang", string | null, () => Promise<LexFile | null>])[] = [];
  for (const eintrag of offen) {
    if (eintrag.role === "anhang") {
      const fileId = eintrag.fileId;
      if (fileId !== null) anfragen.push(["anhang", fileId, () => client.file(fileId)]);
      continue;
    }
    if (salesType === null) continue;
    const role = eintrag.role;
    anfragen.push([role, null, () => (role === "pdf" ? client.salesDocumentPdf(salesType, item.id) : client.salesDocumentXml(salesType, item.id))]);
  }
  if (anfragen.length === 0) return false;
  const files: DateiEintrag[] = [];
  const weiterhin: FehlendeDatei[] = [];
  const ohneAnhang: ("pdf" | "xml" | "anhang")[] = [];
  await ladeDateien(files, weiterhin, anfragen, ohneAnhang);
  if (files.length === 0 && ohneAnhang.length === 0) return false;
  const voucherId = offen[0]!.voucherId;
  const number = offen[0]!.number || item.id;
  const angehaengt = await withActor(actor, async (tx) => {
    const count = await attachVoucherFiles(
      tx,
      voucherId,
      files.map((entry) => ({
        role: entry.role,
        sourceFileId: entry.lexofficeFileId,
        filename: entry.file.filename ?? fallbackName({ number, lexofficeId: item.id }, entry.role, entry.file.bytes),
        mimeType: entry.file.mimeType,
        bytes: entry.file.bytes,
      })),
    );
    // Ein Stand je Datei mit Rolle und Kennung: er löst genau diese Datei und trägt den Zeitpunkt für „(nachgeladen)“ (#1624)
    for (const entry of files)
      await recordFileState(
        tx,
        voucherId,
        { state: "nachgeladen", role: entry.role, sourceFileId: entry.lexofficeFileId, message: "Datei bei einem späteren Import nachgeladen." },
        { actor, importId },
      );
    // Die Quelle nennt ohne Fehler kein XML: nichts mehr offen, auch wenn nichts ankam. Sonst bliebe die Rechnung für
    // immer gesperrt, weil jeder weitere Lauf dasselbe „kein XML“ hört (#1624)
    if (ohneAnhang.length > 0)
      await recordFileState(
        tx,
        voucherId,
        { state: "kein_anhang", role: "xml", sourceFileId: null, message: "Die Quelle nennt keine E-Rechnung." },
        { actor, importId },
      );
    return count;
  });
  progress.files += angehaengt;
  // Was weiterhin fehlt, wird danach in einem eigenen Schritt vermerkt: mit dem jüngeren Zeitstempel bleibt der Beleg
  // offen, auch wenn eine der Dateien ankam (#1624)
  if (weiterhin.length > 0) await withActor(actor, (tx) => vermerkeFehlendeDateien(tx, voucherId, weiterhin, { actor, importId }));
  return files.length > 0;
}
/** Eine Datei, die der Beleg führt und die nicht kommt; sie wird am Beleg vermerkt, nicht als Grund, ihn wegzulassen (#1504) */
type FehlendeDatei = { role: "pdf" | "xml" | "anhang"; fileId: string | null; message: string };

/**
 * Holt die Dateien eines Belegs einzeln. Was nicht kommt, landet in `missing`; nur ein ungültiger Schlüssel und ein
 * Abbruch gelten für den ganzen Lauf und werden weitergereicht. Antwortet die Quelle für das XML der E-Rechnung ohne
 * Fehler „gibt es nicht“, landet die Rolle in `ohneAnhang`: das ist eine Auskunft und keine Lücke (#1624).
 */
async function ladeDateien(
  files: DateiEintrag[],
  missing: FehlendeDatei[],
  anfragen: readonly (readonly ["pdf" | "xml" | "anhang", string | null, () => Promise<LexFile | null>])[],
  ohneAnhang: ("pdf" | "xml" | "anhang")[] = [],
): Promise<void> {
  for (const [role, fileId, laden] of anfragen) {
    try {
      const file = await laden();
      if (file) files.push({ role, lexofficeFileId: fileId, file });
      // Eine Rechnung ohne E-Rechnung (406): nichts, was ein weiterer Abruf je nachholen könnte
      else if (role === "xml") ohneAnhang.push(role);
    } catch (error) {
      // Ungültiger Schlüssel und Abbruch gelten für den ganzen Lauf; den Abbruch meldet der Client mit Status 0
      if (error instanceof LexofficeApiError && [0, 401, 403].includes(error.status)) throw error;
      if (error instanceof Error && error.name === "AbortError") throw error;
      missing.push({ role, fileId, message: progressMessage(error) });
    }
  }
}

/**
 * Der Beleg steht, die Datei fehlt: offener Punkt am Beleg statt stillem Verlust. Fehlt die Hauptdatei (PDF bzw. der
 * Anhang eines Buchhaltungsbelegs), nennt die Quelle sie und sie kommt nicht — genau der Stand „Abruf fehlgeschlagen“.
 * Fehlt dagegen das XML einer E-Rechnung neben dem PDF, ist das Original unvollständig, aber der Beleg ist da: derselbe
 * Stand wie bei sevDesk, `anhang_fehlt` mit Rolle `xml` (#345). Bestätigen lässt sich keiner davon, „ohne Beleg“ trägt
 * der Beleg nicht (#1318, #1504).
 */
async function vermerkeFehlendeDateien(tx: Tx, voucherId: string, missing: FehlendeDatei[], by: { actor: string; importId: string }): Promise<void> {
  for (const entry of missing) {
    const xml = entry.role === "xml";
    await recordFileState(
      tx,
      voucherId,
      {
        state: xml ? "anhang_fehlt" : "abruf_fehlgeschlagen",
        role: entry.role,
        sourceFileId: entry.fileId,
        message: `${xml ? "XML der E-Rechnung fehlt in der Sicherung oder kam nicht" : "Datei fehlt in der Sicherung oder kam nicht"}: ${entry.message}`.slice(
          0,
          500,
        ),
      },
      by,
    );
  }
}

export async function importVoucher(
  actor: string,
  importId: string,
  client: LexofficeSource,
  item: { id: string; type: string },
  categories: Map<string, string>,
  progress: LexofficeImportProgress,
): Promise<boolean> {
  let voucher: LegacyVoucher;
  let raw: unknown;
  const files: DateiEintrag[] = [];
  const missing: FehlendeDatei[] = [];
  if (isSalesType(item.type)) {
    // Als eigene Konstante, sonst verliert TypeScript die Verengung in den Pfeilfunktionen der Helfer
    const type = item.type;
    raw = await client.salesDocument(type, item.id);
    voucher = mapSalesDocument(type, raw as Parameters<typeof mapSalesDocument>[1], item.id);
    await ladeDateien(files, missing, [
      ["pdf", null, () => client.salesDocumentPdf(type, item.id)],
      ["xml", null, () => client.salesDocumentXml(type, item.id)],
    ]);
  } else {
    raw = await client.voucher(item.id);
    voucher = mapVoucher(raw as Parameters<typeof mapVoucher>[0], item.id);
    await ladeDateien(
      files,
      missing,
      voucher.fileIds.map((fileId) => ["anhang", fileId, () => client.file(fileId)] as const),
    );
  }
  const payments = await client.payments(item.id);

  return withActor(actor, async (tx) => {
    const [contact] = voucher.contactLexofficeId
      ? await tx.select({ id: schema.contacts.id }).from(schema.contacts).where(eq(schema.contacts.lexofficeId, voucher.contactLexofficeId))
      : [];
    const row = await storeLegacyVoucher(
      tx,
      {
        lexofficeId: voucher.lexofficeId,
        importId,
        type: voucher.type,
        direction: voucher.direction,
        number: voucher.number,
        date: voucher.date,
        dueDate: voucher.dueDate,
        serviceFrom: voucher.serviceFrom,
        serviceTo: voucher.serviceTo,
        status: voucher.status,
        contactId: contact?.id ?? null,
        contactName: voucher.contactName,
        currency: voucher.currency,
        net: voucher.net,
        tax: voucher.tax,
        gross: voucher.gross,
        taxes: voucher.taxes,
        categories: voucher.categories.map((c) => ({ ...c, name: categories.get(c.categoryId) ?? "" })),
        payment: payments ? mapPayments(payments) : null,
        remark: voucher.remark,
        raw: raw as Record<string, unknown>,
      },
      files.map((entry) => ({
        role: entry.role,
        sourceFileId: entry.lexofficeFileId,
        filename: entry.file.filename ?? fallbackName(voucher, entry.role, entry.file.bytes),
        mimeType: entry.file.mimeType,
        bytes: entry.file.bytes,
      })),
    );
    if (!row) return false;
    progress.files += row.files;
    await vermerkeFehlendeDateien(tx, row.id, missing, { actor, importId });
    return true;
  });
}
