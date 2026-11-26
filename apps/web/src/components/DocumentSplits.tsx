import { allocateSplitTax, formatDecimal, formatEuro, parseEuro, type ExpenseCategory } from "@haben/core";
import { parsePrivatanteil, privatanteilVorgabe } from "../lib/anteil.ts";
import { CategoryCombobox } from "./CategoryCombobox.tsx";
import { EigenesKontoWahl, passendesKonto, type OwnAccountChoice } from "./EigenesKontoWahl.tsx";
import { Field } from "./Field.tsx";

/*
 * Aufteilung eines Belegs auf mehrere Kategorien (#271): Zeilen mit Kategorie, Steuersatz und Netto. Die Vorsteuer je
 * Zeile verteilt Haben aus der Vorsteuer des Satzes (wie beim Speichern, allocateSplitTax); die Summen je Satz werden
 * laufend gegen die Beträge des Belegs geprüft. Seit #1914 trägt jede Zeile ihren eigenen Privatanteil, etwa Internet
 * 25 % und Telefon 40 % auf einem Beleg.
 */

type Rate = 1900 | 700 | 0;

export interface SplitRowState {
  key: number;
  category: ExpenseCategory | "";
  taxRate: Rate;
  net: string;
  /** Eigenes Sachkonto der Zeile (#270); leer = das Konto der Kategorie */
  ownAccountId: string;
  /** Privatanteil der Zeile in Prozent (#1914); leer = 0 */
  privateShare: string;
}

let nextSplitKey = 1;

export function splitRow(category: ExpenseCategory | "", taxRate: Rate, net: string, ownAccountId = "", privateShare = ""): SplitRowState {
  return { key: nextSplitKey++, category, taxRate, net, ownAccountId, privateShare };
}

/** Eingegebene Zeilen als Daten; null, wenn eine Zeile noch keine Kategorie, kein lesbares Netto oder keinen gültigen Anteil hat */
export function parseSplitRows(
  rows: SplitRowState[],
): { category: ExpenseCategory; taxRate: Rate; net: number; ownAccountId: string | null; privateShare: number }[] | null {
  const parsed = rows.map((row) => ({
    category: row.category,
    taxRate: row.taxRate,
    net: parseEuro(row.net || "0"),
    ownAccountId: row.ownAccountId || null,
    privateShare: parsePrivatanteil(row.privateShare),
  }));
  if (parsed.some((p) => p.category === "" || p.net === null || p.privateShare === null)) return null;
  return parsed.map((p) => ({
    category: p.category as ExpenseCategory,
    taxRate: p.taxRate,
    net: p.net!,
    ownAccountId: p.ownAccountId,
    privateShare: p.privateShare!,
  }));
}

/**
 * Privatanteil einer Zeile nach dem Wechsel ihrer Kategorie (#1914): die Vorgabe der neuen Kategorie aus den
 * Firmendaten, ohne Vorgabe leer (das zählt als 0), damit kein alter Wert stehen bleibt und das Feld keine 0 vortäuscht.
 * Wo es kein Feld gibt (GmbH und UG), bleibt er, wie er war.
 */
export function anteilBeimKategorieWechsel(shares: Partial<Record<string, number>>, kategorie: ExpenseCategory | "", bisher: string, sichtbar = true): string {
  if (!sichtbar) return bisher;
  return privatanteilVorgabe(shares, kategorie);
}

/**
 * Anteil für den Beleg beim Aufheben der Aufteilung (#1914): Mit Zeilen zählt der Anteil der Zeile; die erste Zeile gibt
 * ihn an den Beleg zurück, statt ihn stumm zu verlieren.
 */
export function anteilBeimAufheben(rows: SplitRowState[]): string {
  return rows[0]?.privateShare ?? "";
}

/**
 * Trägt eine Zeile einen lesbaren Privatanteil über 0 (#1914)? Eine ungültige Eingabe zählt nicht, sonst verschwände der
 * Hinweis, dass die Vorschau auf eine gültige Eingabe wartet.
 */
