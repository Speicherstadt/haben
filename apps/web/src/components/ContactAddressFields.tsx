import { vatTerritory } from "@haben/core";
import { useId } from "react";
import { Field } from "./Field.tsx";
import { LandCombobox } from "./LandCombobox.tsx";
import { VatTerritoryHint } from "./VatTerritoryHint.tsx";

/**
 * Anschrift mit unverbindlichem Sondergebiets-Hinweis, auch im Dialog für einen neuen Kontakt. Das Land ist eine Auswahl
 * (#914). PLZ und Land hält das Formular, weil es die PLZ je Land beim Speichern prüft (useSubmitCheck); `plzFehler`
 * ist der Fehler, den es am Feld zeigt.
 */
export function ContactAddressFields({
  initial,
  plz,
  onPlz,
  land,
  onLand,
  plzFehler,
}: {
  initial: { adresszusatz?: string; strasse: string; ort: string };
  plz: string;
  onPlz: (plz: string) => void;
  land: string;
  onLand: (land: string) => void;
  plzFehler: string | undefined;
}) {
  const hintId = useId();
  const describedBy = vatTerritory(land, plz) ? hintId : undefined;
  return (
    <section className="form-section" aria-labelledby="contact-address">
      <h2 id="contact-address">Anschrift</h2>
      <Field label="Adresszusatz" hint="Abteilung, c/o, Gebäude">
        {(control) => <input {...control} name="adresszusatz" defaultValue={initial.adresszusatz ?? ""} maxLength={100} autoComplete="address-line2" />}
      </Field>
      <Field label="Straße und Hausnummer">
        {(control) => <input {...control} name="strasse" defaultValue={initial.strasse} autoComplete="address-line1" />}
      </Field>
      <div className="form-row cols-address">
        <Field label="PLZ" describedBy={describedBy} error={plzFehler}>
          {(control) => (
            <input
              {...control}
              name="plz"
              value={plz}
              onChange={(event) => onPlz(event.target.value)}
              autoComplete="postal-code"
              // Ziffernblock nur für deutsche PLZ; britische und niederländische haben Buchstaben
              inputMode={land === "DE" ? "numeric" : "text"}
            />
          )}
        </Field>
        <Field label="Ort">{(control) => <input {...control} name="ort" defaultValue={initial.ort} autoComplete="address-level2" />}</Field>
        <Field label="Land" describedBy={describedBy}>
          {(control) => <LandCombobox {...control} name="land" value={land} onChoose={onLand} />}
        </Field>
      </div>
      <VatTerritoryHint id={hintId} country={land} postalCode={plz} />
    </section>
  );
}
