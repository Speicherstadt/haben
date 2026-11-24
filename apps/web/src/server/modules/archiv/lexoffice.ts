import { isUniqueViolation } from "../../errors.ts";
import {
  LexofficeApiError,
  LexofficeClient,
  mapContact,
  readWebExport,
  type LexofficeClientOptions,
  type LexofficeSource,
  type WebOmittedCounts,
  webExportSource,
} from "@haben/import";
import { and, eq, isNull, sql } from "drizzle-orm";
import { decrypt, encrypt } from "../../crypto.ts";
import { withActor } from "../../db/actor.ts";
import { env } from "../../env.ts";
import { db, schema } from "../../db/index.ts";
import type { LexofficeImportProgress } from "../../db/schema.ts";
import { LEGACY_SOURCE } from "../../../lib/altbestand.ts";
import { importVoucher, nachladenDateien, offeneDateien, SALES_TYPES } from "./lexoffice-belege.ts";
import { LexofficeError, progressMessage } from "./umzug-gemeinsam.ts";
import { finish, latestImportFor, importControllersFor, refreshImportRuns } from "./umzug-lauf.ts";

export { LexofficeError } from "./umzug-gemeinsam.ts";

const running = importControllersFor("lexoffice");
export const latestImport = () => latestImportFor("lexoffice");

/** Für Tests austauschbar: baut den API-Client */
let clientFactory = (options: LexofficeClientOptions) => new LexofficeClient({ baseUrl: env().LEXOFFICE_API_URL || undefined, ...options });

export function setLexofficeClientFactory(factory: (options: LexofficeClientOptions) => LexofficeClient) {
  clientFactory = factory;
}

const BOOKKEEPING_TYPES = ["salesinvoice", "salescreditnote", "purchaseinvoice", "purchasecreditnote"] as const;

async function apiKey(): Promise<string | null> {
  const [row] = await db.select().from(schema.lexofficeConnection).where(eq(schema.lexofficeConnection.id, 1));
  return row ? decrypt(row.ciphertext).toString("utf8") : null;
}

export async function connectionStatus() {
  const [row] = await db
    .select({ organizationName: schema.lexofficeConnection.organizationName, createdAt: schema.lexofficeConnection.createdAt })
    .from(schema.lexofficeConnection)
    .where(eq(schema.lexofficeConnection.id, 1));
  return row ?? null;
}

/** Prüft den Schlüssel gegen /profile und speichert ihn verschlüsselt. */
export async function saveApiKey(actor: string, key: string): Promise<{ organizationName: string }> {
  const trimmed = key.trim();
  if (trimmed.length < 20) throw new LexofficeError("Der API-Schlüssel ist zu kurz.");
  let organizationName: string;
  try {
    const profile = await clientFactory({ apiKey: trimmed }).profile();
    organizationName = profile.companyName ?? "";
  } catch (error) {
    throw new LexofficeError(`Lexware Office lehnt den Schlüssel ab: ${progressMessage(error)}`);
  }
  await withActor(actor, async (tx) => {
    await tx.delete(schema.lexofficeConnection).where(eq(schema.lexofficeConnection.id, 1));
    await tx.insert(schema.lexofficeConnection).values({ id: 1, ciphertext: encrypt(Buffer.from(trimmed, "utf8")), organizationName });
  });
  return { organizationName };
}

export async function removeApiKey(actor: string) {
  await withActor(actor, (tx) => tx.delete(schema.lexofficeConnection).where(eq(schema.lexofficeConnection.id, 1)));
}
/**
 * Startet den Abruf über die Public API im Hintergrund. Schon übernommene Belege werden übersprungen, ein neuer Lauf
 * setzt also nach einem Abbruch fort. Gibt die ID des Laufs zurück; den Fortschritt liefert latestImport().
 */
export async function startImport(actor: string, options: { wait?: boolean } = {}): Promise<string> {
  const key = await apiKey();
  if (!key) throw new LexofficeError("Zuerst den API-Schlüssel hinterlegen.");
  return launchImport(actor, (signal) => clientFactory({ apiKey: key, signal }), options);
}

/**
 * Übernimmt eine Sicherung aus der Web-Oberfläche (Skript lexware-sicherung.js, für Tarife ohne Public API).
 * Derselbe Ablauf wie beim Abruf über die API: Kontakte, Belege mit Zahlungen und Dateien; Vorhandenes wird
 * übersprungen, Teile dürfen nacheinander kommen.
 */
