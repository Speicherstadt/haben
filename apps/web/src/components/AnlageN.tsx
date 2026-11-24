import { formatDecimal, parseEuro } from "@haben/core";
import { Fragment, useContext } from "react";
import type { EstArbeitnehmer } from "@haben/elster";
import { Field } from "./Field.tsx";
import {
  type ArbeitnehmerDraft,
  anSchluessel,
  BETRAEGE,
  type BescheinigungDraft,
  type BetragKey,
  HOECHSTENS_BESCHEINIGUNGEN,
  WK_BETRAEGE,
  type WkKey,
} from "./jahreserklaerung/anlage-n-pruefung.ts";
import { EstFehler } from "./jahreserklaerung/EstAngaben.tsx";

/**
 * Eingabe der Anlage N einer Person: Lohnsteuerbescheinigungen (Nummern wie auf der Bescheinigung)
 * und Werbungskosten. Der Zustand liegt beim Formular der Einkommensteuer, hier nur Felder und Umwandlung; gelesen und
 * geprüft wird in `jahreserklaerung/anlage-n-pruefung.ts`.
 */

const centsText = (cents: number | undefined) => (cents ? formatDecimal(cents) : "");
const numberText = (n: number | undefined) => (n ? String(n).replace(".", ",") : "");
let nextKey = 1;

function emptyBescheinigung(): BescheinigungDraft {
  return { key: nextKey++, steuerklasse: "1", ...(Object.fromEntries(BETRAEGE.map(([k]) => [k, ""])) as Record<BetragKey, string>) };
}

export function toArbeitnehmerDraft(an: EstArbeitnehmer | undefined): ArbeitnehmerDraft {
  const w = an?.werbungskosten ?? {};
  return {
    aktiv: Boolean(an && an.bescheinigungen.length > 0),
    bescheinigungen: an?.bescheinigungen.length
      ? an.bescheinigungen.map((b) => ({
          key: nextKey++,
          steuerklasse: String(b.steuerklasse),
          ...(Object.fromEntries(BETRAEGE.map(([k]) => [k, centsText(b[k])])) as Record<BetragKey, string>),
        }))
      : [emptyBescheinigung()],
    tage: numberText(w.wege?.tage),
    km: numberText(w.wege?.km),
    adresse: w.wege?.adresse ?? "",
    arbeitstageJeWoche: numberText(w.wege?.arbeitstageJeWoche),
    urlaubstage: numberText(w.wege?.urlaubstage),
    homeofficeTage: numberText(w.homeofficeTage),
    keinAndererArbeitsplatz: w.keinAndererArbeitsplatz ?? false,
    ...(Object.fromEntries(WK_BETRAEGE.map(([k]) => [k, centsText(w[k])])) as Record<WkKey, string>),
    arbeitszimmerMonate: w.arbeitszimmerMonate === undefined ? "" : String(w.arbeitszimmerMonate),
  };
}

