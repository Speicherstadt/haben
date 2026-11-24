import { advanceVatDifference, type AdvanceBalanceEvent, type AdvanceVatChange, type TaxShare } from "@haben/core";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { schema, type Db, type Tx } from "../../db/index.ts";
import { anzahlungZurLeistung } from "./advance-deductions.ts";
import { family, heldUntilRefund, negate, paymentEvents } from "./advance-vat-plan.ts";
import { invoiceTaxReader } from "./invoice-tax.ts";
import { invoiceTotalsById } from "./invoice-taxes.ts";

type Invoice = typeof schema.invoices.$inferSelect;

/*
 * Kz 43 und 48 zählen nach dem Leistungstag, auch bei Ist (#1268, #1312). Storno und Korrektur mindern schon bezahltes
 * Entgelt darin erst mit der Rückzahlung, wie Kz 81 und 86 seit #1228 (UStAE 17.1 Abs. 2 Satz 3: „mindert sich die
 * Bemessungsgrundlage nur, soweit das Entgelt tatsächlich zurückgezahlt wird, und zwar in dem Besteuerungszeitraum, in dem
 * die Rückgewähr erfolgt“). Eine Regel für beide Kennzahlen (Entscheidung des Maintainers in #1745, offene Frage 1).
 * Gebucht wird nichts: Bei Ist mindert im Journal die Rückzahlung, als Kleinunternehmer führt der Steuerschlüssel „KU“ in
 * keine Kennzahl.
 *
 * Kz 43 und 48 zählen eine Schlussrechnung samt abgezogener Anzahlungen (umsatzsteuer/leistung-belege.ts); deshalb rechnen
 * deren Beträge und Zahlungen hier mit (anzahlungenDerKette). Als Kleinunternehmer zählen alle Belege der Kette, auch
 * Papierstorno und Ersatz einer Bilanz-Schlussrechnung (#750); über § 4 und Ausfuhr nur Belege mit eigener Buchung, wie
 * im Journal.
 */

/** Die bis zur Rückzahlung gehaltenen Minderungen einer Kette, die nach dem Leistungstag zählt (Ist, Kleinunternehmer) */
export async function nachLeistungBisZurRueckzahlung(original: Invoice, q: Db | Tx, taxes = invoiceTaxReader(q)): Promise<AdvanceVatChange[]> {
  return (await gehalten(original, q, taxes)).alles;
}

/**
 * Bei Soll über § 4 und Ausfuhr bucht das Journal das Gehaltene der eigenen Zahlungen schon (loadAdvanceVatPlan, „refund“);
 * hier nur, was die abgezogenen Anzahlungen daran ändern.
 */
export async function anzahlungenBisZurRueckzahlung(original: Invoice, q: Db | Tx, taxes = invoiceTaxReader(q)): Promise<AdvanceVatChange[]> {
  const { alles, gebucht } = await gehalten(original, q, taxes);
  return advanceVatDifference(gebucht, alles);
}

async function gehalten(original: Invoice, q: Db | Tx, taxes: ReturnType<typeof invoiceTaxReader>) {
  const kleinunternehmer = original.taxTreatment === "kleinunternehmer";
  const familie = await family(original.id, q);
  const belege: Invoice[] = [];
  for (const beleg of familie) if (kleinunternehmer || (await taxes.invoicePostingAllowed(beleg))) belege.push(beleg);
  const totals = await invoiceTotalsById(
    familie.map((i) => i.id),
    q,
  );
  const zahlungen = await paymentEvents(familie, q);
  const anzahlungen = await anzahlungenDerKette(original, belege, q);
  const mitAbzuegen = new Map([...totals].map(([id, t]) => [id, { taxes: [...t.taxes, ...(anzahlungen.abzuege.get(id) ?? [])] }]));
  // Der Ersatz einer Bilanz-Schlussrechnung (#750) übernimmt deren Zahlungen, das Papierstorno erstattet nichts
  // (docs/rechnungen.md): Das Bezahlte zählt ab dem Leistungstag des Ersatzes dort. Über § 4 und Ausfuhr zählen beide nicht.
  const ende = kleinunternehmer ? await ersatzTag(original, q) : null;
  return {
    alles: heldUntilRefund(original, belege, mitAbzuegen, [...bisZumEnde(zahlungen, ende), ...anzahlungen.zahlungen]),
    gebucht: heldUntilRefund(original, belege, totals, zahlungen),
  };
}

