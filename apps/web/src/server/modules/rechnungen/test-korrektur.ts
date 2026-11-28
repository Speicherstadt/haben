/**
 * Kürzt den Entwurf einer Rechnungskorrektur auf die Hälfte seiner Position, damit er nicht die ganze, noch unbezahlte
 * Ausgangsrechnung aufhebt. Seit #2037 weist Haben das beim Festschreiben ab, weil es ein Storno ist. Der Helfer lässt
 * den Testgegenstand unberührt, es ändert sich nur der Betrag der Korrektur.
 */
export async function kuerzeKorrektur(invoices: typeof import("./index.ts"), actor: string, korrekturId: string): Promise<void> {
  const { draftInputOf } = await import("./external-reference.ts");
  const geladen = (await invoices.getInvoice(korrekturId))!;
  const eingabe = draftInputOf(geladen.invoice, geladen.lines);
  await invoices.updateDraft(actor, korrekturId, {
    ...eingabe,
    lines: eingabe.lines.map((z, n) => (n === 0 ? { ...z, unitPrice: Math.floor(z.unitPrice / 2) } : z)),
  });
}
