import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import {
  bankverbindungAuswahl,
  bankverbindungSchema,
  createBankverbindung,
  listBankverbindungen,
  setBankverbindungArchived,
  updateBankverbindung,
} from "../modules/stammdaten/index.ts";
import { authMiddleware } from "../middleware.ts";

/** Weitere Bankverbindungen für Rechnungen und Angebote (#1887), auch archivierte */
export const getBankverbindungen = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .handler(() => listBankverbindungen());

/** Auswahl der Vorgabe am Kontakt: die weiteren und die IBAN des Standards */
export const getBankverbindungAuswahl = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .handler(() => bankverbindungAuswahl());

export const addBankverbindung = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(bankverbindungSchema)
  .handler(async ({ data, context }) => {
    const created = await createBankverbindung(context.user.id, data);
    return { id: created.id };
  });

export const saveBankverbindung = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(bankverbindungSchema.extend({ id: z.uuid() }))
  .handler(async ({ data: { id, ...input }, context }) => {
    await updateBankverbindung(context.user.id, id, input);
    return { ok: true };
  });

export const archiveBankverbindung = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(z.object({ id: z.uuid(), archived: z.boolean() }))
  .handler(async ({ data, context }) => {
    await setBankverbindungArchived(context.user.id, data.id, data.archived);
    return { ok: true };
  });
