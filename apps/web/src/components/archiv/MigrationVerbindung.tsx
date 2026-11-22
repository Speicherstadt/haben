import { useRouter } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useId, useState, type FormEvent } from "react";
import { formatDateTime } from "../../lib/format.ts";
import { useAction } from "../../lib/use-action.ts";
import { useSubmitCheck } from "../../lib/use-submit-check.ts";
import { saveFastbillLogin } from "../../server/functions/fastbill.ts";
import { ConfirmDialog } from "../ConfirmDialog.tsx";
import { Field } from "../Field.tsx";
import { Icon } from "../Icon.tsx";
import { NoticeBanner } from "../NoticeBanner.tsx";
import { FastbillLoginFields } from "./FastbillTeile.tsx";
import { type ConnectedSource, type FastbillPlan, SOURCES } from "./migration-quellen.ts";

export function Connection({
  source,
  connected,
  plans = [],
}: {
  source: ConnectedSource;
  connected: { name: string; since: Date; detail?: string } | null;
  /** Nur FastBill: Tarife mit Stundengrenze; dort braucht die Anmeldung auch die Login-E-Mail */
  plans?: readonly FastbillPlan[];
}) {
  const router = useRouter();
  const config = SOURCES[source];
  const save = useServerFn(config.save);
  const saveFastbill = useServerFn(saveFastbillLogin);
  const remove = useServerFn(config.remove);
  const [key, setKey] = useState("");
  const [email, setEmail] = useState("");
  const [callsPerHour, setCallsPerHour] = useState<number>(plans[0]?.callsPerHour ?? 50);
  const fastbill = source === "fastbill";
  const [removing, setRemoving] = useState(false);
  const { busy, notice, run } = useAction();
  const error = notice?.text ?? null;
  const keyId = useId();
  const {
    form,
    error: fehler,
    check,
  } = useSubmitCheck({
    key: key.trim() === "" ? `Trag den ${config.keyLabel} ein.` : null,
    email: fastbill && email.trim() === "" ? "Trag die E-Mail ein, mit der du dich bei FastBill anmeldest." : null,
  });

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    if (!check()) return;
    void run(async () => {
      if (fastbill) await saveFastbill({ data: { email, apiKey: key, callsPerHour } });
      else await save({ data: { apiKey: key } });
      setKey("");
      await router.invalidate();
    });
  }

  const onRemove = () =>
    run(async () => {
      await remove();
      await router.invalidate();
    });

  return (
    <section className={`card stack${connected ? " step-done" : ""}`} aria-labelledby="connection-heading">
      <div className="step-head">
        <span className="step-num">{connected ? <Icon name="check" /> : "1"}</span>
        <h2 id="connection-heading" style={{ margin: 0 }}>
          Verbindung zu {config.product}
        </h2>
      </div>
      {connected ? (
        <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
          <div>
            Verbunden mit <strong>{connected.name}</strong>
            <div className="small muted">
              {config.keyLabel} hinterlegt am {formatDateTime(connected.since)}, verschlüsselt gespeichert.{connected.detail ? ` ${connected.detail}` : ""}
            </div>
          </div>
          <button type="button" className="btn btn-danger" onClick={() => setRemoving(true)} disabled={busy}>
            {config.removeLabel}
          </button>
          <ConfirmDialog
            open={removing}
            title={`${config.keyLabel} entfernen?`}
            confirmLabel={config.removeLabel}
            danger
            onConfirm={() => void onRemove()}
            onClose={() => setRemoving(false)}
          >
            <p>Für neue Abrufe brauchst du dann wieder einen Zugang aus {config.product}. Schon übernommene Daten bleiben erhalten.</p>
          </ConfirmDialog>
          <NoticeBanner notice={notice} />
        </div>
      ) : (
        <form ref={form} className="stack" onSubmit={onSubmit} noValidate>
          <p className="small muted" style={{ margin: 0 }}>
            {config.keyHelp}
          </p>
          {fastbill && (
            <FastbillLoginFields
              email={email}
              onEmail={setEmail}
              emailError={fehler("email")}
              callsPerHour={callsPerHour}
              onCallsPerHour={setCallsPerHour}
              plans={plans}
            />
          )}
          <Field label={config.keyLabel} describedBy={error ? `${keyId}-error` : undefined} error={fehler("key")}>
            {(control) => (
              <input
                {...control}
                type="password"
                autoComplete="off"
                spellCheck={false}
                value={key}
                onChange={(event) => setKey(event.target.value)}
                aria-invalid={error || fehler("key") ? true : undefined}
              />
            )}
          </Field>
          {error && (
            <div id={`${keyId}-error`} className="banner banner-danger" role="alert">
              {error}
            </div>
          )}
          <div className="actions">
            <button type="submit" className="btn btn-primary" disabled={busy}>
              {busy ? "Prüfe …" : "Prüfen und speichern"}
            </button>
          </div>
        </form>
      )}
    </section>
  );
}