export function AnlageNFields({
  p,
  wer,
  draft,
  onChange,
}: {
  p: "a" | "b";
  wer: string;
  draft: ArbeitnehmerDraft;
  onChange: (draft: ArbeitnehmerDraft) => void;
}) {
  // Fehler aus useSubmitCheck der Einkommensteuer, je Person und Feld, bei Bescheinigungen auch je Bescheinigung (#1277)
  const fehler = useContext(EstFehler);
  const error = (feld: string, bescheinigung?: number) => fehler(anSchluessel(p, feld, bescheinigung));
  const set = (patch: Partial<ArbeitnehmerDraft>) => onChange({ ...draft, ...patch });
  const setB = (key: number, patch: Partial<BescheinigungDraft>) =>
    set({ bescheinigungen: draft.bescheinigungen.map((b) => (b.key === key ? { ...b, ...patch } : b)) });

  // Summen ueber alle Bescheinigungen: Bei mehreren Arbeitgebern zaehlt das Zusammen,
  // nicht die erste Zeile.
  const summe = (feld: "brutto" | "lohnsteuer") => draft.bescheinigungen.reduce((s, b) => s + (parseEuro(b[feld]) ?? 0), 0);
  const brutto = summe("brutto");
  const lohnsteuer = summe("lohnsteuer");
  const zusammenfassung = !draft.aktiv
    ? "kein Arbeitslohn"
    : [
        brutto > 0 && `${formatDecimal(brutto)} € Bruttoarbeitslohn`,
        lohnsteuer > 0 && `${formatDecimal(lohnsteuer)} € Lohnsteuer`,
        draft.bescheinigungen.length > 1 && `${draft.bescheinigungen.length} Bescheinigungen`,
      ]
        .filter(Boolean)
        .join(" · ") || "keine Beträge";

  return (
    // Der Block trägt den Namen, den die Tests und die Sprachausgabe für die ganze Anlage N kennen (#869)
    <details className="est-block" aria-label={`Anlage N · ${wer}`}>
      <summary>
        <span className="est-block-title">Arbeitslohn (Anlage N) · {wer}</span>
        <span className="small muted">{zusammenfassung}</span>
      </summary>
      <div className="stack" style={{ gap: 12, paddingTop: 12 }}>
        <label className="checkbox">
          <input type="checkbox" checked={draft.aktiv} onChange={(e) => set({ aktiv: e.target.checked })} />
          {wer} hatte Arbeitslohn aus einer Anstellung
        </label>
        {draft.aktiv && (
          <>
            <p className="small muted" style={{ margin: 0 }}>
              Die Beträge stehen auf der Lohnsteuerbescheinigung, die der Arbeitgeber schickt; Haben übernimmt die Sozialversicherung in die Anlage
              Vorsorgeaufwand. Bei mehreren Arbeitgebern je Bescheinigung eine Zeile.
            </p>
            {draft.bescheinigungen.map((b, index) => (
              <details key={b.key} className="est-block">
                <summary>
                  <span className="est-block-title">Lohnsteuerbescheinigung{index > 0 ? ` ${index + 1}` : ""}</span>
                  <span className="small muted">
                    {[b.brutto && `${b.brutto} € Bruttoarbeitslohn`, b.lohnsteuer && `${b.lohnsteuer} € Lohnsteuer`, `Steuerklasse ${b.steuerklasse}`]
                      .filter(Boolean)
                      .join(" · ")}
                  </span>
                </summary>
                <div className="form-row cols-2" role="group" aria-label={`Lohnsteuerbescheinigung ${index + 1} · ${wer}`}>
                  <Field label="Steuerklasse">
                    {(control) => (
                      <select {...control} value={b.steuerklasse} onChange={(e) => setB(b.key, { steuerklasse: e.target.value })}>
                        {[1, 2, 3, 4, 5, 6].map((k) => (
                          <option key={k} value={k}>
                            {k}
                          </option>
                        ))}
                      </select>
                    )}
                  </Field>
                  {BETRAEGE.map(([k, label]) => (
                    <Field label={label} key={k} error={error(k, b.key)}>
                      {(control) => (
                        <input
                          {...control}
                          inputMode="decimal"
                          value={b[k]}
                          onChange={(e) => setB(b.key, { [k]: e.target.value })}
                          placeholder="0,00"
                          required={k === "brutto"}
                        />
                      )}
                    </Field>
                  ))}
                  {draft.bescheinigungen.length > 1 && (
                    <div className="actions" style={{ gridColumn: "1 / -1" }}>
                      <button
                        type="button"
                        className="btn btn-danger btn-sm"
                        onClick={() => set({ bescheinigungen: draft.bescheinigungen.filter((x) => x.key !== b.key) })}
                      >
                        Bescheinigung entfernen
                      </button>
                    </div>
                  )}
                </div>
              </details>
            ))}
            {/* Mehr nimmt der Server nicht an; ohne Platz fehlt der Knopf (DESIGN.md, Gesperrte Knöpfe) */}
            {draft.bescheinigungen.length < HOECHSTENS_BESCHEINIGUNGEN ? (
              <div>
                <button type="button" className="btn" onClick={() => set({ bescheinigungen: [...draft.bescheinigungen, emptyBescheinigung()] })}>
                  + Weitere Lohnsteuerbescheinigung
                </button>
              </div>
            ) : (
              <p className="small muted" style={{ margin: 0 }}>
                Haben nimmt höchstens {HOECHSTENS_BESCHEINIGUNGEN} Lohnsteuerbescheinigungen je Person auf.
              </p>
            )}

            <details className="est-block">
              <summary>
                <span className="est-block-title">Werbungskosten</span>
                <span className="small muted">
                  {[draft.tage, draft.km, draft.homeofficeTage, ...WK_BETRAEGE.map(([k]) => draft[k])].some((v) => v.trim())
                    ? "Angaben eingetragen"
                    : "nichts eingetragen"}
                </span>
              </summary>
              <div className="form-row cols-2" style={{ marginTop: 8 }} role="group" aria-label={`Werbungskosten · ${wer}`}>
                <Field label="Erste Tätigkeitsstätte (PLZ, Ort, Straße)" style={{ gridColumn: "1 / -1" }} error={error("adresse")}>
                  {(control) => <input {...control} value={draft.adresse} onChange={(e) => set({ adresse: e.target.value })} maxLength={200} />}
                </Field>
                <Field label="Tage dort" error={error("tage")}>
                  {(control) => <input {...control} inputMode="numeric" value={draft.tage} onChange={(e) => set({ tage: e.target.value })} />}
                </Field>
                <Field label="Einfache Entfernung in km" error={error("km")}>
                  {(control) => <input {...control} inputMode="decimal" value={draft.km} onChange={(e) => set({ km: e.target.value })} />}
                </Field>
                <Field label="Arbeitstage je Woche" error={error("arbeitstageJeWoche")}>
                  {(control) => (
                    <input {...control} inputMode="numeric" value={draft.arbeitstageJeWoche} onChange={(e) => set({ arbeitstageJeWoche: e.target.value })} />
                  )}
                </Field>
                <Field label="Urlaubs- und Krankheitstage" error={error("urlaubstage")}>
                  {(control) => <input {...control} inputMode="numeric" value={draft.urlaubstage} onChange={(e) => set({ urlaubstage: e.target.value })} />}
                </Field>
                <Field label="Homeoffice-Tage" hint="ohne Fahrt zur Tätigkeitsstätte; 6 € je Tag, höchstens 210 Tage" error={error("homeofficeTage")}>
                  {(control) => (
                    <input {...control} inputMode="numeric" value={draft.homeofficeTage} onChange={(e) => set({ homeofficeTage: e.target.value })} />
                  )}
                </Field>
                <label className="checkbox" style={{ gridColumn: "1 / -1" }}>
                  <input type="checkbox" checked={draft.keinAndererArbeitsplatz} onChange={(e) => set({ keinAndererArbeitsplatz: e.target.checked })} />
                  Dauerhaft kein anderer Arbeitsplatz
                </label>
                {WK_BETRAEGE.map(([k, label, hint]) => (
                  <Fragment key={k}>
                    <Field label={label} hint={hint && hint} key={k} error={error(k)}>
                      {(control) => (
                        <input {...control} inputMode="decimal" value={draft[k]} onChange={(e) => set({ [k]: e.target.value })} placeholder="0,00" />
                      )}
                    </Field>
                    {k === "arbeitszimmer" && (
                      <Field
                        label="Monate als Mittelpunkt"
                        hint="Monate, in denen das Zimmer wenigstens zeitweise der Mittelpunkt war; je vollem Monat ohne 105 € weniger als 1.260 €"
                        error={error("arbeitszimmerMonate")}
                      >
                        {(control) => (
                          <input
                            {...control}
                            inputMode="numeric"
                            value={draft.arbeitszimmerMonate}
                            onChange={(e) => set({ arbeitszimmerMonate: e.target.value })}
                          />
                        )}
                      </Field>
                    )}
                  </Fragment>
                ))}
              </div>
            </details>
            <p className="small muted" style={{ margin: 0 }}>
              Unter 1.230 € Werbungskosten zieht das Finanzamt ohnehin den Arbeitnehmer-Pauschbetrag ab; die Angaben schaden aber nicht.
            </p>
          </>
        )}
      </div>
    </details>
  );
}
