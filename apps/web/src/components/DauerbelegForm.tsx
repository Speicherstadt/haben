import { amountError, dauerbelegSummen, KLEINBETRAG_GRENZE, KLEINBETRAG_HINWEIS, parseEuro, type Recurrence, type Rechtsform, type Prozent } from "@haben/core";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { savedAsChoice, type ContactChoice } from "./ContactCombobox.tsx";
import { NewContactDialog } from "./NewContactDialog.tsx";
import {
  aendereBetragszeile,
  betragszeileAus,
  betragszeileAusVorlage,
  bruttoLesbar,
  bruttoZerlegen,
  steuerausweisUmschalten,
  type Betragszeile,
} from "../lib/betragszeile.ts";
import { useFokusNachSperre } from "../lib/use-fokus-nach-sperre.ts";
import { useSubmitCheck } from "../lib/use-submit-check.ts";
import {
  DauerbelegAllgemein,
  DauerbelegBetraege,
  DauerbelegDokument,
  type DauerbelegState,
  DauerbelegTermine,
  RATES,
  type Rate,
  type SteuerNachweis,
} from "./DauerbelegTeile.tsx";

export interface DauerbelegValues {
  name: string;
  supplierName: string;
  supplierUstId: string;
  supplierContactId: string | null;
  reference: string;
  category: string;
  payment: "bank" | "privat" | "kasse";
  privateShare: Prozent;
  amounts: { taxRate: Rate; net: number; tax: number }[];
  taxShown: boolean;
  /** Kleinbetragsrechnung: Endbetrag mit Steuersatz bis 250 € je Termin (§ 33 UStDV, #1101) */
  kleinbetrag: boolean;
  note: string;
  recurrence: Recurrence;
  nextDate: string;
  endDate: string | null;
  dueDays: number;
}

let nextKey = 1;

/**
 * Formular für einen Dauerbeleg: Lieferant, Kategorie, Beträge je Steuersatz, Intervall und Vertrag. Beim Anlegen ist der
 * Vertrag Pflicht, beim Ändern ersetzt eine neue Datei ihn nur für künftige Belege.
 */
