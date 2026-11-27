import { plzProblem, vatTerritory } from "@haben/core";
import { useId, useState } from "react";
import { Field } from "./Field.tsx";
import { LandCombobox } from "./LandCombobox.tsx";
import { VatTerritoryHint } from "./VatTerritoryHint.tsx";

/**
 * Anschrift mit unverbindlichem Sondergebiets-Hinweis, auch im Dialog für einen neuen Kontakt. Das Land ist eine Auswahl
 * (#914); die PLZ prüft das Formular je Land (`plzProblem`), den Fehler zeigt das Feld erst nach dem ersten Speichern
 * (`pruefen`) und nimmt ihn weg, sobald die PLZ stimmt.
 */
export function ContactAddressFields({
  initial,
  pruefen = false,
}: {
  initial: { adresszusatz?: string; strasse: string; plz: string; ort: string; land: string };
  pruefen?: boolean;
}) {
  const [postalCode, setPostalCode] = useState(initial.plz);
  const [country, setCountry] = useState(initial.land);
  const hintId = useId();
  const describedBy = vatTerritory(country, postalCode) ? hintId : undefined;
  const plzFehler = pruefen ? plzProblem(country, postalCode) : null;
  return (
    <section className="form-section" aria-labelledby="contact-address">
      <h2 id="contact-address">Anschrift</h2>
      <Field label="Adresszusatz" hint="Abteilung, c/o, Gebäude">
        {(control) => <input {...control} name="adresszusatz" defaultValue={initial.adresszusatz ?? ""} maxLength={100} />}
      </Field>
      <Field label="Straße und Hausnummer">
        {(control) => <input {...control} name="strasse" defaultValue={initial.strasse} autoComplete="street-address" />}
      </Field>
      <div className="form-row cols-address">
        <Field label="PLZ" describedBy={describedBy} error={plzFehler}>
          {(control) => (
            <input
              {...control}
              name="plz"
              value={postalCode}
              onChange={(event) => setPostalCode(event.target.value)}
              autoComplete="postal-code"
              // Ziffernblock nur für deutsche PLZ; britische und niederländische haben Buchstaben
              inputMode={country === "DE" ? "numeric" : "text"}
            />
          )}
        </Field>
        <Field label="Ort">{(control) => <input {...control} name="ort" defaultValue={initial.ort} autoComplete="address-level2" />}</Field>
        <Field label="Land" describedBy={describedBy}>
          {(control) => <LandCombobox {...control} name="land" value={country} onChoose={setCountry} />}
        </Field>
      </div>
      <VatTerritoryHint id={hintId} country={country} postalCode={postalCode} />
    </section>
  );
}
