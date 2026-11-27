import type { SelfAssessedTax } from "@haben/core";
import { Link } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useEffect, useState } from "react";
import { ustIdVorBuchenFn, ustIdVorFestschreibenFn } from "../server/functions/ustid-bestaetigung.ts";

type Stand = "laeuft" | { hinweis: string | null; sperrt?: true } | null;

/** Prüft beim Öffnen der Rückfrage und bei jedem neuen Schlüssel; ohne Schlüssel nichts */
function usePruefung(open: boolean, schluessel: string | null, pruefe: () => Promise<{ hinweis: string | null; sperrt?: true }>): Stand {
  const [stand, setStand] = useState<Stand>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: nur das Öffnen und der Schlüssel lösen eine Prüfung aus
  useEffect(() => {
    if (!open || !schluessel) {
      setStand(null);
      return;
    }
    let offen = true;
    setStand("laeuft");
    pruefe().then(
      (ergebnis) => offen && setStand(ergebnis),
      () => offen && setStand(null),
    );
    return () => {
      offen = false;
    };
  }, [open, schluessel]);
  return stand;
}

/**
 * Nachsatz zum Hinweis: Meist geht die Aktion trotzdem. Sperrt die Nummer das Festschreiben selbst (`sperrt`, etwa ATU1234
 * bei Reverse Charge), sagt er das, statt „geht trotzdem“ zu versprechen, das der Server dann ablehnt.
 */
export const hinweisNachsatz = (sperrt: boolean | undefined, trotzdem: string): string =>
  sperrt ? "Festschreiben geht erst, wenn die USt-IdNr. am Kontakt stimmt" : trotzdem;

function Hinweis({ stand, wer, trotzdem, contactId }: { stand: Stand; wer: string; trotzdem: string; contactId: string | null }) {
  if (stand === "laeuft") {
    return (
      <p className="small muted" role="status">
        Frage beim BZSt, ob die USt-IdNr. {wer} gültig ist …
      </p>
    );
  }
  if (!stand?.hinweis) return null;
  return (
    <div className={stand.sperrt ? "banner banner-danger" : "banner banner-warn"} role="status">
      <span>
        {stand.hinweis} {hinweisNachsatz(stand.sperrt, trotzdem)}
        {contactId ? (
          <>
            ; alle Antworten stehen beim{" "}
            <Link to="/kontakte/$id" params={{ id: contactId }}>
              Kontakt
            </Link>
            .
          </>
        ) : (
          "."
        )}
      </span>
    </div>
  );
}

/**
 * Hinweis in der Rückfrage zum Festschreiben einer Rechnung mit Reverse Charge oder innergemeinschaftlicher Lieferung (#1385).
 * Beim Öffnen fragt der Server das BZSt, wenn die Nummer des Kunden nicht frisch bestätigt ist (bei Reverse Charge mit Name und Ort).
 * Ein Hinweis sperrt das Festschreiben nicht; sperrt die Nummer es selbst (treatmentIssues), steht das statt „geht trotzdem“ da,
 * und onSperre meldet es, damit die Rückfrage den Knopf sperrt, statt einen Klick zuzulassen, den der Server ablehnt.
 */
export function UstIdVorFestschreiben({
  open,
  contactId,
  behandlung,
  onSperre,
}: {
  open: boolean;
  contactId: string;
  behandlung: "reverse_charge" | "ig_lieferung";
  onSperre?: (sperrt: boolean) => void;
}) {
  const pruefe = useServerFn(ustIdVorFestschreibenFn);
  const stand = usePruefung(open, contactId && `${contactId}:${behandlung}`, () => pruefe({ data: { contactId, behandlung } }));
  const sperrt = stand !== "laeuft" && stand?.sperrt === true;
  // biome-ignore lint/correctness/useExhaustiveDependencies: nur ein neues Ergebnis der Prüfung zählt, nicht ein neuer Callback
  useEffect(() => onSperre?.(sperrt), [sperrt]);
  return <Hinweis stand={stand} wer="des Kunden" trotzdem="Festschreiben geht trotzdem" contactId={contactId} />;
}

/** Nur beim innergemeinschaftlichen Erwerb und bei § 13b für eine EU-Leistung; Drittland und normale Belege nicht (#1490) */
export const ustIdVorBuchenNoetig = (reverseCharge: SelfAssessedTax | null): reverseCharge is "ig_erwerb" | "eu" =>
  reverseCharge === "ig_erwerb" || reverseCharge === "eu";

/**
 * Hinweis in der Rückfrage zum Buchen eines Belegs (#1490), mit dem Stand im Formular: Ist die USt-IdNr. des Lieferanten
 * nicht frisch bestätigt, fragt der Server das BZSt einfach. Ein Hinweis sperrt das Buchen nicht.
 */
export function UstIdVorBuchen({
  open,
  reverseCharge,
  contactId,
  ustId,
}: {
  open: boolean;
  reverseCharge: SelfAssessedTax | null;
  contactId: string | null;
  ustId: string;
}) {
  const pruefe = useServerFn(ustIdVorBuchenFn);
  const behandlung = ustIdVorBuchenNoetig(reverseCharge) && (contactId || ustId.trim()) ? reverseCharge : null;
  const stand = usePruefung(open, behandlung && `${behandlung}:${contactId}:${ustId}`, () =>
    behandlung ? pruefe({ data: { contactId, ustId, behandlung } }) : Promise.resolve({ hinweis: null }),
  );
  return <Hinweis stand={stand} wer="des Lieferanten" trotzdem="Buchen geht trotzdem" contactId={contactId} />;
}
