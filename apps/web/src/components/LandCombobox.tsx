import { laenderAuswahl, landName } from "@haben/core";
import { useState } from "react";
import { searchOptions, type SearchResult } from "../lib/combobox.ts";
import { Combobox } from "./Combobox.tsx";
import type { FieldControlProps } from "./Field.tsx";

type Land = { code: string; name: string };

/**
 * Suche nach deutschem Namen oder Code. Ein genau getippter Code steht vorn: Bei „ES“ fänden sich sonst Estland und
 * Eswatini vor Spanien, weil ihre Namen mit denselben Buchstaben beginnen.
 */
export function landSuche(auswahl: readonly Land[], query: string, limit?: number): SearchResult<Land> {
  const result = searchOptions(auswahl, query, (l) => [l.name, l.code], limit);
  const code = query.trim().toUpperCase();
  const genau = result.hits.find((l) => l.code === code);
  return genau ? { ...result, hits: [genau, ...result.hits.filter((l) => l !== genau)] } : result;
}

/**
 * Land als Auswahl mit Suche (#914). Im Feld steht der Name, gespeichert wird der Code über das versteckte Feld `name`,
 * damit das Formular ihn wie zuvor aus FormData liest. Ein gespeicherter Code, den die Liste nicht kennt, bleibt wählbar.
 * Wer tippt, ohne zu wählen, behält beim Verlassen das bisherige Land.
 */
export function LandCombobox({ name, value, onChoose, ...control }: FieldControlProps & { name: string; value: string; onChoose: (code: string) => void }) {
  const [query, setQuery] = useState<string | null>(null);
  const auswahl = laenderAuswahl(value);
  return (
    <>
      <Combobox
        {...control}
        commitOnTab
        value={query ?? landName(value)}
        onInput={setQuery}
        search={() => landSuche(auswahl, query ?? "")}
        describe={(l) => ({ key: l.code, label: l.name, meta: l.code, selected: l.code === value })}
        onPick={(l) => {
          setQuery(null);
          onChoose(l.code);
        }}
        placeholder="Land suchen"
        onBlur={() => setQuery(null)}
      />
      <input type="hidden" name={name} value={value} />
    </>
  );
}
