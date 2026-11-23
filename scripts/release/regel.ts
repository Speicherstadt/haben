/*
 * Vorschau auf ein Release (Skill `release`, Schritte 1 bis 3) ohne Zugriff auf GitHub: Art des Releases, Hinweise
 * aus den Abschnitten „## Für das Release“ der Squash-Commits. Welche Issues geschlossen werden, rechnet
 * scripts/board/regel.ts (zuSchliessen) wie beim echten Release.
 */

export type Commit = { titel: string; text: string };

const RC = /^v\d+\.\d+\.\d+-rc\.\d+$/;
export const istRc = (tag: string) => RC.test(tag);

/** Abschnitt „## Für das Release“ bis zur nächsten Überschrift `##`, „🤖“, `---` oder `Co-authored-by:` (docs/mitwirken.md) */
export function hinweis(text: string): string | null {
  const zeilen = text.split("\n");
  const start = zeilen.findIndex((z) => /^## Für das Release/.test(z));
  if (start < 0) return null;
  const ende = zeilen.findIndex((z, i) => i > start && /^(## |🤖|---|co-authored-by:)/i.test(z));
  return zeilen
    .slice(start + 1, ende < 0 ? undefined : ende)
    .join("\n")
    .trim();
}

/** Je Pull Request mit Hinweis eine Überschrift mit seinem Titel */
export function hinweise(commits: Commit[]): string {
  return commits
    .flatMap(({ titel, text }) => {
      const h = hinweis(text);
      return h ? [`### ${titel}\n${h}\n`] : [];
    })
    .join("\n");
}

/** Wofür es erst einen Release Candidate braucht (Skill `release`, Schritt 2) */
export const NUR_MIT_RC = [/^apps\/web\/drizzle\/[^/]+\.sql$/, /^packages\/(elster|gobd-kern)\//];

export type Art = { vorschlag: string; grund: string };

/**
 * `letzterTag` ist der jüngste Tag, `dateien` die seit der vorigen fertigen Version geänderten (neu angelegte
 * Migrationen eingeschlossen). Ob neue Funktionen dabei sind, sieht man nur an den Titeln; der Agent wählt dann
 * zwischen den genannten Arten.
 */
export function art(letzterTag: string | null, dateien: string[]): Art {
  if (letzterTag && istRc(letzterTag))
    return { vorschlag: "prerelease oder patch", grund: `${letzterTag} läuft: prerelease für einen weiteren RC, patch, wenn er beim Maintainer stabil ist` };
  const rcGrund = dateien.filter((d) => NUR_MIT_RC.some((m) => m.test(d)));
  if (rcGrund.length > 0)
    return {
      vorschlag: "preminor oder prepatch",
      grund: `erst ein RC wegen ${rcGrund.slice(0, 3).join(", ")}${rcGrund.length > 3 ? ` und ${rcGrund.length - 3} weiteren` : ""}; preminor bei neuen Funktionen`,
    };
  return { vorschlag: "minor oder patch", grund: "kein RC nötig; minor bei neuen Funktionen, patch bei nur Fixes und Doku" };
}
