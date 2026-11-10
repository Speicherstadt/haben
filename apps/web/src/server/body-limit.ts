import { createMiddleware } from "@tanstack/react-start";

/** Server Functions: TanStack Start liest ihren Body vollständig, bevor die Anmeldeprüfung der Funktion läuft */
const SERVER_FN_PREFIX = "/_serverFn/";
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/** Größe, bis zu der auch Anfragen ohne Anmeldung gelesen werden (Anmeldung, Einrichtung); Uploads brauchen eine Sitzung */
export const ANONYMOUS_BODY_LIMIT = 1_000_000;

type HasSession = (headers: Headers) => Promise<boolean>;

const hasSession: HasSession = async (headers) => {
  // Erst hier laden: Kleine Anfragen, also fast alle, brauchen weder Datenbank noch Anmeldemodul
  const { sessionUser } = await import("./rollen.ts");
  return (await sessionUser(headers)) !== null;
};

/**
 * Lehnt große schreibende Anfragen an Server Functions ohne gültige Sitzung mit 413 ab, bevor der Body gelesen wird.
 * Sonst puffert der Server bis zu 250 MB (Grenze in Caddy) je Anfrage im Speicher, bevor die Funktion „nicht angemeldet“
 * antwortet. Die Sitzung wird wirklich geprüft und nicht nur das Cookie gesucht, denn ein Cookie-Name lässt sich
 * mitschicken. Anmeldung und Einrichtung sind klein und bleiben unberührt, ebenso Uploads angemeldeter Konten.
 * Fehlt die Größenangabe, gilt die Anfrage als groß.
 */
export async function rejectLargeAnonymousBody(request: Request, pathname: string, sessionCheck: HasSession = hasSession): Promise<Response | null> {
  if (!pathname.startsWith(SERVER_FN_PREFIX) || SAFE_METHODS.has(request.method)) return null;
  const declared = request.headers.get("content-length");
  const length = declared === null ? Number.NaN : Number(declared);
  // Fehlt die Größe (Transfer-Encoding: chunked, das der Server nicht immer als Header weitergibt), gilt sie als groß.
  // Anmeldung und Einrichtung vom Browser haben immer eine Content-Length.
  const large = Number.isFinite(length) ? length > ANONYMOUS_BODY_LIMIT : true;
  if (!large) return null;
  if (await sessionCheck(request.headers)) return null;
  return new Response("Anfrage zu groß", { status: 413 });
}

export const bodyLimitMiddleware = createMiddleware().server(async ({ request, pathname, next }) => {
  const rejection = await rejectLargeAnonymousBody(request, pathname);
  return rejection ?? next();
});
