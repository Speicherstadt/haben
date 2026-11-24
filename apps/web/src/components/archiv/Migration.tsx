import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { ArchiveUpload } from "./ArchiveUpload.tsx";
import { YearCheck } from "./MigrationJahre.tsx";
import { MigrationCards } from "./MigrationKarten.tsx";
import { OpenItems } from "./OpenItems.tsx";
import { SevdeskAssets } from "./SevdeskAssets.tsx";
import { ALL_SOURCES, type MigrationData, type Source } from "./migration-quellen.ts";

/** Die zuletzt genutzte Quelle, sonst Lexware Office */
function startSource(data: MigrationData): Source {
  if (data.connection || data.lastImport) return "lexoffice";
  if (data.sevdeskConnection || data.sevdeskImport || data.sevdeskExportImport) return "sevdesk";
  if (data.fastbillConnection || data.fastbillImport) return "fastbill";
  if (data.accountableImport) return "accountable";
  if (data.bbImport) return "buchhaltungsbutler";
  if (data.wisoImport) return "wiso";
  return "lexoffice";
}

export function Migration({ data }: { data: MigrationData }) {
  const ready = data.years.length > 0 && data.years.every((y) => y.ready) && data.orderArchive.withoutPdf === 0;
  const [source, setSource] = useState<Source>(() => startSource(data));
  const config = ALL_SOURCES[source];
  // Das Anlagenverzeichnis liefert nur die API von sevDesk
  const assets = source === "sevdesk" && Boolean(data.sevdeskConnection);
  return (
    <div className="stack">
      {data.externalImports.length > 0 && (
        <p className="banner banner-info" role="status">
          Geprüfte JSON-Pakete übernommen: {data.externalImports.map((entry) => `${entry.source} (${entry.count} Vorgänge)`).join(", ")}. Originale stehen unter
          Belege und Auftragsdokumente. Offene Posten werden unten am Stichtag geprüft.
        </p>
      )}
      {data.orderArchive.count > 0 && (
        <p className="banner banner-info" role="status">
          {data.orderArchive.count} Auftragsdokumente archiviert; {data.orderArchive.withoutPdf} ohne PDF.{" "}
          <Link to="/archiv" search={{ ansicht: "auftraege" }}>
            Auftragsdokumente ansehen
          </Link>
        </p>
      )}
      <div className="banner banner-info" role="note">
        Haben übernimmt alle Jahre aus {config.product}, damit du nach der Kündigung jede Frage des Finanzamts aus Haben beantworten kannst. Kündige erst, wenn
        der Abgleich unten für jedes Jahr aufgeht. Alles, was hier landet, ist danach unveränderlich.
      </div>
      <div className="chip-row" role="group" aria-label="Bisherige Buchhaltung">
        {(Object.keys(ALL_SOURCES) as Source[]).map((s) => (
          <button key={s} type="button" className={`chip${source === s ? " active" : ""}`} aria-pressed={source === s} onClick={() => setSource(s)}>
            Umzug aus {ALL_SOURCES[s].product}
          </button>
        ))}
      </div>
      <MigrationCards source={source} data={data} />
      <OpenItems
        items={data.openItems}
        cutoff={data.cutoff}
        cutoffError={data.cutoffError}
        imported={Boolean(
          data.lastImport ||
            data.sevdeskImport ||
            data.sevdeskExportImport ||
            data.fastbillImport ||
            data.accountableImport ||
            data.bbImport ||
            data.wisoImport ||
            data.externalImports.length,
        )}
      />
      {assets && <SevdeskAssets bookingDate={data.cutoff.bookingDate} />}
      <section className="card stack" aria-labelledby="upload-heading">
        <div className="step-head">
          <span className="step-num">{assets ? 5 : 4}</span>
          <h2 id="upload-heading" style={{ margin: 0 }}>
            Exporte ablegen
          </h2>
        </div>
        <p className="small muted" style={{ margin: 0 }}>
          {config.exportsHelp} Die Dateien bleiben unverändert und mit Prüfsumme im Archiv; den Buchungsstapel liest Haben zusätzlich zeilenweise ein.
        </p>
        <ArchiveUpload kinds={data.kinds} />
      </section>
      <section className="stack" aria-labelledby="check-heading">
        <div className="card stack">
          <div className="step-head">
            <span className="step-num">{assets ? 6 : 5}</span>
            <h2 id="check-heading" style={{ margin: 0 }}>
              Abgleich je Jahr
            </h2>
          </div>
          {data.years.length === 0 ? (
            <p className="small muted" style={{ margin: 0 }}>
              Noch nichts übernommen. Der Abgleich erscheint, sobald die ersten Daten aus Schritt 2 oder {assets ? 5 : 4} da sind.
            </p>
          ) : (
            <div className={ready ? "banner banner-ok" : "banner banner-info"} role="status">
              {ready
                ? `Alle Prüfungen sind erfüllt. Vergleiche noch die Summen und die Umsatzsteuer je Monat mit ${config.product}, dann kannst du kündigen.`
                : "Noch nicht alles beisammen. Offene Punkte stehen bei den Jahren unten."}
            </div>
          )}
        </div>
        {data.years.map((year) => (
          <YearCheck key={year.year} year={year} versteuerung={data.versteuerung} product={config.product} />
        ))}
      </section>
    </div>
  );
}
