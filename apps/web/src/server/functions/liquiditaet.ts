import { HORIZONT_KEYS, inCents, MINDESTBESTAND_MAX } from "@haben/core";
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { liquiditaetsvorschau, mindestbestandWarnung } from "../modules/liquiditaet/index.ts";
import { setMindestbestand } from "../modules/stammdaten/index.ts";
import { authMiddleware, readMiddleware } from "../middleware.ts";
import { today } from "../today.ts";

/** Liquiditätsvorschau für die Seite „Auswertungen › Liquidität“ (#1381); `ueberfaellige: false` lässt überfällige Forderungen weg */
export const getLiquiditaet = createServerFn({ method: "GET" })
  .middleware([readMiddleware])
  .validator(z.object({ horizont: z.enum(HORIZONT_KEYS), ueberfaellige: z.boolean() }))
  .handler(({ data }) => liquiditaetsvorschau(today(), data.horizont, { ueberfaellige: data.ueberfaellige }));

/**
 * Für „Zu erledigen“ in der Übersicht: erster Tag der nächsten 13 Wochen unter dem Mindestbestand, sonst null. Ein Fehler
 * der Vorschau steht im Log und lässt die Übersicht stehen; die Liquiditätsvorschau selbst zeigt ihn.
 */
export const getMindestbestandWarnung = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .handler(() =>
    mindestbestandWarnung(today()).catch((error: unknown) => {
      console.error("Mindestbestand: Vorschau nicht berechnet", error);
      return null;
    }),
  );

/** Mindestbestand in Cent; null = keine Warnung */
export const saveMindestbestand = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(z.object({ mindestbestand: inCents(z.number().int().min(0).max(MINDESTBESTAND_MAX)).nullable() }))
  .handler(({ data, context }) => setMindestbestand(context.user.email, data.mindestbestand));
