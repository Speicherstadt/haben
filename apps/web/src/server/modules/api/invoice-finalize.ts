import { z } from "zod";
import { deliverSoon } from "../ablage/index.ts";
import { kleinunternehmerStand } from "../auswertungen/index.ts";
import { finalizeExternalDraft } from "../rechnungen/index.ts";
import { fail, notFound, ok, validate, type ApiRequest, type ApiResult } from "./http.ts";
import { invoiceBody } from "./invoices.ts";
import type { ApiRoute } from "./routes.ts";
import { invoiceSchema, requestSchemas, responseSchemas } from "./schemas.ts";

/*
 * POST /rechnungen/{id}/festschreiben (#1918): Ein Dienst wie eine eBay-Anbindung schreibt seine Entwürfe fest und
 * versendet sie auf Wunsch per E-Mail. Das Recht rechnungen:festschreiben gilt nur für die eine Quelle, die beim Anlegen
 * des Tokens in Haben gewählt wurde; Storno, Korrektur und ELSTER bleiben ein Klick in Haben.
 */

const finalizeRequestSchema = z
  .object({
    senden: z.boolean().default(false).describe("Nach dem Festschreiben mit der Vorlage an die E-Mail-Adresse des Kunden senden"),
  })
  .strict()
  .register(requestSchemas, { id: "InvoiceFinalize" });

const versandSchema = z
  .object({
    status: z
      .enum(["gesendet", "schon_gesendet", "nicht_verlangt", "fehlgeschlagen"])
      .describe(
        "gesendet: jetzt per E-Mail; schon_gesendet: früher schon erfolgreich, keine zweite Mail; fehlgeschlagen: festgeschrieben, Mail nicht gesendet",
      ),
    fehler: z.string().optional().describe("Bei fehlgeschlagen: warum; in Haben auf der Rechnung unter „Per E-Mail“ nachholbar"),
  })
  .register(responseSchemas, { id: "InvoiceDispatch" });

const finalizedSchema = invoiceSchema
  .extend({
    festgeschrieben: z.boolean().describe("true: mit diesem Aufruf festgeschrieben; false: war schon festgeschrieben"),
    versand: versandSchema,
  })
  .register(responseSchemas, { id: "InvoiceFinalized" });

async function finalizeInvoiceHandler(request: ApiRequest): Promise<ApiResult> {
  const parsed = validate(finalizeRequestSchema, request.body ?? {});
  if ("failure" in parsed) return parsed.failure;
  // Ein Token mit dem Recht hat immer eine Quelle (mcpTokenInputSchema); ohne sie schreibt es nichts fest
  if (!request.finalizeSource) return fail("forbidden", "Diesem Token ist keine Quelle zum Festschreiben zugeordnet.");
  const result = await finalizeExternalDraft(request.actor, request.params.id!, {
    source: request.finalizeSource,
    senden: parsed.data.senden,
    umsatzStand: kleinunternehmerStand,
  });
  if (!result.ok) {
    return fail(result.code, result.message, result.issues ? { issues: result.issues.map((message) => ({ path: "", message })) } : {});
  }
  if (result.finalized) deliverSoon();
  const body = await invoiceBody(result.invoice.id, request);
  if (!body) return notFound("Rechnung nicht gefunden.");
  return ok({ ...body, festgeschrieben: result.finalized, versand: result.versand } satisfies z.output<typeof finalizedSchema>);
}

export const INVOICE_FINALIZE_ROUTES: ApiRoute[] = [
  {
    method: "POST",
    path: "/rechnungen/{id}/festschreiben",
    scope: "rechnungen:festschreiben",
    tag: "Rechnungen",
    summary: "Rechnungsentwurf festschreiben und versenden",
    description:
      "Nur Entwürfe mit externer Referenz aus der Quelle, für die das Token in Haben freigegeben ist, mit der Zahlungsart „Bereits bezahlt“. " +
      "Haben schreibt fest wie bei „Direkt festschreiben“ der wiederkehrenden Rechnungen: Nummer, PDF, E-Rechnung und Buchung. " +
      "Mit senden geht die Rechnung danach mit der Vorlage an die E-Mail-Adresse des Kunden. Idempotent: Eine festgeschriebene " +
      "Rechnung kommt unverändert zurück, eine Mail geht nur, solange noch keine erfolgreich gegangen ist. Storno und Korrektur gibt es nur in Haben.",
    requestBody: "InvoiceFinalize",
    responses: {
      200: { schema: "InvoiceFinalized", description: "Festgeschrieben (oder schon festgeschrieben), mit dem Ergebnis des Versands" },
    },
    errors: {
      403: "Dem Token fehlt das Recht rechnungen:festschreiben, oder die Rechnung kommt aus einer anderen Quelle",
      422: "Nicht bereit (Hinweise wie im Editor in issues, auch die Rückfrage zur Kleinunternehmergrenze), nicht „Bereits bezahlt“, ohne externe Referenz, oder mit senden ohne E-Mail-Adresse oder E-Mail-Zugang; der Entwurf bleibt unverändert",
    },
    handler: finalizeInvoiceHandler,
  },
];