async function ersatzTag(original: Invoice, q: Db | Tx): Promise<string | null> {
  const [ersatz] = await q
    .select({ serviceDate: schema.invoices.serviceDate, issueDate: schema.invoices.issueDate })
    .from(schema.invoices)
    .where(and(eq(schema.invoices.replacesInvoiceId, original.id), eq(schema.invoices.status, "final")));
  return ersatz ? (ersatz.serviceDate ?? ersatz.issueDate) : null;
}

/** Zahlungen bis vor `ende`, dort mit umgekehrtem Vorzeichen zurückgenommen; spätere zählen nicht */
function bisZumEnde(events: AdvanceBalanceEvent[], ende: string | null): AdvanceBalanceEvent[] {
  if (!ende) return events;
  const vorher = events.flatMap((e) => (e.paid && e.date >= ende ? [] : [e]));
  const bezahlt = vorher.flatMap((e) => e.paid ?? []);
  return bezahlt.length ? [...vorher, { date: ende, paid: negate(bezahlt) }] : vorher;
}

/**
 * Die von der Kette abgezogenen Anzahlungen zur Leistung (anzahlungZurLeistung): je Beleg die Abzüge mit umgekehrtem
 * Vorzeichen, dazu die Zahlungen der Anzahlungen samt Rückzahlung auf ihr Storno. Das Storno der Schlussrechnung hält so
 * auch die bezahlte Anzahlung bis zur Rückzahlung. Zieht eine später festgeschriebene Schlussrechnung dieselbe Anzahlung
 * wieder ab, zählt sie dort im Leistungsmonat; an deren Leistungstag endet das Festhalten hier, spätere Zahlungen der
 * Anzahlung gehören zur neuen Schlussrechnung (Entscheidung in #1745).
 */
async function anzahlungenDerKette(original: Invoice, invoices: Invoice[], q: Db | Tx) {
  const l = schema.invoiceLines;
  const i = schema.invoices;
  const rows = await q
    .select({ invoiceId: l.invoiceId, rate: l.taxRate, net: l.net, anzahlung: i })
    .from(l)
    .innerJoin(i, eq(i.id, l.deductionOf))
    .where(
      and(
        inArray(
          l.invoiceId,
          invoices.map((x) => x.id),
        ),
        anzahlungZurLeistung(i),
      ),
    );
  const abzuege = new Map<string, TaxShare[]>();
  for (const r of rows) abzuege.set(r.invoiceId, [...(abzuege.get(r.invoiceId) ?? []), { rate: r.rate, base: -r.net, tax: 0 }]);
  const zahlungen: AdvanceBalanceEvent[] = [];
  for (const anzahlung of new Map(rows.map((r) => [r.anzahlung.id, r.anzahlung])).values()) {
    const [neu] = await q
      .select({ serviceDate: i.serviceDate, issueDate: i.issueDate })
      .from(l)
      .innerJoin(i, eq(i.id, l.invoiceId))
      .where(
        and(
          eq(l.deductionOf, anzahlung.id),
          eq(i.kind, "rechnung"),
          eq(i.status, "final"),
          sql`${i.lockedAt} > (select locked_at from invoices where id = ${original.id})`,
        ),
      )
      .orderBy(asc(i.lockedAt))
      .limit(1);
    // Leistungstag wie in Kz 43 und 48 (leistungstag in invoice-tax.ts)
    const ende = neu ? (neu.serviceDate ?? neu.issueDate) : null;
    const bezahlt = (await paymentEvents(await family(anzahlung.id, q), q)).flatMap((e) => (e.paid ? [{ date: e.date, paid: e.paid }] : []));
    zahlungen.push(...bisZumEnde(bezahlt, ende));
  }
  return { abzuege, zahlungen };
}
