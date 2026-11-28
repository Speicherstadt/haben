import { createMiddleware } from "@tanstack/react-start";

/** Server Functions: TanStack Start liest ihren Body vollständig, bevor die Anmeldeprüfung der Funktion läuft */
const SERVER_FN_PREFIX = "/_serverFn/";
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/** Größe, bis zu der auch Anfragen ohne Anmeldung gelesen werden (Anmeldung, Einrichtung); Uploads brauchen eine Sitzung */
export const ANONYMOUS_BODY_LIMIT = 1_000_000;

type HasSession = (headers: Headers) => Promise<boolean>;

/**
 * Lehnt große schreibende Anfragen an Server Functions ohne gültige Sitzung mit 413 ab, bevor der Body gelesen wird.
 * Sonst puffert der Server bis zu 250 MB (Grenze in Caddy) je Anfrage im Speicher, bevor die Funktion „nicht angemeldet“
 * antwortet. Die Sitzung wird wirklich geprüft und nicht nur das Cookie gesucht, denn ein Cookie-Name lässt sich
 * mitschicken. Anmeldung und Einrichtung sind klein und bleiben unberührt, ebenso Uploads angemeldeter Konten.
 * Fehlt die Größenangabe, gilt die Anfrage als groß.
 */
export async function rejectLargeAnonymousBody(request: Request, pathname: string, sessionCheck: HasSession): Promise<Response | null> {
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
  // Der Import steht im Server-Teil: start.ts läuft auch im Browser-Bundle, und rollen.ts zöge den ganzen Server mit
  // (bis zum nativen Typst-Compiler). Erst hier geladen, brauchen kleine Anfragen, also fast alle, kein Anmeldemodul.
  const rejection = await rejectLargeAnonymousBody(request, pathname, async (headers) => {
    const { sessionUser } = await import("./rollen.ts");
    return (await sessionUser(headers)) !== null;
  });
  return rejection ?? next();
});

/** Body bis höchstens `limit` Bytes, auch ohne Content-Length; null, sobald er größer ist (Rest wird nicht gelesen) */
export async function readBodyLimited(request: Request, limit: number): Promise<Uint8Array<ArrayBuffer> | null> {
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

/**
 * /api/auth ist ohne Anmeldung erreichbar, und Better Auth liest den Body jeder POST-Route vollständig (request.json()).
 * Anmeldung, Einrichtung und Passkeys senden wenige KB; mehr wird nicht gelesen, auch ohne Content-Length (chunked).
 * Sonst puffert der Server je Anfrage bis zur Grenze des Proxys (250 MB).
 */
export const AUTH_BODY_LIMIT = 128 * 1024;

/** Der Body begrenzt gelesen und neu verpackt; null, wenn er größer als AUTH_BODY_LIMIT ist */
export async function limitAuthBody(request: Request): Promise<Request | null> {
  if (request.method === "GET" || request.method === "HEAD" || !request.body) return request;
  if (Number(request.headers.get("content-length") ?? 0) > AUTH_BODY_LIMIT) return null;
  const bytes = await readBodyLimited(request, AUTH_BODY_LIMIT);
  if (!bytes) return null;
  return new Request(request.url, { method: request.method, headers: request.headers, body: bytes, signal: request.signal });
}