export function privatanteilInZeilen(rows: SplitRowState[]): boolean {
  return rows.some((row) => {
    const anteil = parsePrivatanteil(row.privateShare);
    return anteil !== null && anteil > 0;
  });
}

const percent = (rate: number) => `${rate / 100} %`;

export function DocumentSplits({
  rows,
  amounts,
  categories,
  ownAccounts = [],
  disabled,
  onChange,
  onDissolve,
  taxLabel = "Vorsteuer",
  /** Privatanteil je Zeile (#1914): nur im Einzelunternehmen, wie am Beleg ohne Aufteilung */
  privatanteil = false,
  /** Hinweis am Privatanteil der Zeile (#1914), gebildet wie privatanteilHinweis am Beleg: ohne Abzug nur die Ausgabe */
  anteilHinweis,
  /** Vorgaben der Firmendaten je Kategorie, die eine neue Kategorie in ihre Zeile übernimmt */
  privateShares = {},
  error = () => undefined,
}: {
  rows: SplitRowState[];
  /** Beträge des Belegs je Satz in Euro; null, solange ein Betrag oben nicht lesbar ist */
  amounts: { taxRate: Rate; net: number; tax: number }[] | null;
  categories: { value: string; label: string }[];
  /** Eigene Sachkonten (#270), je Zeile zur Kategorie wählbar */
  ownAccounts?: OwnAccountChoice[];
  /** Gebucht oder während der Auslesung: nur ansehen */
  disabled: boolean;
  onChange: (rows: SplitRowState[]) => void;
  /** Aufteilung aufheben: wieder eine Kategorie für den ganzen Beleg */
  onDissolve: () => void;
  /** Privatanteil je Zeile (#1914) anzeigen: nur im Einzelunternehmen */
  privatanteil?: boolean;
  /** Text am Privatanteil der Zeile (#1914), gebildet wie privatanteilHinweis am Beleg */
  anteilHinweis: string;
  /** Vorgaben der Firmendaten je Kategorie (Prozent), die eine gewählte Kategorie übernimmt */
  privateShares?: Partial<Record<string, number>>;
  /** Fehler je Zeile aus der Prüfung beim Buchen (useSubmitCheck), erst danach zu sehen */
  error?: (feld: "kategorie" | "netto" | "privatanteil", key: number) => string | undefined;
  /** Steuer je Zeile: Vorsteuer, ohne Abzug Umsatzsteuer (#978), bei § 13b (#508) die selbst geschuldete Steuer */
  taxLabel?: string;
}) {
  const parsed = rows.map((row) => parseEuro(row.net || "0"));
  const lines = parseSplitRows(rows);
  const allocated = lines && amounts ? allocateSplitTax(lines, amounts) : null;
  const rates = [...new Set([...(amounts ?? []).map((a) => a.taxRate), ...rows.map((r) => r.taxRate)])].sort((a, b) => b - a);
  // Anlagegüter werden über das Anlagenverzeichnis abgeschrieben und lassen sich nicht aufteilen
  const options = categories.filter((c) => c.value !== "anlage");

  const update = (key: number, patch: Partial<SplitRowState>) => onChange(rows.map((row) => (row.key === key ? { ...row, ...patch } : row)));

  return (
    <fieldset className="card" style={{ margin: 0 }} disabled={disabled} aria-describedby="split-hint">
      <legend style={{ fontWeight: 600, fontSize: 16, padding: 0, marginBottom: 4 }}>Aufteilung auf Kategorien</legend>
      <p id="split-hint" className="small muted" style={{ margin: 0 }}>
        Netto je Zeile; zusammen ergibt jeder Steuersatz das Netto des Belegs. Die {taxLabel} verteilt Haben anteilig, den Rundungscent bekommt die größte
        Zeile.
      </p>
      {rows.map((row, index) => (
        <div className="document-split-row" key={row.key}>
          <Field label="Kategorie" error={error("kategorie", row.key)}>
            {(control) => (
              <CategoryCombobox
                {...control}
                categories={options}
                value={row.category}
                onChoose={(next) =>
                  update(row.key, {
                    category: next as ExpenseCategory | "",
                    ownAccountId: passendesKonto(ownAccounts, next, row.ownAccountId),
                    // Vorgabe aus den Firmendaten, z. B. Internet 25 %; ohne Vorgabe 0
                    privateShare: anteilBeimKategorieWechsel(privateShares, next as ExpenseCategory | "", row.privateShare, privatanteil),
                  })
                }
              />
            )}
          </Field>
          <Field label="Satz">
            {(control) => (
              <select {...control} value={row.taxRate} onChange={(e) => update(row.key, { taxRate: Number(e.target.value) as Rate })}>
                <option value={1900}>19 %</option>
                <option value={700}>7 %</option>
                <option value={0}>0 %</option>
              </select>
            )}
          </Field>
          <Field label="Netto" hint={`${taxLabel} ${allocated ? formatDecimal(allocated[index]!.tax) : "–"}`} error={error("netto", row.key)}>
            {(control) => (
              <input
                {...control}
                className="mono"
                inputMode="decimal"
                value={row.net}
                placeholder="0,00"
                onChange={(e) => update(row.key, { net: e.target.value })}
              />
            )}
          </Field>
          <button
            type="button"
            className="icon-btn"
            aria-label={`Zeile ${index + 1} der Aufteilung entfernen`}
            disabled={rows.length <= 2}
            onClick={() => onChange(rows.filter((r) => r.key !== row.key))}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
              <path d="M6 6l12 12M18 6L6 18" />
            </svg>
          </button>
          <div style={{ gridColumn: "1 / -1", display: "flex", gap: 8, flexWrap: "wrap", alignItems: "flex-start" }}>
            <EigenesKontoWahl
              accounts={ownAccounts}
              category={row.category}
              value={row.ownAccountId}
              onChange={(ownAccountId) => update(row.key, { ownAccountId })}
              style={{ flex: "1 1 240px", minWidth: 0 }}
            />
            {privatanteil && (
              <Field label="Privatanteil in %" hint={anteilHinweis} error={error("privatanteil", row.key)} style={{ flex: "0 0 140px" }}>
                {(control) => (
                  <input
                    {...control}
                    inputMode="numeric"
                    value={row.privateShare}
                    placeholder="0"
                    onChange={(e) => update(row.key, { privateShare: e.target.value })}
                  />
                )}
              </Field>
            )}
          </div>
        </div>
      ))}
      <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
        <button
          type="button"
          className="btn btn-dashed"
          disabled={rows.length >= 50}
          onClick={() => onChange([...rows, splitRow("", rows.at(-1)?.taxRate ?? 1900, "")])}
        >
          + Zeile
        </button>
        <button type="button" className="btn" onClick={onDissolve}>
          Aufteilung aufheben
        </button>
      </div>
      <ul className="small" aria-live="polite" style={{ margin: 0, paddingLeft: 20 }}>
        {rates.map((rate) => {
          const target = amounts?.find((a) => a.taxRate === rate)?.net ?? 0;
          const sum = rows.reduce((s, row, i) => (row.taxRate === rate ? s + (parsed[i] ?? 0) : s), 0);
          const rest = target - sum;
          return (
            <li key={rate}>
              {percent(rate)}: Zeilen {formatEuro(sum)} von {formatEuro(target)} netto
              {amounts === null ? "" : rest === 0 ? " · stimmt" : rest > 0 ? ` · noch ${formatEuro(rest)} zu verteilen` : ` · ${formatEuro(-rest)} zu viel`}
            </li>
          );
        })}
      </ul>
    </fieldset>
  );
}
