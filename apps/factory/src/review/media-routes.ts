import { z } from "zod";
import { CommandError } from "../command-error";
import { json } from "../http";
import { reviewRequestBody } from "./http";
import type { createReviewMedia } from "./media";

export function createReviewMediaRoutes(
  media: Pick<ReturnType<typeof createReviewMedia>, "read" | "still">,
) {
  return async (request: Request, userID: string): Promise<Response | undefined> => {
    const route = new URL(request.url).pathname.match(
      /^\/api\/changes\/([0-9a-f-]{36})\/review\/(stills|media\/([0-9a-f-]{36}))$/,
    );
    if (!route?.[1]) return undefined;
    const changeID = z.uuid().parse(route[1]);
    if (route[3] && request.method === "GET")
      return media.read(changeID, userID, z.uuid().parse(route[3]), request.headers.get("range"));
    if (route[2] === "stills" && request.method === "POST") {
      const form = await new Response(await reviewRequestBody(request, 2_162_688), {
        headers: { "content-type": request.headers.get("content-type") ?? "" },
      }).formData();
      const file = form.get("frame");
      if (!(file instanceof File) || file.size > 2_097_152)
        throw new CommandError("conflict", "Annotation frame exceeds the 2 MiB limit");
      return json(
        await media.still(
          changeID,
          userID,
          JSON.parse(String(form.get("context"))),
          new Uint8Array(await file.arrayBuffer()),
          z.uuid().parse(form.get("id")),
        ),
        201,
      );
    }
    return new Response(null, { status: 405 });
  };
}
