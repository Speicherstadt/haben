import { abziehbarerAnteil, uebernommeneAnteile, type BasisPoints, type ExpenseCategory } from "@haben/core";
import { desc, eq } from "drizzle-orm";
import { db, schema } from "../../db/index.ts";
import { today } from "../../today.ts";
import { ownAccountAssignmentProblem } from "../eigene-konten/index.ts";
import { getContact, loadCompany } from "../stammdaten/index.ts";
import { DocumentError, uploadDocument, type Document, type DocumentAmount, type DocumentInput, type UploadResult } from "./documents.ts";
import { formularansicht } from "./beleg-eingabe.ts";
import { loadPositionen, type Belegposition } from "./positionen.ts";

/*
 * Beleg duplizieren (#1295): ein neuer Entwurf mit der Kontierung eines vorhandenen Belegs, für wiederkehrende Einkäufe
 * beim selben Lieferanten. Jeder Beleg hat seine Datei (documents.sha256), deshalb kommt die neue gleich mit; sie geht
 * denselben Weg wie beim Hochladen, wird aber nicht ausgelesen. Datei, Zahlungen und Festschreibung des Originals
 * bleiben, wo sie sind.
 */

/** Steuersatz einer Zeile, wie ihn documentInputSchema annimmt; gespeichert sind nur diese drei */
type Satz = DocumentInput["amounts"][number]["taxRate"];

/**
 * Felder des Duplikats: Lieferant, Positionen (Kategorie, eigenes Konto, Privatanteil), Bezahlung, Steuerbehandlung und
 * Beträge je Satz wie am Original, das Belegdatum heute. Lassen sich die Positionen als Kategorie mit Privatanteil
 * darstellen (formularansicht), geht das Duplikat diesen Weg und rundet wie das Original; sonst als Positionen mit der
 * Steuer je Satz des Originals. Leer bleiben Rechnungsnummer, Fälligkeit,
 * Leistungszeitraum, Notiz und „erstattet bereits Bezahltes“; der Kurs einer Fremdwährung gilt neu für den Monat des
 * Belegdatums (resolveExchangeRate). `vorgabe`: Vorsteueranteil nach den Firmendaten ohne Angabe am Beleg.
 */
function duplicateFields(original: Document, amounts: DocumentAmount[], positionen: Belegposition[], vorgabe: BasisPoints, todayDate: string): DocumentInput {
  const anteile = uebernommeneAnteile(
    { gebucht: original.lockedAt !== null, ...original },
    amounts.map((a) => a.vorsteuerAnteil),
    vorgabe,
  );
  const ansicht = formularansicht(original, positionen);
  const alsPositionen = ansicht.splits.length > 0;
  const fremd = original.currency !== "EUR";
  return {
    supplierName: original.supplierName,
    supplierUstId: original.supplierUstId,
    supplierContactId: original.supplierContactId,
    invoiceNumber: "",
    documentDate: todayDate,
    dueDate: null,
    category: alsPositionen ? null : (ansicht.document.category as ExpenseCategory | null),
    ownAccountId: alsPositionen ? null : ansicht.document.ownAccountId,
    payment: original.payment,
    note: "",
    privateShare: alsPositionen ? 0 : ansicht.document.privateShare,
    vorsteuerAnteil: anteile.beleg,
    reverseCharge: original.reverseCharge,
    asset: original.asset,
    currency: original.currency,
    amounts: amounts.map((a, i) => ({
      taxRate: a.taxRate as Satz,
      net: a.net,
      tax: a.tax,
      vorsteuerAnteil: anteile.saetze[i] ?? null,
      originalNet: a.originalNet,
      originalTax: a.originalTax,
    })),
    positions: ansicht.splits.map((p) => ({
      category: p.category as ExpenseCategory,
      ownAccountId: p.ownAccountId,
      taxRate: p.taxRate as Satz,
      net: fremd ? (p.originalNet ?? 0) : p.net,
      description: p.description,
    })),
  };
}

/**
 * Legt mit der Datei `file` einen Entwurf mit den Feldern des Belegs `id` an. Liegt die Datei schon in Haben, entsteht
 * nichts, und das Ergebnis nennt den vorhandenen Beleg (duplicate), wie beim Hochladen.
 */
export async function duplicateDocument(actor: string, id: string, file: { bytes: Uint8Array; filename: string }): Promise<UploadResult> {
  const [original] = await db.select().from(schema.documents).where(eq(schema.documents.id, id));
  if (!original) throw new DocumentError("Beleg nicht gefunden.");
  if (original.extractionStatus === "laeuft" || original.extractionStatus === "wartet")
    throw new DocumentError("Der Beleg wird gerade ausgelesen. Dupliziere ihn, wenn die Felder da sind.");
  const amounts = await db.select().from(schema.documentAmounts).where(eq(schema.documentAmounts.documentId, id)).orderBy(desc(schema.documentAmounts.taxRate));
  // Was sich heute am Beleg nicht mehr wählen ließe, fällt weg, statt das Duplikat abzulehnen: ein archivierter Kontakt oder
  // einer, der kein Lieferant mehr ist (wie listContactChoices), und ein archiviertes oder unpassendes eigenes Konto (dann
  // gilt das Konto der Kategorie)
  const lieferant = original.supplierContactId ? (await getContact(original.supplierContactId))?.contact : null;
  const kontakt = lieferant?.isSupplier && !lieferant.archivedAt ? lieferant.id : null;
  const konto = async (ownAccountId: string | null, category: string | null) =>
    ownAccountId && !(await ownAccountAssignmentProblem(db, ownAccountId, category)) ? ownAccountId : null;
  const beleg = { ...original, supplierContactId: kontakt, ownAccountId: await konto(original.ownAccountId, original.category) };
  const zeilen = await Promise.all((await loadPositionen(id)).map(async (p) => ({ ...p, ownAccountId: await konto(p.ownAccountId, p.category) })));
  const fields = duplicateFields(beleg, amounts, zeilen, abziehbarerAnteil(await loadCompany(), null), today());
  return uploadDocument(actor, file, { fields });
}
