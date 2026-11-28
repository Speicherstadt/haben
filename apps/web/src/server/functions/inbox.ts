import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import {
  deleteInboxSettings,
  discardOutgoing,
  fetchInbox,
  inboxSettingsSchema,
  inboxSummary,
  listOutgoing,
  outgoingFile,
  saveInboxSettings,
} from "../modules/belege/index.ts";
import { authMiddleware } from "../middleware.ts";

export const getInbox = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .handler(() => inboxSummary());

export const saveInbox = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(inboxSettingsSchema)
  .handler(async ({ data, context }) => {
    await saveInboxSettings(context.user.id, data);
    return { ok: true };
  });

export const removeInbox = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .handler(async ({ context }) => {
    await deleteInboxSettings(context.user.id);
    return { ok: true };
  });

/** Jetzt abrufen; die KI-Auslesung läuft im Hintergrund weiter */
export const fetchInboxNow = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .handler(async ({ context }) => fetchInbox(context.user.id, (work) => void work.catch(() => {})));

/** Ausgangsrechnungen aus dem Postfach, die auf „Übernehmen“ warten */
export const getInboxOutgoing = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .handler(async () => {
    const rows = await listOutgoing();
    return rows.map((r) => ({ id: r.id, filename: r.filename, sender: r.sender, subject: r.subject, receivedAt: r.receivedAt, size: r.size }));
  });

/** Das PDF einer wartenden Ausgangsrechnung, base64, für das Formular zum Übernehmen */
export const readInboxOutgoing = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(z.object({ id: z.uuid() }))
  .handler(async ({ data }) => {
    const { row, bytes } = await outgoingFile(data.id);
    return { filename: row.filename, mimeType: row.mimeType, base64: Buffer.from(bytes).toString("base64") };
  });

export const discardInboxOutgoing = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(z.object({ id: z.uuid() }))
  .handler(async ({ data, context }) => {
    await discardOutgoing(context.user.id, data.id);
    return { ok: true };
  });
