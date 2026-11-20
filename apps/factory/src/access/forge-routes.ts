import { eq, sql as expression, isNull, or } from "drizzle-orm";
import { z } from "zod";
import { type createDatabase, drizzleTransaction } from "../../../../packages/db/src/client";
import {
  accessRevocation,
  accountAccess,
  forgeConnection,
} from "../../../../packages/db/src/schema";
import { reportFailure } from "../failure-log";
import { json } from "../http";
import { createAccessController } from "./controller";
import type { createIdentityConfiguration } from "./identity-configuration";

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
      const db = drizzleTransaction(options.database.client);
      await db
        .insert(forgeConnection)
        .values({
          sourceName: "Factory",
          discoveryUrl: input.discoveryURL,
          redirectUri: input.redirectURI,
          state: "create-intended",
          intendedBy: userID,
        })
        .onConflictDoNothing();
      const [intent] = await db
        .select({
          discoveryURL: forgeConnection.discoveryUrl,
          redirectURI: forgeConnection.redirectUri,
        })
        .from(forgeConnection);
      if (
        !intent ||
        intent.discoveryURL !== input.discoveryURL ||
        intent.redirectURI !== input.redirectURI
      )
        return json({ error: "Forge connection identity differs from its intent" }, 409);
      const clientID = await options.identity.ensureForgeClient(request.headers, input.redirectURI);
      return json({ clientID });
    }
    const { sourceID } = z
      .object({ sourceID: z.number().int().positive() })
      .strict()
      .parse(await request.json());
    const db = drizzleTransaction(options.database.client);
    const [intent] = await db
      .update(forgeConnection)
      .set({ sourceId: sourceID, state: "ready", observedAt: expression`now()` })
      .where(or(isNull(forgeConnection.sourceId), eq(forgeConnection.sourceId, sourceID)))
      .returning({ id: forgeConnection.id });
    if (!intent) return json({ error: "Forge source differs from its intended identity" }, 409);
    await db
      .insert(accessRevocation)
      .select(
        db
          .select({
            userId: accountAccess.userId,
            version: expression<number>`1`.as("version"),
            processedVersion: expression<number>`0`.as("processed_version"),
            updatedAt: expression<Date>`now()`.as("updated_at"),
          })
          .from(accountAccess),
      )
      .onConflictDoUpdate({
        target: accessRevocation.userId,
        set: {
          version: expression`${accessRevocation.version}+1`,
          updatedAt: expression`now()`,
        },
      });
    // Native connection readiness is separate from retained per-account reconciliation.
    // Failed accounts remain prohibited and the durable worker retries their intent.
    await options.reconcile().catch(reportFailure("Forge access reconciliation remains pending"));
    return new Response(null, { status: 204 });
  };
}
