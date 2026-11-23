import { heikleDateien } from "../pr-regeln/regel.ts";

/*
 * Vorschlag für die Rangliste der offenen Pull Requests (Skill `prs-abarbeiten`, Schritt 2) aus dem, was sich ohne
 * Lesen des Diffs entscheiden lässt. Platz 1 („Fertig“) erkennt kein Skript, weil er eine Prüfung voraussetzt; den
 * setzt der Agent nach dem Lesen. Ob ein roter Check auf `main` genauso rot ist, prüft der Agent ebenfalls.
 */

export type Check = { name?: string; conclusion?: string | null; status?: string | null; state?: string | null };
export type Kommentar = { author: { login: string }; body: string; createdAt: string };
export type PullRequest = {
  number: number;
  title: string;
  author: { login: string };
  isDraft: boolean;
  isCrossRepository: boolean;
  mergeable: string;
  headRefOid: string;
  createdAt: string;
  files: { path: string }[];
  statusCheckRollup: Check[];
  comments: Kommentar[];
  commits: { committedDate: string }[];
};

export type Ci = "grün" | "rot" | "läuft" | "nicht gelaufen";
export type Lage = {
  number: number;
  title: string;
  platz: 2 | 3 | 4 | 5 | 6 | 7;
  ci: Ci;
  roteChecks: string[];
  heikel: boolean;
  migrationen: string[];
  dateien: number;
  grund: string;
};

/** Ab so vielen Dateien gilt ein Pull Request als groß (Platz 3) */
export const GROSS = 15;
const ROT = ["FAILURE", "ERROR", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED", "STARTUP_FAILURE"];

export function ci(checks: Check[]): { ci: Ci; rot: string[] } {
  if (checks.length === 0) return { ci: "nicht gelaufen", rot: [] };
  const rot = checks.filter((c) => ROT.includes(c.conclusion ?? c.state ?? "")).map((c) => c.name ?? "?");
  if (rot.length > 0) return { ci: "rot", rot };
  const offen = checks.some((c) => (c.status && c.status !== "COMPLETED") || c.state === "PENDING");
  return { ci: offen ? "läuft" : "grün", rot: [] };
}

/** Neue Migrationen: SQL-Dateien in apps/web/drizzle/, nicht meta/ */
export function migrationen(files: { path: string }[]): string[] {
  return files.map((f) => f.path).filter((p) => /^apps\/web\/drizzle\/[^/]+\.sql$/.test(p));
}

/** Selbstprüfung (beitrag-pruefen, Vorlage „Selbstprüfung“), die den Head als Stand oder im Nachtrag nennt */
export function selbstpruefungAktuell(kommentare: Kommentar[], head: string): boolean {
  const kurz = head.slice(0, 7);
  return kommentare.some((k) => k.body.includes("## Selbstprüfung (beitrag-pruefen)") && k.body.includes(kurz));
}

export function lage(pr: PullRequest, maintainer: string[]): Lage {
  const { ci: stand, rot } = ci(pr.statusCheckRollup);
  const dateien = pr.files.map((f) => f.path);
  const heikel = heikleDateien(dateien).length > 0;
  const neu = migrationen(pr.files);
  const letzterCommit =
    pr.commits
      .map((c) => c.committedDate)
      .sort()
      .at(-1) ?? pr.createdAt;
  // Beim eigenen Pull Request eines Maintainers sind seine Kommentare die des Autors, keine Befunde an ihn
  const unsere = pr.comments
    .filter((k) => k.author.login !== pr.author.login && maintainer.includes(k.author.login))
    .map((k) => k.createdAt)
    .sort();
  const unserLetzter = unsere.at(-1);
  const basis = { number: pr.number, title: pr.title, ci: stand, roteChecks: rot, heikel, migrationen: neu, dateien: dateien.length };

  // Nachbesserungen auf unsere Befunde kommen vor fehlenden Prüfungen (prs-abarbeiten, Platz 7)
  if (unserLetzter && letzterCommit > unserLetzter) return { ...basis, platz: 4, grund: "neue Commits seit unserem letzten Kommentar" };
  if (unserLetzter) return { ...basis, platz: 6, grund: "unser Kommentar ist das Letzte, wartet auf den Autor" };
  if (pr.isCrossRepository && !selbstpruefungAktuell(pr.comments, pr.headRefOid))
    return { ...basis, platz: 7, grund: "Selbstprüfung fehlt oder nennt den letzten Commit nicht" };
  if (pr.mergeable === "CONFLICTING") return { ...basis, platz: 5, grund: "Konflikt mit main" };
  if (stand === "rot") return { ...basis, platz: 5, grund: `rot: ${rot.join(", ")} (auf main genauso?)` };
  if (heikel || neu.length > 0 || dateien.length >= GROSS)
    return { ...basis, platz: 3, grund: [heikel && "heikel", neu.length > 0 && "Migration", dateien.length >= GROSS && "groß"].filter(Boolean).join(", ") };
  return { ...basis, platz: 2, grund: "klein, nicht heikel" };
}

/** Ohne Entwürfe, nach Platz, gleich einfache nach Alter */
export function rangliste(prs: PullRequest[], maintainer: string[]): Lage[] {
  const alter = new Map(prs.map((pr) => [pr.number, pr.createdAt]));
  return prs
    .filter((pr) => !pr.isDraft)
    .map((pr) => lage(pr, maintainer))
    .sort((a, b) => a.platz - b.platz || (alter.get(a.number) ?? "").localeCompare(alter.get(b.number) ?? ""));
}