export function DauerbelegForm({
  initial,
  suppliers,
  categories,
  kleinunternehmer,
  rechtsform,
  isNew,
  withoutFile = false,
  busy,
  submitLabel,
  onSubmit,
  onDirtyChange,
}: {
  initial: DauerbelegValues;
  suppliers: ContactChoice[];
  categories: { value: string; label: string }[];
  kleinunternehmer: boolean;
  rechtsform: Rechtsform;
  isNew: boolean;
  /** Übernommene Vorlage ohne Datei: Die Datei ist vor dem Fortsetzen nötig */
  withoutFile?: boolean;
  busy: boolean;
  submitLabel: string;
  onSubmit: (values: DauerbelegValues, file: File | null) => void;
  /** Meldet ungespeicherte Änderungen an die Seite; nach dem Neuaufbau mit dem gespeicherten Stand wieder false */
  onDirtyChange?: (dirty: boolean) => void;
}) {
  const [v, setV] = useState<DauerbelegState>(() => dauerbelegState(initial));
  const set = (patch: Partial<DauerbelegState>) => setV((prev) => ({ ...prev, ...patch }));
  /** Getippter Name, wenn der Dialog für einen neuen Lieferanten offen ist; null = geschlossen */
  const [newSupplierName, setNewSupplierName] = useState<string | null>(null);
  const { nachweis, amounts, setAmounts, chooseNachweis, updateAmount, addRate } = useBetraege(initial);
  const fileRef = useRef<HTMLInputElement>(null);
  // Ob eine Datei gewählt ist, für die Prüfung beim Speichern; die Datei selbst liest submit aus fileRef
  const [hasFile, setHasFile] = useState(false);
  const pickSupplier = (supplier: ContactChoice | null) =>
    set(supplier ? { supplierContactId: supplier.id, supplierName: supplier.name, supplierUstId: supplier.ustId } : { supplierContactId: null });

  const parsed = amounts.map((a) => betragAus(a, nachweis));
  const sums = dauerbelegSummen(parsed);
  const { form, error, check } = useSubmitCheck(dauerbelegErrors(v, amounts, nachweis, parsed, sums.gross, isNew && !hasFile));
  // Nach einem Fehler beim Speichern steht der Fokus wieder im gesperrten Feld
  useFokusNachSperre(busy);
  // Ob die Steuer von Hand kam und welcher Betrag zuletzt eingegeben wurde, speichert Haben nicht: Zurückgetippt ist nichts offen
  const betraege = amounts.map(({ key: _key, taxTouched: _taxTouched, basis: _basis, ...a }) => a);
  useAenderungenMelden({ v, nachweis, betraege }, hasFile, onDirtyChange);

  function submit(event: FormEvent) {
    event.preventDefault();
    if (!check()) return;
    const values: DauerbelegValues = {
      ...v,
      name: v.name.trim(),
      supplierName: v.supplierName.trim(),
      supplierUstId: v.supplierUstId.trim(),
      reference: v.reference.trim(),
      privateShare: initial.privateShare,
      amounts: parsed.map(({ valid: _valid, ...a }) => a),
      taxShown: nachweis === "ausweis",
      kleinbetrag: nachweis === "kleinbetrag",
      endDate: v.endDate || null,
      dueDays: Number(v.dueDays),
    };
    onSubmit(values, fileRef.current?.files?.[0] ?? null);
  }

  return (
    <>
      <form ref={form} className="card form-card form-narrow" onSubmit={submit} aria-label="Dauerbeleg" noValidate>
        {/* Gesperrt, solange gespeichert oder pausiert wird: Danach baut die Seite das Formular mit dem neuen `updatedAt` im
            `key` neu auf, und was man bis dahin tippt, ginge verloren (#1793) */}
        <fieldset className="fieldset-plain" disabled={busy}>
          <DauerbelegAllgemein
            v={v}
            set={set}
            error={error}
            suppliers={suppliers}
            categories={categories}
            rechtsform={rechtsform}
            pickSupplier={pickSupplier}
            onCreateSupplier={setNewSupplierName}
          />
          <DauerbelegTermine v={v} set={set} error={error} isNew={isNew} />
          <DauerbelegDokument
            error={error}
            isNew={isNew}
            withoutFile={withoutFile}
            fileRef={fileRef}
            setHasFile={setHasFile}
            nachweis={nachweis}
            chooseNachweis={chooseNachweis}
            kleinunternehmer={kleinunternehmer}
          />
          <DauerbelegBetraege
            v={v}
            set={set}
            error={error}
            amounts={amounts}
            nachweis={nachweis}
            sums={sums}
            updateAmount={updateAmount}
            removeAmount={(key) => setAmounts((prev) => prev.filter((x) => x.key !== key))}
            addRate={addRate}
          />
        </fieldset>
        <div className="actions form-footer">
          <button type="submit" className="btn btn-primary" disabled={busy}>
            {submitLabel}
          </button>
        </div>
      </form>
      <NewContactDialog
        rolle="lieferant"
        name={newSupplierName}
        prefill={{ name: v.supplierName, ...(v.supplierUstId ? { ustId: v.supplierUstId } : {}) }}
        onSaved={(saved) => pickSupplier(savedAsChoice(saved))}
        onPickExisting={(id) => pickSupplier(suppliers.find((c) => c.id === id) ?? null)}
        onClose={() => setNewSupplierName(null)}
      />
    </>
  );
}

/** Ungespeichert ist, was vom Stand beim Aufbau abweicht, und eine gewählte Datei; zurückgetippt ist nichts mehr offen */
function useAenderungenMelden(stand: unknown, hasFile: boolean, onDirtyChange?: (dirty: boolean) => void) {
  const jetzt = JSON.stringify(stand);
  const [anfang] = useState(jetzt);
  const dirty = hasFile || jetzt !== anfang;
  useEffect(() => onDirtyChange?.(dirty), [dirty, onDirtyChange]);
}

function dauerbelegState({
  amounts: _amounts,
  taxShown: _taxShown,
  kleinbetrag: _kleinbetrag,
  privateShare: _privateShare,
  ...values
}: DauerbelegValues): DauerbelegState {
  return { ...values, endDate: values.endDate ?? "", dueDays: String(values.dueDays) };
}

