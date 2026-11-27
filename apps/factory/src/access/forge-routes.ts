import { and, eq, sql as expression, or } from "drizzle-orm";
import { z } from "zod";
import { type createDatabase, drizzleTransaction } from "#db/client";
import { operation } from "#db/schema";
import { reportFailure } from "../failure-log";
import { json } from "../http";
import { createAccessController } from "./controller";
import type { createIdentityConfiguration } from "./identity-configuration";

const FORGE_CONNECTION_KIND = "access.forge_connection";
const FORGE_CONNECTION_KEY = "access.forge_connection:singleton";
const INSTALLATION_SCOPE_ID = "00000000-0000-0000-0000-000000000000";

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
        .insert(operation)
        .values({
          id: crypto.randomUUID(),
          kind: FORGE_CONNECTION_KIND,
          scopeType: "installation",
          scopeId: INSTALLATION_SCOPE_ID,
          idempotencyKey: FORGE_CONNECTION_KEY,
          activeKey: null,
          state: "create-intended",
          createdBy: userID,
          payload: {
            sourceName: "Factory",
            discoveryUrl: input.discoveryURL,
            redirectUri: input.redirectURI,
            sourceId: null,
            intendedBy: userID,
            observedAt: null,
          },
        })
        .onConflictDoNothing({ target: operation.idempotencyKey });
      const [intent] = await db
        .select({
          discoveryURL: expression<string>`${operation.payload}->>'discoveryUrl'`,
          redirectURI: expression<string>`${operation.payload}->>'redirectUri'`,
        })
        .from(operation)
        .where(
          and(
            eq(operation.kind, FORGE_CONNECTION_KIND),
            eq(operation.idempotencyKey, FORGE_CONNECTION_KEY),
          ),
        );
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
    const observedAt = new Date().toISOString();
    const [intent] = await db
      .update(operation)
      .set({
        state: "ready",
        payload: expression`${operation.payload} || ${JSON.stringify({
          sourceId: sourceID,
          observedAt,
        })}::jsonb`,
        completedAt: expression`COALESCE(${operation.completedAt}, now())`,
        updatedAt: expression`now()`,
      })
      .where(
        and(
          eq(operation.kind, FORGE_CONNECTION_KIND),
          eq(operation.idempotencyKey, FORGE_CONNECTION_KEY),
          or(
            expression`(${operation.payload}->>'sourceId') IS NULL`,
            expression`(${operation.payload}->>'sourceId') = ${String(sourceID)}`,
          ),
        ),
      )
      .returning({ id: operation.id });
    if (!intent) return json({ error: "Forge source differs from its intended identity" }, 409);
    await options.database.client`
      INSERT INTO factory.operation(
        id, kind, scope_type, scope_id, idempotency_key, active_key, state, payload, updated_at
      )
      SELECT
        gen_random_uuid(),
        'access.revocation',
        'user',
        user_id::text,
        'access.revocation:' || user_id::text,
        NULL,
        'pending',
        jsonb_build_object('userId', user_id::text, 'version', 1, 'processedVersion', 0),
        now()
      FROM factory.account_access
      ON CONFLICT (idempotency_key) DO UPDATE SET
        state = 'pending',
        payload = jsonb_set(
          factory.operation.payload,
          '{version}',
          to_jsonb(((factory.operation.payload->>'version')::bigint + 1))
        ),
        completed_at = NULL,
        updated_at = now()`;
    // Native connection readiness is separate from retained per-account reconciliation.
    // Failed accounts remain prohibited and the durable worker retries their intent.
    await options.reconcile().catch(reportFailure("Forge access reconciliation remains pending"));
    return new Response(null, { status: 204 });
  };
}
