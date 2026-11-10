import { createCsrfMiddleware, createMiddleware, createStart } from "@tanstack/react-start";
import { feldfehlerAdapter } from "./lib/feldfehler.ts";
import { bodyLimitMiddleware } from "./server/body-limit.ts";
import { csrfOptions } from "./server/csrf.ts";
import { withCacheControl, withFrameAncestors } from "./server/security-headers.ts";

/** Läuft für jede Anfrage, Seiten wie API */
const securityHeaders = createMiddleware().server(async ({ next, request }) => {
  const result = await next();
  return { ...result, response: withCacheControl(withFrameAncestors(result.response, new URL(request.url).pathname)) };
});

export const startInstance = createStart(() => ({
  requestMiddleware: [bodyLimitMiddleware, createCsrfMiddleware(csrfOptions), securityHeaders],
  serializationAdapters: [feldfehlerAdapter],
}));
