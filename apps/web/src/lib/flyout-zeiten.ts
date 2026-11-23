// Zeiten der Gruppen-Flyouts in der eingeklappten Navigation (components/NavFlyout.tsx); die E2E-Tests stellen die Uhr danach

// Öffnen sofort wie bei GitLab; den schrägen Weg ins Flyout schützt der Zielkurs. Schließen mit Verzug, damit der
// Weg über die Lücke ins Flyout reicht (WCAG 1.4.13, „hoverable“)
export const SCHLIESSEN_NACH = 300;
// Hält der Zeiger Kurs auf ein offenes Flyout (lib/zielkurs.ts), prüft das gestreifte Symbol so oft nach
export const KURS_NACHPRUEFEN = 50;
// Ohne Bewegung so lange gilt der Zeiger als stehend
export const STILL_NACH = 60;
