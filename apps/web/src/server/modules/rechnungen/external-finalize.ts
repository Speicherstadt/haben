import { and, eq } from "drizzle-orm";
import { db, schema } from "../../db/index.ts";
import { reportInternalError, userMessage } from "../../errors.ts";
import { loadMailSettings } from "../mail/index.ts";
import { finalizeInvoice, finalizeIssues } from "./invoice-finalize.ts";
import { customerEmail, sendInvoiceMailWithTemplate } from "./invoice-mail.ts";
import { getInvoice, type Invoice } from "./invoices.ts";
import type { UmsatzStand } from "./umsatzgrenze.ts";

/*
 * Festschreiben und Versenden eines Entwurfs aus einer externen Quelle (#1918), etwa einer eBay-Bestellung, die ein
 * Dienst über die REST-API angelegt hat. Derselbe Ablauf wie „Direkt festschreiben“ der wiederkehrenden Rechnungen
 * (recurring.ts): erst festschreiben, dann mit der Vorlage an die Adresse des Kunden. Welche Bestellung festgeschrieben
 * wird, entscheidet der Dienst; Haben schreibt nur fest, wenn nichts dagegen spricht, und nur Entwürfe der Quelle, für
 * die das Token in Haben freigegeben ist.
 */

export type Versand = { status: "gesendet" | "schon_gesendet" | "nicht_verlangt" } | { status: "fehlgeschlagen"; fehler: string };

export type ExternalFinalizeResult =
  | { ok: true; invoice: Invoice; finalized: boolean; versand: Versand }
  | { ok: false; code: "not_found" | "forbidden" | "unprocessable"; message: string; issues?: string[] };

const refused = (code: "not_found" | "forbidden" | "unprocessable", message: string, issues?: string[]): ExternalFinalizeResult => ({
  ok: false,
  code,
  message,
  ...(issues ? { issues } : {}),
});

/** Warum die Mail mit der Vorlage nicht gehen könnte (wie in sendInvoiceMailWithTemplate), schon am Entwurf; sonst null */
async function mailProblem(invoice: Invoice): Promise<string | null> {
  if (!(await loadMailSettings())) return "Es ist kein E-Mail-Zugang eingerichtet (Einstellungen › E-Mail-Versand).";
  if (!(await customerEmail(invoice))) return "Der Kunde hat keine E-Mail-Adresse.";
  return null;
}

async function sentByMail(id: string): Promise<boolean> {
  const [row] = await db
    .select({ id: schema.mailLog.id })
    .from(schema.mailLog)
    .where(and(eq(schema.mailLog.invoiceId, id), eq(schema.mailLog.kind, "rechnung"), eq(schema.mailLog.ok, true)))
    .limit(1);
  return !!row;
}

/** Mail mit der Vorlage; ein Fehler macht das Festschreiben nicht rückgängig und steht in der Antwort */
async function sendOnce(actor: string, id: string): Promise<Versand> {
  if (await sentByMail(id)) return { status: "schon_gesendet" };
  try {
    const sent = await sendInvoiceMailWithTemplate(actor, id);
    return sent.ok ? { status: "gesendet" } : { status: "fehlgeschlagen", fehler: sent.error ?? "unbekannter Fehler" };
  } catch (error) {
    return { status: "fehlgeschlagen", fehler: userMessage(error) ?? reportInternalError("Versand nach dem Festschreiben über die API", error) };
  }
}

/** Was gegen das Festschreiben spricht, bevor etwas geschrieben wird; null, wenn es losgehen kann */
async function draftProblem(invoice: Invoice, senden: boolean): Promise<ExternalFinalizeResult | null> {
  if (invoice.paymentMethod !== "bereits_bezahlt") {
    return refused("unprocessable", "Über die API werden nur Entwürfe mit der Zahlungsart „Bereits bezahlt“ festgeschrieben.");
  }
  const issues = await finalizeIssues(invoice.id);
  if (issues.length > 0) return refused("unprocessable", `Noch nicht bereit: ${issues.join(", ")}.`, issues);
  const problem = senden ? await mailProblem(invoice) : null;
  return problem ? refused("unprocessable", `${problem} Nichts festgeschrieben.`) : null;
}

/**
 * Schreibt den Entwurf fest und versendet ihn auf Wunsch. Idempotent: Eine schon festgeschriebene Rechnung kommt
 * unverändert zurück; mit `senden` geht sie nur dann per E-Mail, wenn sie noch nie erfolgreich gegangen ist.
 */
export async function finalizeExternalDraft(
  actor: string,
  id: string,
  { source, senden, umsatzStand }: { source: string; senden: boolean; umsatzStand: UmsatzStand },
): Promise<ExternalFinalizeResult> {
  const found = await getInvoice(id);
  if (!found) return refused("not_found", "Rechnung nicht gefunden.");
  const { invoice } = found;
  if (invoice.kind !== "rechnung" || !invoice.externalSource) {
    return refused("unprocessable", "Über die API werden nur Rechnungsentwürfe mit externer Referenz (externalSource) festgeschrieben.");
  }
  if (invoice.externalSource !== source) {
    return refused("forbidden", `Dieses Token darf nur Entwürfe der Quelle „${source}“ festschreiben, diese Rechnung kommt aus „${invoice.externalSource}“.`);
  }
  if (invoice.status !== "draft") {
    // Auch eine in Haben von Hand festgeschriebene Rechnung der Quelle geht nur mit „Bereits bezahlt“ per API hinaus
    if (senden && invoice.paymentMethod !== "bereits_bezahlt") {
      return refused("unprocessable", "Über die API werden nur Rechnungen mit der Zahlungsart „Bereits bezahlt“ versendet.");
    }
    return { ok: true, invoice, finalized: false, versand: senden ? await sendOnce(actor, id) : { status: "nicht_verlangt" } };
  }
  const problem = await draftProblem(invoice, senden);
  if (problem) return problem;
  // Die Rückfrage zur Kleinunternehmergrenze kann ein Token nicht bestätigen: UmsatzgrenzeError wird zur 422
  const finalized = await finalizeInvoice(actor, id, umsatzStand);
  return { ok: true, invoice: finalized, finalized: true, versand: senden ? await sendOnce(actor, id) : { status: "nicht_verlangt" } };
}
