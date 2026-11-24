import { formatEuro } from "@haben/core";
import type { getVatPeriod } from "../../server/functions/vat.ts";
import { EinklappAbschnitt } from "../firma/EinklappAbschnitt.tsx";
import type { ElsterSetup } from "../ElsterSubmit.tsx";
import { DauerfristCard } from "./DauerfristCard.tsx";
import { VatFrequencyCard } from "./VatFrequencyCard.tsx";
import { zeitraumKurz } from "./zeitraum-kurz.ts";

type Seite = Awaited<ReturnType<typeof getVatPeriod>>;

/** Was eingestellt ist, für die Überschrift des zugeklappten Bereichs: „2026: monatlich · Dauerfristverlängerung besteht, Sondervorauszahlung 1.200,00 €“ */
export function fristenKurz(frequency: Seite["frequency"], dauerfrist: Seite["dauerfrist"]): string {
  const sondervorauszahlung = dauerfrist.own?.sondervorauszahlung;
  // Befreit gibt es keine Dauerfristverlängerung, die Karte sagt es auch
  const dauer =
    dauerfrist.frequency === "keine"
      ? ""
      : dauerfrist.active
        ? `Dauerfristverlängerung besteht${sondervorauszahlung ? `, Sondervorauszahlung ${formatEuro(sondervorauszahlung)}` : ""}`
        : "Dauerfristverlängerung nicht eingetragen";
  return [`${frequency.year}: ${zeitraumKurz(frequency)}`, dauer].filter(Boolean).join(" · ");
}

/**
 * Voranmeldungszeitraum und Dauerfristverlängerung eingeklappt (#1253): Beides stellt man selten um. `offen` und `onOffen` hält die
 * Seite, damit sie den Bereich aufklappen kann, wenn der Zeitraum nicht zur Voranmeldung passt. Die Karten bleiben zugeklappt im
 * Seitenbaum, ihre Eingaben und Meldungen gehen beim Zuklappen nicht verloren.
 */
export function FristenAbschnitt({
  frequency,
  dauerfrist,
  setup,
  offen,
  onOffen,
}: {
  frequency: Seite["frequency"];
  dauerfrist: Seite["dauerfrist"];
  setup: ElsterSetup & { companyIssues: string[] };
  offen: boolean;
  onOffen: (offen: boolean) => void;
}) {
  return (
    <EinklappAbschnitt id="ust-fristen" titel="Fristen und Zeitraum ändern" kurz={fristenKurz(frequency, dauerfrist)} offen={offen} onOffen={onOffen}>
      <div className="grid-main">
        <VatFrequencyCard key={frequency.year} frequency={frequency} />
        <DauerfristCard key={`dauerfrist-${dauerfrist.year}`} overview={dauerfrist} setup={setup} />
      </div>
    </EinklappAbschnitt>
  );
}
