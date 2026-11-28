import { useEffect, useState } from "react";
import { authClient } from "../lib/auth-client.ts";
import { weiterNachAnmeldung } from "../lib/weiter.ts";

/** Hinweise zu ?sso=… nach einem abgewiesenen Callback; der Grund kommt vom Server, nie mit Details zur Identität */
const ssoReasons = (provider: string): Record<string, string> => ({
  profil: "Die SSO-Anmeldung liefert kein vollständiges Profil mit gültiger E-Mail-Adresse. Bitte den Betreiber fragen.",
  "gruppen-doppelt": "Kein Zugang: Dein Konto gehört beiden Haben-Gruppen an. Bitte die Zuordnung beim Anbieter korrigieren lassen.",
  gruppe: `Kein Zugang: Dein Konto ist in ${provider} keiner Haben-Gruppe eindeutig zugeordnet. Bitte den Betreiber fragen.`,
  "nicht-eingerichtet": "Haben ist noch nicht eingerichtet. Die erste Anmeldung muss ein Inhaber übernehmen.",
  "konto-vorhanden":
    "Zu dieser E-Mail gibt es schon ein Haben-Konto ohne passende SSO-Zuordnung. Der Betreiber kann es mit der SSO-Übernahme ausdrücklich zuordnen.",
  fehler: "Die SSO-Anmeldung ist fehlgeschlagen. Bitte erneut versuchen oder den Betreiber fragen.",
});

export function ssoReasonMessage(search: string, provider: string): string | null {
  const reason = new URLSearchParams(search).get("sso");
  const reasons = ssoReasons(provider);
  return reason ? (reasons[reason] ?? reasons.fehler!) : null;
}

/** Höchstens einmal je Minute startet die erneute Anmeldung nach Ablauf der Frist von selbst */
export const ERNEUT_PAUSE_MS = 60_000;
const ERNEUT_SCHLUESSEL = "haben.sso-erneut";

/**
 * Ob die Anmeldung von selbst starten soll: aus dem Firmenportal (#504) mit ?anmelden=sso, nach Ablauf der Frist (#2048)
 * mit ?anmelden=erneut. Nicht nach einem abgewiesenen Callback (?sso=…), sonst ginge es im Kreis. Die erneute Anmeldung
 * zusätzlich nur, wenn ihr letzter Start (`letzterStart`, ms) länger als eine Minute zurückliegt: Gilt die neue Sitzung
 * gleich wieder nicht, etwa bei falsch gehender Uhr, bleibt es bei der Anmeldeseite.
 */
export const ssoAutoStart = (search: string, letzterStart: number | null = null, jetzt = Date.now()): boolean => {
  const params = new URLSearchParams(search);
  if (params.has("sso")) return false;
  if (params.get("anmelden") === "sso") return true;
  return params.get("anmelden") === "erneut" && (letzterStart === null || jetzt - letzterStart >= ERNEUT_PAUSE_MS);
};

/** Merkt sich den Start der erneuten Anmeldung im Speicher des Tabs; ohne ihn (gesperrt) startet sie nicht von selbst */
function startetVonSelbst(search: string): boolean {
  if (new URLSearchParams(search).get("anmelden") !== "erneut") return ssoAutoStart(search);
  try {
    const wert = Number(window.sessionStorage.getItem(ERNEUT_SCHLUESSEL));
    if (!ssoAutoStart(search, wert > 0 ? wert : null)) return false;
    window.sessionStorage.setItem(ERNEUT_SCHLUESSEL, String(Date.now()));
    return true;
  } catch {
    return false;
  }
}

/**
 * Einziger Weg hinein im SSO-Modus: startet die Anmeldung beim konfigurierten Anbieter, ohne weitere Angaben. Mit `weiter`
 * geht es danach zu ?weiter=… (eigene Seite, etwa die Zustimmungsseite eines KI-Assistenten), sonst zur Startseite. Mit
 * `autoStart` (Login-Seite) startet sie bei ?anmelden=sso oder ?anmelden=erneut von selbst (siehe `ssoAutoStart`).
 */
export function SsoSignIn({ name, label, weiter = false, autoStart = false }: { name: string; label?: string; weiter?: boolean; autoStart?: boolean }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reason, setReason] = useState<string | null>(null);
  // Erst nach dem Hydrieren lesen, damit Server und Browser dasselbe rendern
  // biome-ignore lint/correctness/useExhaustiveDependencies: start nur einmal beim Öffnen, nicht bei jedem Rendern
  useEffect(() => {
    setReason(ssoReasonMessage(window.location.search, name));
    if (autoStart && startetVonSelbst(window.location.search)) void start();
  }, [name, autoStart]);

  async function start() {
    setBusy(true);
    setError(null);
    try {
      const result = await authClient.signIn.social({ provider: "oidc", callbackURL: (weiter && weiterNachAnmeldung(window.location.search)) || "/" });
      // Better Auth begrenzt Anmeldeversuche je Adresse (3 in 10 Sekunden)
      if (result.error)
        setError(result.error.status === 429 ? "Zu viele Anmeldeversuche. Bitte einen Moment warten und erneut versuchen." : ssoReasons(name).fehler!);
    } catch {
      setError(ssoReasons(name).fehler!);
    } finally {
      setBusy(false);
    }
  }

  const message = error ?? reason;
  return (
    <>
      <button type="button" className="btn btn-primary" onClick={start} disabled={busy}>
        {label ?? `Mit ${name} anmelden`}
      </button>
      {message && (
        <p className="field-error" role="alert">
          {message}
        </p>
      )}
    </>
  );
}
