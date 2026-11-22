import { compareWisoGoBd, WisoParseError } from "@haben/import";
import { createServerFn } from "@tanstack/react-start";
import { UserError } from "../errors.ts";
import { authMiddleware } from "../middleware.ts";
import { MAX_WISO_CSV_SIZE } from "../modules/archiv/index.ts";

function files(input: unknown) {
  if (!(input instanceof FormData)) throw new UserError("FormData erwartet");
  const bookings = input.get("bookings");
  const trialBalance = input.get("trialBalance");
  if (!(bookings instanceof File) || bookings.size === 0) throw new UserError("Bitte die GoBD-Buchungsliste auswählen.");
  if (!(trialBalance instanceof File) || trialBalance.size === 0) throw new UserError("Bitte die GoBD-SuSa auswählen.");
  if (bookings.size + trialBalance.size > MAX_WISO_CSV_SIZE) throw new UserError("Die beiden Dateien sind zusammen größer als 100 MB.");
  return { bookings, trialBalance };
}

export const checkWisoGoBd = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(files)
  .handler(async ({ data }) => {
    const [bookings, trialBalance] = await Promise.all([data.bookings.arrayBuffer(), data.trialBalance.arrayBuffer()]);
    try {
      return compareWisoGoBd(new Uint8Array(bookings), new Uint8Array(trialBalance));
    } catch (error) {
      if (error instanceof WisoParseError) throw new UserError(error.message);
      throw error;
    }
  });
