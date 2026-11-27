import { describe, expect, it } from "vitest";
import { pdfEingabe } from "./ExtractionCard.tsx";

describe("pdfEingabe", () => {
  it("nennt, was nach EXTRACTION_INPUT bei PDFs an den eigenen Dienst geht", () => {
    expect(pdfEingabe("text", 4)).toBe("Text der ersten 4 Seiten aus der Textschicht, keine Bilder; Scans und Fotos liest der Dienst nicht");
    expect(pdfEingabe("bild", 4)).toBe("Die ersten 4 Seiten als Bilder");
    expect(pdfEingabe("text-und-bild", 4)).toBe("Text der ersten 4 Seiten aus der Textschicht und die Seiten als Bilder");
  });

  it("spricht bei einer Seite von der ersten Seite", () => {
    expect(pdfEingabe("bild", 1)).toBe("Die erste Seite als Bild");
    expect(pdfEingabe("text", 1)).toMatch(/^Text der ersten Seite aus/);
    expect(pdfEingabe("text-und-bild", 1)).toBe("Text der ersten Seite aus der Textschicht und die Seite als Bild");
  });
});
