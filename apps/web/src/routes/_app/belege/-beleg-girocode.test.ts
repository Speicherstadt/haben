import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("@tanstack/react-router", () => ({
  Link: ({ children, to, params }: { children: ReactNode; to: string; params?: { id: string } }) =>
    createElement("a", { href: params ? to.replace("$id", params.id) : to }, children),
}));
import { BelegGirocode } from "./-beleg-girocode.tsx";

type Code = Parameters<typeof BelegGirocode>[0]["code"];

const svg = (n: number) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${n} ${n}"><path d="M0 0h1v1h-1z"/></svg>`;
const ohne = { amount: 21_563, remittance: "RE-2026/0815", svg: svg(1), skonto: null };
const mit = {
  amount: 21_132,
  remittance: "RE-2026/0815 abzgl. 2,00 Prozent Skonto 4,31 EUR",
  svg: svg(2),
  skonto: { percent: 200, amount: 431, until: "2026-09-22" },
};
const code = (varianten: Code["varianten"], extra: Partial<Code> = {}): Code => ({
  open: 21_563,
  name: "Netzwerk Hosting GmbH",
  iban: "DE02120300000000202051",
  problem: null,
  problemImKontakt: false,
  varianten,
  ...extra,
});
const render = (c: Code, contactId: string | null = null) => renderToStaticMarkup(createElement(BelegGirocode, { code: c, contactId }));

describe("Zum Überweisen am Beleg (#1967)", () => {
  it("zeigt den Code über den offenen Betrag mit den Angaben zum Gegenlesen", () => {
    const html = render(code([ohne]));
    expect(html).toContain('<h2 id="beleg-girocode">Zum Überweisen</h2><span class="form-section-kurz">215,63');
    expect(html).toContain(`src="data:image/svg+xml;charset=utf-8,${encodeURIComponent(ohne.svg)}"`);
    expect(html).toContain("DE02 1203 0000 0000 2020 51");
    expect(html).toContain("RE-2026/0815");
    // Ohne Skonto keine Auswahl
    expect(html).not.toContain('type="radio"');
  });

  it("läuft ein Skonto, wählt man zwischen offenem Betrag und Abzug mit Frist; vorgewählt ist der offene Betrag", () => {
    const html = render(code([ohne, mit]));
    expect(html).toContain("Offener Betrag 215,63");
    expect(html).toMatch(/Mit 2\s%\sSkonto bis 22\.09\.2026: 211,32/);
    expect(html).toMatch(/<input type="radio" name="girocode-betrag" checked=""\/>Offener Betrag/);
    expect(html).toContain(encodeURIComponent(ohne.svg));
    expect(html).not.toContain(encodeURIComponent(mit.svg));
  });

  it("ohne Code steht der Grund, ohne Betrag in der Überschrift; der Link zum Kontakt nur, wenn der Kontakt das Problem behebt", () => {
    const ohneIban = code([], { iban: null, problem: "IBAN fehlt: im Kontakt des Lieferanten eintragen", problemImKontakt: true });
    const html = render(ohneIban, "c-1");
    expect(html).toContain("IBAN fehlt: im Kontakt des Lieferanten eintragen.");
    expect(html).toContain('<a href="/kontakte/c-1">Zum Kontakt</a>');
    expect(html).not.toContain("<img");
    expect(html).not.toContain("form-section-kurz");
    // Ohne Kontakt am Beleg kein Link
    expect(render(ohneIban)).not.toContain("<a ");
    // Offene IBAN-Entscheidung (#410), Fremdwährung: Der Kontakt hilft nicht, auch wenn noch keine IBAN gilt
    const entscheiden = code([], { iban: null, problem: "Die E-Rechnung nennt eine andere IBAN als der Kontakt: am Beleg entscheiden, welche gilt" });
    expect(render(entscheiden, "c-1")).not.toContain("Zum Kontakt");
    expect(render(code([], { iban: null, problem: "Rechnung in USD: SEPA überweist nur Euro" }), "c-1")).not.toContain("Zum Kontakt");
  });
});
