import { createServerFn } from "@tanstack/react-start";
import { UserError } from "../errors.ts";
import { authMiddleware } from "../middleware.ts";
import { previewWisoAssets } from "../modules/archiv/index.ts";

export const previewWisoAssetsFn = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((input: unknown) => {
    const file = input instanceof FormData ? input.get("file") : null;
    if (!(file instanceof File) || file.size === 0 || file.size > 20 * 1024 * 1024) {
      throw new UserError("Bitte ein PDF mit höchstens 20 MB auswählen.");
    }
    return { file };
  })
  .handler(async ({ data }) => previewWisoAssets(new Uint8Array(await data.file.arrayBuffer())));
