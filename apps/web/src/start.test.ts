import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { bodyLimitMiddleware } from "./server/body-limit.ts";
import { startInstance } from "./start.ts";

describe("Einbindung der Schutzschichten in start.ts", () => {
  it("die Größenprüfung läuft als erste Request-Middleware, vor CSRF-Prüfung und Antwort-Headern", async () => {
    const { requestMiddleware } = await startInstance.getOptions();
    expect(requestMiddleware).toHaveLength(3);
    // Vor allem anderen: Danach liest der Server den Body der Server Function
    expect(requestMiddleware![0]).toBe(bodyLimitMiddleware);
  });

  it("die Antworten bekommen frame-ancestors, die Permissions-Policy und Cache-Control", () => {
    const source = readFileSync(new URL("./start.ts", import.meta.url), "utf8");
    expect(source).toMatch(/withFrameAncestors\(result\.response, /);
    expect(source).toMatch(/withCacheControl\(withPermissionsPolicy\(response\)\)/);
  });
});