/** Fehler je Feld für die Prüfung beim Speichern; null, wo alles stimmt */
function dauerbelegErrors(
  v: DauerbelegState,
  amounts: Betragszeile[],
  nachweis: SteuerNachweis,
  parsed: { valid: boolean }[],
  gross: number,
  fileMissing: boolean,
): Record<string, string | null> {
  const BETRAG = amountError("den Betrag", 85_000);
  const due = Number(v.dueDays);
  const taxShown = nachweis === "ausweis";
  const nurBrutto = nachweis === "kleinbetrag";
  const kein = (text: string) => parseEuro(text) === null || parseEuro(text)! < 0;
  return {
    ...Object.fromEntries(
      amounts.flatMap((a, i) => [
        [`netto-${a.key}`, !nurBrutto && kein(a.net) ? BETRAG : null],
        [`steuer-${a.key}`, taxShown && kein(a.tax) ? BETRAG : null],
        // Ein vertipptes Brutto lässt die vorigen Beträge stehen; gespeichert würde dann etwas anderes als eingegeben
        [`brutto-${a.key}`, (taxShown && !bruttoLesbar(a)) || (nurBrutto && kein(a.gross)) ? BETRAG : null],
        [`satz-${a.key}`, amounts.findIndex((x) => x.taxRate === a.taxRate) < i ? "Diesen Satz gibt es schon in einer Zeile darüber." : null],
      ]),
    ),
    summe: !parsed.every((a) => a.valid)
      ? null
      : gross <= 0
        ? "Der Betrag je Termin muss über 0 liegen."
        : nurBrutto && gross > KLEINBETRAG_GRENZE
          ? KLEINBETRAG_HINWEIS
          : null,
    name: v.name.trim() === "" ? "Trag eine Bezeichnung ein, etwa Büromiete Hafenstraße." : null,
    supplier: v.supplierName.trim() === "" ? "Trag den Lieferanten ein." : null,
    category: v.category === "" ? "Wähle die Kategorie." : null,
    nextDate: v.nextDate ? null : "Wähle den Tag des ersten Belegs.",
    endDate: v.endDate && v.endDate < v.nextDate ? "Wähle einen Tag ab dem ersten Beleg." : null,
    due: Number.isInteger(due) && due >= 0 && due <= 120 ? null : "Trag ganze Tage von 0 bis 120 ein.",
    file: fileMissing ? "Wähle den Vertrag oder die Dauerrechnung." : null,
  };
}

/**
 * Betrag einer Zeile in Cent. Mit Steuerausweis Netto und Steuer wie eingegeben, ohne Steuer nur das Netto. Bei der
 * Kleinbetragsrechnung zählt nur der Endbetrag: Haben teilt ihn auf wie am Beleg (`bruttoZerlegen`, § 35 Abs. 1 UStDV), so
 * wie es der Server nachrechnet.
 */
function betragAus(a: Betragszeile, nachweis: SteuerNachweis) {
  if (nachweis === "kleinbetrag") {
    const gross = parseEuro(a.gross);
    if (gross === null || gross < 0) return { taxRate: a.taxRate, net: 0, tax: 0, valid: false };
    return { taxRate: a.taxRate, ...bruttoZerlegen(gross, a.taxRate), valid: true };
  }
  const net = parseEuro(a.net);
  const tax = nachweis === "ausweis" ? parseEuro(a.tax) : 0;
  return { taxRate: a.taxRate, net: net ?? 0, tax: tax ?? 0, valid: net !== null && net >= 0 && tax !== null && tax >= 0 };
}

/**
 * Beträge je Satz und was das Dokument zur Steuer sagt. Bei der Kleinbetragsrechnung ist der Endbetrag die einzige Eingabe:
 * Ein anderer Satz teilt ihn neu auf, statt die Steuer aus dem verborgenen Netto zu rechnen (10,00 € + 1,90 € folgt auch aus
 * dem Netto, Review #1996); beim Wechsel bleibt der bisher sichtbare Betrag der Endbetrag.
 */
function useBetraege(initial: DauerbelegValues) {
  const [nachweis, setNachweis] = useState<SteuerNachweis>(initial.taxShown ? "ausweis" : initial.kleinbetrag ? "kleinbetrag" : "keine");
  const [amounts, setAmounts] = useState<Betragszeile[]>(() =>
    initial.amounts.map((a) => {
      const zeile = betragszeileAusVorlage(nextKey++, a, initial.taxShown || initial.kleinbetrag);
      return initial.kleinbetrag ? { ...zeile, basis: "gross" as const } : zeile;
    }),
  );

  // Selbst geschuldete Steuer (§ 13b) gibt es am Dauerbeleg nicht
  function updateAmount(key: number, patch: Partial<Omit<Betragszeile, "key">>) {
    setAmounts((prev) => prev.map((a) => (a.key === key ? aendereBetragszeile(a, patch, false) : a)));
  }

  function chooseNachweis(neu: SteuerNachweis) {
    const bisher = nachweis;
    setNachweis(neu);
    setAmounts((prev) => {
      const umgeschaltet = steuerausweisUmschalten(prev, neu !== "keine");
      if (neu !== "kleinbetrag") return umgeschaltet;
      // Ohne Steuer war das Netto sichtbar, mit Steuerausweis das Brutto
      return umgeschaltet.map((zeile, i) => aendereBetragszeile(zeile, { gross: bisher === "keine" ? prev[i]!.net : prev[i]!.gross }, false));
    });
  }

  function addRate() {
    const used = new Set(amounts.map((a) => a.taxRate));
    const rate = RATES.find((r) => !used.has(r));
    if (rate !== undefined) setAmounts((prev) => [...prev, betragszeileAus(nextKey++, rate, 0, 0, true, false)]);
  }

  return { nachweis, amounts, setAmounts, chooseNachweis, updateAmount, addRate };
}
