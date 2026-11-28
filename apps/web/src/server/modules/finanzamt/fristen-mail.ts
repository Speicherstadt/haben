import { germanDay, tageBis } from "@haben/core";
import { and, eq } from "drizzle-orm";
import { db, schema } from "../../db/index.ts";
import { baseUrl, berlinHour, escapeHtml, loadMailSettings, MAIL_ACTOR, MailError, send } from "../mail/index.ts";
import { type UngueltigeUstId, ungueltigeUstIdNrn } from "../umsatzsteuer/index.ts";
import { listFristen, type Frist } from "./fristen.ts";

/**
 * Erinnerungen an Steuerfristen per E-Mail; Versand und Protokoll über mail. Dazu einmal je Antwort jede USt-IdNr. eines
 * Kunden, die das BZSt nicht gültig nennt (#1489), auch wenn gerade keine Frist ansteht.
 */

/** Zeile, die in jeder Erinnerung unten steht, etwa die Warnung vor dem Mindestbestand (#1381); link ist ein Pfad in Haben */
export interface MailHinweis {
  text: string;
  link: string;
}

function datum(iso: string): string {
  return `${iso.slice(8, 10)}.${iso.slice(5, 7)}.${iso.slice(0, 4)}`;
}

function wann(tage: number): string {
  if (tage < 0) return `seit ${-tage} Tag${tage === -1 ? "" : "en"} überfällig`;
  if (tage === 0) return "heute";
  if (tage === 1) return "morgen";
  return `in ${tage} Tagen`;
}

/** Betreff: die Frist, sonst die Zahl der Fristen, ohne Fristen die USt-IdNrn. */
function betreff(neu: { frist: Frist; tage: number }[], ustIds: readonly UngueltigeUstId[]): string {
  if (neu.length === 1) return `Frist ${wann(neu[0]!.tage)}: ${neu[0]!.frist.titel}`;
  if (neu.length > 1) return `${neu.length} Steuerfristen stehen an`;
  return ustIds.length === 1 ? `USt-IdNr. von ${ustIds[0]!.kontakt} laut BZSt nicht gültig` : `${ustIds.length} USt-IdNrn. laut BZSt nicht gültig`;
}

/**
 * Inhalt einer Erinnerung; neu: was heute erinnert wird, ustIds: ungültige Nummern, die noch in keiner Mail standen,
 * hinweis: steht unter den Fristen, löst selbst keine Mail aus
 */
function fristenMail(neu: { frist: Frist; tage: number }[], ustIds: readonly UngueltigeUstId[], today: string, hinweis: MailHinweis | null) {
  const zeilen = neu.map(({ frist, tage }) => ({ frist, text: `${datum(frist.datum)} (${wann(tage)}): ${frist.titel}` }));
  const nummern = ustIds.map((u) => ({
    link: `${baseUrl()}/kontakte/${u.contactId}`,
    text: `${u.nummer} (${u.kontakt}): ${u.meldung}, Antwort vom ${datum(germanDay(u.anfrageZeitpunkt))}`,
  }));
  const ustIdTitel = "USt-IdNr. laut BZSt nicht gültig; vor der nächsten Leistung mit dem Kunden klären:";
  const text = [
    `Erinnerung von Haben, Stand ${datum(today)}:`,
    "",
    ...zeilen.map(({ frist, text }) => `- ${text}\n  ${frist.detail}\n  ${baseUrl()}${frist.link}`),
    ...(nummern.length ? [...(zeilen.length ? [""] : []), ustIdTitel, ...nummern.map((n) => `- ${n.text}\n  ${n.link}`)] : []),
    ...(hinweis ? ["", `${hinweis.text}\n${baseUrl()}${hinweis.link}`] : []),
    "",
    `Alle Fristen: ${baseUrl()}/fristen`,
  ].join("\n");
  const liste = (eintraege: string[]) => (eintraege.length ? ["<ul>", ...eintraege, "</ul>"] : []);
  const html = [
    `<p>Erinnerung von Haben, Stand ${datum(today)}:</p>`,
    ...liste(
      zeilen.map(
        ({ frist, text }) => `<li><a href="${escapeHtml(baseUrl() + frist.link)}">${escapeHtml(text)}</a><br><small>${escapeHtml(frist.detail)}</small></li>`,
      ),
    ),
    ...(nummern.length
      ? [`<p>${escapeHtml(ustIdTitel)}</p>`, ...liste(nummern.map((n) => `<li><a href="${escapeHtml(n.link)}">${escapeHtml(n.text)}</a></li>`))]
      : []),
    ...(hinweis ? [`<p><a href="${escapeHtml(baseUrl() + hinweis.link)}">${escapeHtml(hinweis.text)}</a></p>`] : []),
    `<p><a href="${escapeHtml(`${baseUrl()}/fristen`)}">Alle Fristen in Haben</a></p>`,
  ].join("\n");
  return { subject: betreff(neu, ustIds), text, html };
}