export async function startWebImport(actor: string, parts: { name: string; bytes: Uint8Array }[], options: { wait?: boolean } = {}): Promise<string> {
  const backup = readWebExport(parts);
  const source = webExportSource(backup);
  return launchImport(actor, () => source, { ...options, webOmitted: backup.omitted });
}

async function launchImport(
  actor: string,
  sourceFor: (signal: AbortSignal) => LexofficeSource,
  options: { wait?: boolean; webOmitted?: WebOmittedCounts },
): Promise<string> {
  if ((await latestImport())?.status === "laeuft") throw new LexofficeError("Ein Abruf läuft bereits.");

  // Diese beiden Meldungen gehörten schon zur Lexware-Office-Verbindung.

  for (const source of ["sevdesk", "fastbill"] as const) {
    if ((await latestImportFor(source))?.status === "laeuft") throw new LexofficeError(`Ein Abruf aus ${LEGACY_SOURCE[source].product} läuft bereits.`);
  }

  await refreshImportRuns();

  const progress: LexofficeImportProgress = {
    phase: "kontakte",
    contacts: 0,
    contactsLinked: 0,
    listed: 0,
    imported: 0,
    skipped: 0,
    files: 0,
    failed: [],
    ...(options.webOmitted ? { webOmitted: options.webOmitted } : {}),
  };
  const [row] = await withActor(actor, (tx) => tx.insert(schema.lexofficeImports).values({ progress }).returning({ id: schema.lexofficeImports.id })).catch(
    (error: unknown) => {
      // Gleichzeitig gestartet: der eindeutige Index lässt nur einen laufenden Abruf zu
      if (isUniqueViolation(error, "lexoffice_imports_one_running")) throw new LexofficeError("Ein Abruf läuft bereits.");
      throw error;
    },
  );
  const id = row!.id;
  const controller = new AbortController();
  running.set(id, controller);
  const source = sourceFor(controller.signal);
  const job = runImport(actor, id, source, progress, controller.signal)
    .then(() => finish(id, progress, "fertig", null))
    .catch((error: unknown) =>
      finish(id, progress, controller.signal.aborted ? "abgebrochen" : "fehler", controller.signal.aborted ? "Abgebrochen." : progressMessage(error)),
    )
    // Scheitert auch das Speichern des Abschlusses, darf das keine unbehandelte Ablehnung werden
    .catch((error: unknown) => console.error("Lexware-Office-Abruf: Abschluss nicht gespeichert", error))
    .finally(() => running.delete(id));
  if (options.wait) await job;
  return id;
}

export function cancelImport(id: string): boolean {
  const controller = running.get(id);
  if (!controller) return false;
  controller.abort();
  return true;
}

/**
 * Belegliste des Laufs. Entwürfe sind keine Belege; der Abruf übergeht sie und zählt ihre Zahl, damit sie nicht still
 * verschwindet (#1504). Vorgänge ohne Belegart kommen über die API gar nicht erst in die Liste — die Sicherung aus der
 * Web-Oberfläche lässt sie schon beim Packen draußen (#183) und zählt sie dort; ihre Zahlen stehen in `webOmitted` (#1640).
 */
async function sammleBelegliste(
  client: LexofficeSource,
  progress: LexofficeImportProgress,
  save: (force?: boolean) => Promise<void>,
): Promise<{ id: string; type: string; number: string }[]> {
  const listed: { id: string; type: string; number: string }[] = [];
  let drafts = 0;
  for await (const item of client.voucherList([...SALES_TYPES, ...BOOKKEEPING_TYPES])) {
    if (item.voucherStatus === "draft") {
      drafts += 1;
      continue;
    }
    listed.push({ id: item.id, type: item.voucherType, number: item.voucherNumber ?? "" });
    progress.listed = listed.length;
    await save();
  }
  progress.ignored = drafts > 0 ? { drafts } : undefined;
  await save(true);
  return listed;
}

