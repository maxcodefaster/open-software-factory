import { z } from "zod";
import type { createDatabase } from "../../../../packages/db/src/client";
import type { createIdentityConfiguration } from "./identity-configuration";
import { createAccessController } from "./controller";
import { json } from "../http";

export function createForgeIdentityRoutes(options: {
  database: ReturnType<typeof createDatabase>;
  identity: Pick<ReturnType<typeof createIdentityConfiguration>, "ensureForgeClient"> & {
    requireFresh: (request: Request) => Promise<unknown>;
  };
  forgeOrigin: string;
  discoveryURL: string;
  reconcile: () => Promise<void>;
}) {
  const access = createAccessController(options.database);
  return async (request: Request, userID: string): Promise<Response | undefined> => {
    const path = new URL(request.url).pathname;
    if (!["/api/admin/forge/client", "/api/admin/forge/connection"].includes(path))
      return undefined;
    if (request.method !== "POST") return new Response(null, { status: 405 });
    await access.requireSystemManager(userID);
    await options.identity.requireFresh(request);
    if (path.endsWith("/client")) {
      const input = z
        .object({ redirectURI: z.url(), discoveryURL: z.url() })
        .strict()
        .parse(await request.json());
      const callback = new URL(input.redirectURI);
      if (
        callback.origin !== options.forgeOrigin ||
        callback.pathname !== "/user/oauth2/Factory/callback" ||
        callback.username ||
        callback.password ||
        callback.search ||
        callback.hash
      )
        return json({ error: "Forge callback differs from this installation" }, 400);
      if (input.discoveryURL !== options.discoveryURL)
        return json({ error: "Forge discovery differs from this installation" }, 400);
      // Record the native source identity before creating its OAuth client.
      await options.database
        .client`INSERT INTO factory.forge_connection(source_name,discovery_url,redirect_uri,state,intended_by)
        VALUES('Factory',${input.discoveryURL},${input.redirectURI},'create-intended',${userID}) ON CONFLICT DO NOTHING`;
      const [intent] = await options.database.client<{ matches: boolean }[]>`
        SELECT discovery_url=${input.discoveryURL} AND redirect_uri=${input.redirectURI} AS matches FROM factory.forge_connection`;
      if (!intent?.matches)
        return json({ error: "Forge connection identity differs from its intent" }, 409);
      const clientID = await options.identity.ensureForgeClient(request.headers, input.redirectURI);
      return json({ clientID });
    }
    const { sourceID } = z
      .object({ sourceID: z.number().int().positive() })
      .strict()
      .parse(await request.json());
    const [intent] = await options.database
      .client`UPDATE factory.forge_connection SET source_id=${sourceID},state='ready',observed_at=now()
      WHERE source_id IS NULL OR source_id=${sourceID} RETURNING id`;
    if (!intent) return json({ error: "Forge source differs from its intended identity" }, 409);
    await options.database
      .client`INSERT INTO factory.access_revocation(user_id,version,processed_version) SELECT user_id,1,0 FROM factory.account_access
      ON CONFLICT(user_id) DO UPDATE SET version=factory.access_revocation.version+1,updated_at=now()`;
    // Native connection readiness is separate from retained per-account reconciliation.
    // Failed accounts remain prohibited and the durable worker retries their intent.
    await options
      .reconcile()
      .catch(() => console.error("Forge access reconciliation remains pending"));
    return new Response(null, { status: 204 });
  };
}
