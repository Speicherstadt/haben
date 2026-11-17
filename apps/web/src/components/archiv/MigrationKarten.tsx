import { WebBackup } from "./WebBackup.tsx";
import { BuchhaltungsButlerImport } from "./BuchhaltungsButlerImport.tsx";
import { WisoImport } from "./WisoImport.tsx";
import { SevdeskExportImport } from "./SevdeskExportImport.tsx";
import { FastbillReceipts } from "./FastbillReceipts.tsx";
import { FastbillArticles } from "./FastbillTeile.tsx";
import { Connection } from "./MigrationVerbindung.tsx";
import { ImportCard } from "./MigrationAbruf.tsx";
import type { Source, MigrationData, ImportRow } from "./umzug-quellen.ts";

export function MigrationCards({ source, data, lastImport }: { source: Source; data: MigrationData; lastImport: ImportRow | null }) {
  return source === "buchhaltungsbutler" ? (
    <BuchhaltungsButlerImport key="buchhaltungsbutler" initial={data.bbImport} />
  ) : source === "wiso" ? (
    <WisoImport key="wiso" initial={data.wisoImport} />
  ) : source === "accountable" ? (
    <ImportCard key={`accountable-${lastImport?.id ?? "neu"}`} source="accountable" connected initial={lastImport} />
  ) : (
    <>
      {source === "sevdesk" ? (
        <Connection key="sevdesk" source="sevdesk" connected={data.sevdeskConnection ? { name: "sevDesk", since: data.sevdeskConnection.createdAt } : null} />
      ) : source === "fastbill" ? (
        <Connection
          key="fastbill"
          source="fastbill"
          plans={data.fastbillPlans}
          connected={
            data.fastbillConnection
              ? {
                  name: data.fastbillConnection.email,
                  since: data.fastbillConnection.createdAt,
                  detail: `Tarif ${data.fastbillPlans.find((p) => p.callsPerHour === data.fastbillConnection?.callsPerHour)?.label ?? ""}, ${data.fastbillConnection.callsPerHour} Anfragen pro Stunde.`,
                }
              : null
          }
        />
      ) : (
        <Connection
          key="lexoffice"
          source="lexoffice"
          connected={data.connection ? { name: data.connection.organizationName || "Lexware Office", since: data.connection.createdAt } : null}
        />
      )}
      {source === "lexoffice" && !data.connection && <WebBackup />}
      <ImportCard
        key={`${source}-${lastImport?.id ?? "neu"}`}
        source={source}
        connected={Boolean(source === "sevdesk" ? data.sevdeskConnection : source === "fastbill" ? data.fastbillConnection : data.connection)}
        initial={lastImport}
      />
      {source === "sevdesk" && <SevdeskExportImport key={`sevdesk-export-${data.sevdeskExportImport?.id ?? "neu"}`} initial={data.sevdeskExportImport} />}
      {source === "fastbill" && <FastbillReceipts receipts={data.fastbillReceipts} running={data.fastbillImport?.status === "laeuft"} />}
      {source === "fastbill" && data.fastbillConnection && <FastbillArticles />}
    </>
  );
}
