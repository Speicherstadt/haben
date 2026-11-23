import { describe, expect, it } from "vitest";
import { afterRender, previewFailure, renderDelay, rendersOnDemand } from "./vorschau-render.ts";

describe("Takt der echten Vorschau", () => {
  it("wartet mindestens eine halbe Sekunde", () => {
    expect(renderDelay(0)).toBe(500);
    expect(renderDelay(20)).toBe(500);
    expect(renderDelay(250)).toBe(500);
  });

  it("wartet bei langsamen Rechnern das Doppelte der letzten Renderzeit", () => {
    expect(renderDelay(600)).toBe(1200);
  });

  it("rendert erst über zwei Sekunden nur noch auf Knopfdruck", () => {
    expect(rendersOnDemand(2000)).toBe(false);
    expect(rendersOnDemand(2001)).toBe(true);
  });
});

describe("Hinweis auf einen veralteten Stand nach dem Rendern", () => {
  it("bleibt, wenn sich das Formular während eines langsamen Laufs geändert hat", () => {
    expect(afterRender("alt", "neu", 2500)).toBe("knopf");
  });

  it("verschwindet, wenn das Blatt zum Formular passt", () => {
    expect(afterRender("neu", "neu", 2500)).toBe("fertig");
  });

  it("setzt nach einem schnellen Lauf gleich neu, wenn das Formular weiter ist", () => {
    expect(afterRender("alt", "neu", 300)).toBe("neu");
  });
});

describe("Meldung, wenn das Blatt nicht gesetzt werden kann (#1147)", () => {
  it("nennt bei einem Netzfehler des Browsers einen deutschen Satz statt seines Textes", () => {
    // Chromium, Firefox, Safari
    for (const text of ["Failed to fetch", "NetworkError when attempting to fetch resource.", "Load failed"]) {
      expect(previewFailure(new TypeError(text))).toBe("Die Vorschau ließ sich nicht erzeugen. Haben ist gerade nicht erreichbar.");
    }
  });

  it("nennt bei einer Fehlerseite des Reverse Proxys (Haben startet neu) denselben Satz statt ihres Inhalts", () => {
    // TanStack Start wirft den Text einer Antwort ohne eigenes Format: nginx schickt HTML, Caddy (deploy/Caddyfile) einen
    // leeren 502 ohne Content-Type („Invariant failed“), Traefik den Statustext
    for (const text of [
      "<html>\r\n<head><title>502 Bad Gateway</title></head>\r\n<body>\r\n<center><h1>502 Bad Gateway</h1></center>\r\n</body>\r\n</html>",
      "Invariant failed",
      "Invariant failed: expected content-type header to be set",
      "Bad Gateway",
      "Service Unavailable",
      "Gateway Timeout",
    ]) {
      expect(previewFailure(new Error(text))).toBe("Die Vorschau ließ sich nicht erzeugen. Haben ist gerade nicht erreichbar.");
    }
  });

  it("erkennt auch Traefik, solange Haben startet und noch nicht gesund ist", () => {
    // Die Provider für Docker und Kubernetes lassen einen Container ohne Healthy oder einen Dienst ohne Endpunkte weg
    // (traefik v3.6, pkg/provider/docker/config.go, pkg/provider/kubernetes/ingress/kubernetes.go): Dann antwortet Go mit
    // http.NotFound, mit allowEmptyServices der Load Balancer (wrr.go) mit 503. http.Error hängt einen Zeilenumbruch an.
    for (const text of ["404 page not found\n", "no available server\n"]) {
      expect(previewFailure(new Error(text))).toBe("Die Vorschau ließ sich nicht erzeugen. Haben ist gerade nicht erreichbar.");
    }
  });

  it("hängt eine Meldung des Servers an den eigenen Satz", () => {
    expect(previewFailure(new Error("Das Layout „Eigenes“ braucht das Feld kunde.name."))).toBe(
      "Die Vorschau ließ sich nicht erzeugen. Das Layout „Eigenes“ braucht das Feld kunde.name.",
    );
    expect(previewFailure(new Error("Interner Fehler. Details stehen im Server-Log."))).toBe(
      "Die Vorschau ließ sich nicht erzeugen. Interner Fehler. Details stehen im Server-Log.",
    );
  });

  it("doppelt den Satz nicht, wenn der Server ihn schon nennt (renderPreview)", () => {
    expect(previewFailure(new Error("Die Vorschau ließ sich nicht erzeugen. Das PDF ist davon nicht betroffen."))).toBe(
      "Die Vorschau ließ sich nicht erzeugen. Das PDF ist davon nicht betroffen.",
    );
  });

  it("hält einen anderen TypeError nicht für einen Netzfehler", () => {
    expect(previewFailure(new TypeError("x is not a function"))).toBe("Die Vorschau ließ sich nicht erzeugen. x is not a function");
  });

  it("nennt ohne Meldung nur den eigenen Satz", () => {
    expect(previewFailure(new Error(""))).toBe("Die Vorschau ließ sich nicht erzeugen.");
    expect(previewFailure("kaputt")).toBe("Die Vorschau ließ sich nicht erzeugen.");
  });
});