/** Schlüssel, zu denen schon erfolgreich erinnert wurde */
async function sentReminderKeys(): Promise<Set<string>> {
  const rows = await db
    .select({ keys: schema.mailLog.reminderKeys })
    .from(schema.mailLog)
    .where(and(eq(schema.mailLog.kind, "fristen"), eq(schema.mailLog.ok, true)));
  return new Set(rows.flatMap((r) => r.keys));
}

/**
 * Für den Scheduler: Erinnert an offene Fristen, die heute genau eine der eingestellten Tageszahlen entfernt
 * sind, und an überfällige einmal. Jede Frist und Stufe nur einmal; mehrere Fristen in einer Mail.
 * Verpasste Stufen (Server war aus) holt der nächste Lauf nach, solange die Frist noch nicht vorbei ist. `hinweis` fragt
 * der Lauf nur, wenn er ohnehin eine Mail schickt; der Scheduler gibt die Warnung vor dem Mindestbestand mit, weil
 * liquiditaet über finanzamt liegt.
 */
export async function runDueFristenMails(today: string, now = new Date(), hinweis: () => Promise<MailHinweis | null> = async () => null) {
  const settings = await loadMailSettings();
  if (!settings?.remindersEnabled || berlinHour(now) < 7) return null;
  const stufen = [...settings.reminderDays].sort((a, b) => b - a);
  const [fristen, sent, ungueltig] = await Promise.all([listFristen(today), sentReminderKeys(), ungueltigeUstIdNrn(today)]);
  const neu: { frist: Frist; tage: number; key: string }[] = [];
  for (const frist of fristen) {
    if (frist.status === "erledigt") continue;
    const tage = tageBis(frist.datum, today);
    if (tage < 0) {
      // Überfällig: einmal erinnern, außer bei Zahlungshinweisen und abgelaufenen Einspruchsfristen
      const key = `${frist.id}:ueberfaellig`;
      if (frist.status === "offen" && frist.art !== "einspruch" && !sent.has(key)) neu.push({ frist, tage, key });
      continue;
    }
    // Die engste Stufe, die schon erreicht ist; frühere, noch nicht gesendete Stufen entfallen
    const stufe = stufen.filter((s) => tage <= s).at(-1);
    if (stufe === undefined) continue;
    const key = `${frist.id}:${stufe}`;
    if (!sent.has(key)) neu.push({ frist, tage, key });
  }
  // Je Antwort einmal: Eine neue ungültige Antwort zur selben Nummer erinnert wieder
  const ustIds = ungueltig.filter((u) => !sent.has(`ustid:${u.bestaetigungId}`));
  if (neu.length === 0 && ustIds.length === 0) return { sent: 0 };
  // Ein Fehler im Hinweis hält die Erinnerung an Fristen nicht auf
  const zusatz = await hinweis().catch((error: unknown) => {
    console.warn("Fristen-Erinnerung: Hinweis nicht berechnet", error);
    return null;
  });
  const mail = fristenMail(neu, ustIds, today, zusatz);
  const reminderKeys = [...neu.map((n) => n.key), ...ustIds.map((u) => `ustid:${u.bestaetigungId}`)];
  const result = await send(MAIL_ACTOR, { kind: "fristen", to: settings.reminderTo, ...mail, reminderKeys });
  if (!result.ok) throw new MailError(`Erinnerung nicht gesendet: ${result.error}`);
  return { sent: neu.length };
}
