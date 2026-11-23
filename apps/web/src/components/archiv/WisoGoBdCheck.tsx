import { formatEuro } from "@haben/core";
import type { WisoAccountDifference, WisoAccountTotals } from "@haben/import";
import { useServerFn } from "@tanstack/react-start";
import { type FormEvent, useState } from "react";
import { useAction } from "../../lib/use-action.ts";
import { checkWisoGoBd } from "../../server/functions/wiso-gobd.ts";
import { Field } from "../Field.tsx";
import { FilePicker } from "../FilePicker.tsx";
import { NoticeBanner } from "../NoticeBanner.tsx";

const FIELD_NAMES: Record<keyof WisoAccountTotals, string> = {
  openingDebit: "Anfangssaldo Soll",
  openingCredit: "Anfangssaldo Haben",
  movementDebit: "Buchungssumme Soll",
  movementCredit: "Buchungssumme Haben",
  balance: "Endsaldo (Soll positiv)",
};

type Comparison = Awaited<ReturnType<typeof checkWisoGoBd>>;

export function WisoGoBdCheck() {
  const check = useServerFn(checkWisoGoBd);
  const { busy, notice, setNotice, run } = useAction();
  const [result, setResult] = useState<Comparison | null>(null);

  function reset() {
    setResult(null);
    setNotice(null);
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    setResult(null);
    void run(async () => setResult(await check({ data })));
  }

  return (
    <section className="card stack" aria-labelledby="wiso-gobd-heading">
      <h2 id="wiso-gobd-heading" style={{ margin: 0 }}>
        WISO-GoBD-Dateien abgleichen
      </h2>
      <p className="small muted" style={{ margin: 0 }}>
        Wähle GoBD-Buchungsliste und Summen- und Saldenliste aus demselben Export. Der Abgleich speichert keine Dateien und ändert keine Buchungen.
      </p>
      <form className="stack" onSubmit={submit}>
        <Field label="GoBD-Buchungsliste">
          {(control) => <FilePicker {...control} name="bookings" accept=".csv" required disabled={busy} onChange={reset} />}
        </Field>
        <Field label="GoBD-Summen- und Saldenliste">
          {(control) => <FilePicker {...control} name="trialBalance" accept=".csv" required disabled={busy} onChange={reset} />}
        </Field>
        <div className="actions">
          <button type="submit" className="btn" disabled={busy}>
            {busy ? "Gleiche Dateien ab …" : "Dateien abgleichen"}
          </button>
        </div>
      </form>
      <NoticeBanner notice={notice} />
      {result && (
        <>
          <p role="status">
            {result.accounts} Konten geprüft.{" "}
            {result.differences.length > 0 ? `Abweichende Konten: ${result.differences.length}.` : "Buchungsliste und SuSa stimmen überein."}
          </p>
          {result.differences.length > 0 && <Differences differences={result.differences} />}
        </>
      )}
    </section>
  );
}

function Differences({ differences }: { differences: WisoAccountDifference[] }) {
  return (
    <div className="table-scroll">
      <table className="report-table" aria-label="Abweichungen je Konto">
        <thead>
          <tr>
            <th scope="col">Konto</th>
            <th scope="col">Merkmal</th>
            <th scope="col">GoBD-Buchungsliste</th>
            <th scope="col">SuSa</th>
          </tr>
        </thead>
        <tbody>
          {differences.flatMap(({ account, fields, bookingList, trialBalance }) =>
            fields.map((field) => (
              <tr key={`${account}-${field}`}>
                <th scope="row">{account}</th>
                <td>{FIELD_NAMES[field]}</td>
                <td className="num">{bookingList ? formatEuro(bookingList[field]) : "Konto fehlt"}</td>
                <td className="num">{trialBalance ? formatEuro(trialBalance[field]) : "Konto fehlt"}</td>
              </tr>
            )),
          )}
        </tbody>
      </table>
    </div>
  );
}
