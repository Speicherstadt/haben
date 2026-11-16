import { useState } from "react";
import { Field } from "./Field.tsx";
import { VatTerritoryHint } from "./VatTerritoryHint.tsx";

/** Anschrift mit unverbindlichem Sondergebiets-Hinweis, auch im Dialog für einen neuen Kontakt. */
export function ContactAddressFields({ initial }: { initial: { strasse: string; plz: string; ort: string; land: string } }) {
  const [postalCode, setPostalCode] = useState(initial.plz);
  const [country, setCountry] = useState(initial.land);
  return (
    <section className="form-section" aria-labelledby="contact-address">
      <h2 id="contact-address">Anschrift</h2>
      <Field label="Straße und Hausnummer">
        {(control) => <input {...control} name="strasse" defaultValue={initial.strasse} autoComplete="street-address" />}
      </Field>
      <div className="form-row cols-address">
        <Field label="PLZ">
          {(control) => (
            <input
              {...control}
              name="plz"
              value={postalCode}
              onChange={(event) => setPostalCode(event.target.value)}
              autoComplete="postal-code"
              inputMode="numeric"
            />
          )}
        </Field>
        <Field label="Ort">{(control) => <input {...control} name="ort" defaultValue={initial.ort} autoComplete="address-level2" />}</Field>
        <Field label="Land (ISO-Code)">
          {(control) => (
            <input
              {...control}
              name="land"
              value={country}
              onChange={(event) => setCountry(event.target.value)}
              maxLength={2}
              autoComplete="country"
              className="uppercase"
            />
          )}
        </Field>
      </div>
      <VatTerritoryHint country={country} postalCode={postalCode} />
    </section>
  );
}
