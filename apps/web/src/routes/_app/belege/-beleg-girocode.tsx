import { formatEuro, formatPercent } from "@haben/core";
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { EinklappAbschnitt } from "../../../components/firma/EinklappAbschnitt.tsx";
import { formatDate } from "../../../lib/format.ts";
import type { Detail } from "./-beleg-vorschau.tsx";

type Girocode = NonNullable<Detail["girocode"]>;

/** IBAN in Vierergruppen, wie unter Überweisungen */
const groupedIban = (iban: string) => iban.replace(/(.{4})/g, "$1 ").trim();

/**
 * „Zum Überweisen“ an einem offenen Beleg (#1967): GiroCode für die Banking-App mit denselben Angaben wie die SEPA-Datei,
 * läuft ein Skonto, wahlweise abzüglich Skonto. Kann Haben nicht überweisen, steht dort der Grund statt eines Codes.
 */
export function BelegGirocode({ code, contactId }: { code: Girocode; contactId: string | null }) {
  const [offen, setOffen] = useState(false);
  const [mitSkonto, setMitSkonto] = useState(false);
  const variante = (mitSkonto && code.varianten[1]) || code.varianten[0];
  // Der Betrag in der Überschrift nur mit Code: ohne (etwa bei Fremdwährung) stünde dort ein Betrag, den niemand überweist
  return (
    <EinklappAbschnitt
      id="beleg-girocode"
      titel="Zum Überweisen"
      kurz={variante ? formatEuro(variante.amount) : undefined}
      offen={offen}
      onOffen={setOffen}
      ebene={2}
    >
      {variante ? (
        <div className="stack">
          {code.varianten.length > 1 && <SkontoWahl code={code} mitSkonto={mitSkonto} onChange={setMitSkonto} />}
          <div className="girocode-bild">
            <img
              src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(variante.svg)}`}
              width={200}
              height={200}
              alt={`GiroCode: ${formatEuro(variante.amount)} an ${code.name}`}
            />
          </div>
          <dl className="facts">
            <dt>Empfänger</dt>
            <dd>{code.name}</dd>
            <dt>IBAN</dt>
            <dd className="mono">{groupedIban(code.iban ?? "")}</dd>
            <dt>Betrag</dt>
            <dd className="amount">{formatEuro(variante.amount)}</dd>
            <dt>Verwendungszweck</dt>
            <dd style={{ overflowWrap: "anywhere" }}>{variante.remittance}</dd>
          </dl>
          <p className="small muted" style={{ margin: 0 }}>
            Mit der Banking-App scannen und dort freigeben. Haben bucht dabei nichts: Bezahlt ist der Beleg, sobald der <Link to="/bank">Bankabgleich</Link> die
            Abbuchung zuordnet.
          </p>
        </div>
      ) : (
        <p style={{ margin: 0 }}>
          {code.problem}.
          {code.problemImKontakt && contactId && (
            <>
              {" "}
              <Link to="/kontakte/$id" params={{ id: contactId }}>
                Zum Kontakt
              </Link>
            </>
          )}
        </p>
      )}
    </EinklappAbschnitt>
  );
}

/** Offener Betrag oder abzüglich Skonto, mit der Frist */
function SkontoWahl({ code, mitSkonto, onChange }: { code: Girocode; mitSkonto: boolean; onChange: (on: boolean) => void }) {
  const [ohne, mit] = code.varianten;
  if (!ohne || !mit?.skonto) return null;
  return (
    <fieldset style={{ border: 0, margin: 0, padding: 0 }}>
      <legend className="small muted">Betrag</legend>
      <label className="checkbox">
        <input type="radio" name="girocode-betrag" checked={!mitSkonto} onChange={() => onChange(false)} />
        Offener Betrag {formatEuro(ohne.amount)}
      </label>
      <label className="checkbox">
        <input type="radio" name="girocode-betrag" checked={mitSkonto} onChange={() => onChange(true)} />
        Mit {formatPercent(mit.skonto.percent)} Skonto bis {formatDate(mit.skonto.until)}: {formatEuro(mit.amount)}
      </label>
    </fieldset>
  );
}