async function runImport(actor: string, importId: string, client: LexofficeSource, progress: LexofficeImportProgress, signal: AbortSignal) {
  let lastSave = 0;
  const save = async (force = false) => {
    if (!force && Date.now() - lastSave < 1000) return;
    lastSave = Date.now();
    await db.update(schema.lexofficeImports).set({ progress, updatedAt: new Date() }).where(eq(schema.lexofficeImports.id, importId));
  };

  // 1. Kontakte: vorhandene über die Lexoffice-ID überspringen, gleichnamige ohne ID verknüpfen
  await importContacts(actor, client, progress, signal, save);

  // 2. Belegliste; Entwürfe sind keine Belege und bleiben draußen
  progress.phase = "liste";
  await save(true);
  const categories = new Map((await client.postingCategories()).map((c) => [c.id, c.name]));
  const listed = await sammleBelegliste(client, progress, save);
  const done = new Set((await db.select({ id: schema.lexofficeVouchers.lexofficeId }).from(schema.lexofficeVouchers)).map((r) => r.id));
  // Belege mit fehlender Datei sind nicht abgeschlossen; eine spätere Sicherung kann die Datei enthalten (#1504)
  const nachzuladen = await offeneDateien();

  // 3. Je Beleg Details, Zahlungen und Dateien; Fehler einzelner Belege halten den Lauf nicht auf
  progress.phase = "belege";
  await save(true);
  for (const item of listed) {
    signal.throwIfAborted();
    if (done.has(item.id)) {
      const offen = nachzuladen.get(item.id);
      if (!offen) {
        progress.skipped += 1;
        continue;
      }
      try {
        if (await nachladenDateien(actor, importId, client, item, offen, progress)) progress.nachgeladen = (progress.nachgeladen ?? 0) + 1;
      } catch (error) {
        if (error instanceof LexofficeApiError && (error.status === 401 || error.status === 403)) throw error;
        if (signal.aborted || (error instanceof Error && error.name === "AbortError")) throw error;
        progress.failed.push({ lexofficeId: item.id, number: offen[0]!.number, message: progressMessage(error) });
      }
      await save();
      continue;
    }
    try {
      // false: ein gleichzeitiger Lauf hat den Beleg schon übernommen
      if (await importVoucher(actor, importId, client, item, categories, progress)) progress.imported += 1;
      else progress.skipped += 1;
    } catch (error) {
      // Schlüssel ungültig, Tarif gewechselt oder abgebrochen: weitermachen ist sinnlos
      if (error instanceof LexofficeApiError && (error.status === 401 || error.status === 403)) throw error;
      // Abgebrochen: der Client meldet das als eigenen Fehler, nicht als AbortError
      if (signal.aborted || (error instanceof Error && error.name === "AbortError")) throw error;
      progress.failed.push({ lexofficeId: item.id, number: item.number, message: progressMessage(error) });
    }
    await save();
  }
  await save(true);
}

async function importContacts(actor: string, client: LexofficeSource, progress: LexofficeImportProgress, signal: AbortSignal, save: () => Promise<void>) {
  for await (const raw of client.contacts()) {
    // Die Sicherung aus der Web-Oberfläche liest ohne Netz und kennt das Signal nicht: selbst prüfen
    signal.throwIfAborted();
    const contact = mapContact(raw);
    await withActor(actor, async (tx) => {
      const [known] = await tx.select({ id: schema.contacts.id }).from(schema.contacts).where(eq(schema.contacts.lexofficeId, contact.lexofficeId));
      if (known) return;
      const [sameName] = await tx
        .select({ id: schema.contacts.id })
        .from(schema.contacts)
        .where(and(isNull(schema.contacts.lexofficeId), sql`lower(${schema.contacts.name}) = lower(${contact.name})`))
        .limit(1);
      if (sameName) {
        // Rollen nur ergänzen: Lieferant in Lexoffice wird auch hier Lieferant, die Kundenrolle bleibt
        await tx
          .update(schema.contacts)
          .set({
            lexofficeId: contact.lexofficeId,
            ...(contact.isVendor
              ? { isSupplier: true, lieferantennummer: sql`coalesce(${schema.contacts.lieferantennummer}, ${contact.lieferantennummer})` }
              : {}),
          })
          .where(eq(schema.contacts.id, sameName.id));
        progress.contactsLinked += 1;
        return;
      }
      await tx.insert(schema.contacts).values({
        lexofficeId: contact.lexofficeId,
        kundennummer: contact.kundennummer,
        // Ohne Rolle in Lexoffice gilt der Kontakt wie bisher als Kunde
        isCustomer: contact.isCustomer || !contact.isVendor,
        isSupplier: contact.isVendor,
        lieferantennummer: contact.lieferantennummer,
        name: contact.name,
        strasse: contact.strasse,
        plz: contact.plz,
        ort: contact.ort,
        land: contact.land,
        email: contact.email,
        ustId: contact.ustId,
        archivedAt: contact.archived ? new Date() : null,
      });
      progress.contacts += 1;
    });
    await save();
  }
}
