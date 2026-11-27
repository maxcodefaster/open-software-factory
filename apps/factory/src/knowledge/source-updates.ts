import { createHmac, timingSafeEqual } from "node:crypto";
import { and, asc, desc, eq, sql as expression, isNull, lt, or } from "drizzle-orm";
import { z } from "zod";
import type { createDatabase } from "#db/client";
import { operation, project as projectTable } from "#db/schema";
import type { createForgejoClient } from "#forge/forge";
import { CommandError } from "../command-error";
import { reportFailure } from "../failure-log";
import { factoryForgeSource } from "./forge-source";

const SOURCE_UPDATE_KIND = "knowledge.source_update";
const SOURCE_UPDATE_SCOPE_TYPE = "project";
const sourceUpdateKey = (projectID: string) => `${SOURCE_UPDATE_KIND}:${projectID}`;

type Database = ReturnType<typeof createDatabase>;
type Forge = Pick<
  ReturnType<typeof createForgejoClient>,
  "listPushHooks" | "createPushHook" | "configurePushHook" | "getDefaultBranch"
>;
const push = z.object({
  ref: z.string().max(300),
  after: z.string().regex(/^[a-f0-9]{40}$|^[a-f0-9]{64}$/),
  repository: z.object({ full_name: z.string().max(300), default_branch: z.string().max(200) }),
});

export function wikiHookSecret(key: string, projectID: string) {
  return createHmac("sha256", key).update(`factory-wiki-push:${projectID}`).digest("hex");
}

export function createWikiSourceUpdates(options: {
  database: Database;
  forge: Forge;
  apiURL: string;
  publicURL?: string;
  owner: string;
  receiverURL: string;
  signingKey: string;
  reconcile(projectID: string): Promise<void>;
}) {
  const db = options.database.db;
  const receiver = new URL(options.receiverURL);
  if (
    !["http:", "https:"].includes(receiver.protocol) ||
    receiver.username ||
    receiver.password ||
    options.signingKey.length < 32
  )
    throw new Error("Wiki webhook receiver and signing key must be configured securely");
  let draining: Promise<void> | undefined;
  async function project(projectID: string) {
    const [row] = await db
      .select({ url: projectTable.repositoryUrl, branch: projectTable.defaultBranch })
      .from(projectTable)
      .where(eq(projectTable.id, projectID));
    if (!row) throw new CommandError("not-found", "Project not found");
    return {
      ...row,
      repository: factoryForgeSource(row.url, options.apiURL, options.owner, options.publicURL),
    };
  }
  async function ensure(projectID: string) {
    const current = await project(projectID);
    const target = new URL(`/api/wiki/source-events/${projectID}`, receiver).href;
    const key = sourceUpdateKey(projectID);
    // Persist deterministic external intent before querying or creating a hook.
    await db
      .insert(operation)
      .values({
        id: crypto.randomUUID(),
        kind: SOURCE_UPDATE_KIND,
        scopeType: SOURCE_UPDATE_SCOPE_TYPE,
        scopeId: projectID,
        idempotencyKey: key,
        state: "create-intended",
        payload: expression<Record<string, unknown>>`jsonb_build_object(
          'projectId', ${projectID}::text,
          'targetUrl', ${target}::text,
          'hookId', NULL,
          'eventVersion', '0',
          'handledVersion', '0',
          'nextAttemptAt', now()
        )`,
      })
      .onConflictDoUpdate({
        target: operation.idempotencyKey,
        set: {
          payload: expression`${operation.payload} || jsonb_build_object('targetUrl', ${target}::text)`,
          updatedAt: expression`now()`,
        },
      });
    const lease = crypto.randomUUID();
    const claimed = await db
      .update(operation)
      .set({ leaseOwner: lease, leaseExpiresAt: expression`now()+interval '60 seconds'` })
      .where(
        and(
          eq(operation.kind, SOURCE_UPDATE_KIND),
          eq(operation.scopeType, SOURCE_UPDATE_SCOPE_TYPE),
          eq(operation.idempotencyKey, key),
          or(isNull(operation.leaseExpiresAt), lt(operation.leaseExpiresAt, expression`now()`)),
        ),
      )
      .returning({ projectId: operation.scopeId });
    if (!claimed.length) return;
    try {
      const matches = (await options.forge.listPushHooks(current.repository)).filter(
        (hook) => hook.targetURL === target,
      );
      if (matches.length > 1) throw new Error("Multiple Factory hooks share one identity");
      const secret = wikiHookSecret(options.signingKey, projectID);
      const id = matches[0]
        ? await options.forge.configurePushHook(
            current.repository,
            matches[0].id,
            target,
            secret,
            current.branch,
          )
        : await options.forge.createPushHook(current.repository, target, secret, current.branch);
      await db
        .update(operation)
        .set({
          state: "ready",
          error: null,
          payload: expression`${operation.payload} || jsonb_build_object('hookId', ${id}::bigint)`,
        })
        .where(
          and(
            eq(operation.kind, SOURCE_UPDATE_KIND),
            eq(operation.scopeType, SOURCE_UPDATE_SCOPE_TYPE),
            eq(operation.idempotencyKey, key),
            eq(operation.leaseOwner, lease),
          ),
        );
    } catch {
      // Never blind-retry an ambiguous create. The next ensure discovers the exact target first.
      await db
        .update(operation)
        .set({ state: "failed", error: "Wiki source hook setup needs retry." })
        .where(
          and(
            eq(operation.kind, SOURCE_UPDATE_KIND),
            eq(operation.scopeType, SOURCE_UPDATE_SCOPE_TYPE),
            eq(operation.idempotencyKey, key),
            eq(operation.leaseOwner, lease),
          ),
        );
    } finally {
      await db
        .update(operation)
        .set({ leaseOwner: null, leaseExpiresAt: null })
        .where(
          and(
            eq(operation.kind, SOURCE_UPDATE_KIND),
            eq(operation.scopeType, SOURCE_UPDATE_SCOPE_TYPE),
            eq(operation.idempotencyKey, key),
            eq(operation.leaseOwner, lease),
          ),
        );
    }
  }
  async function receive(request: Request, projectID: string): Promise<Response> {
    if (request.method !== "POST") return new Response(null, { status: 405 });
    const limit = 1024 * 1024;
    if (Number(request.headers.get("content-length")) > limit)
      return new Response(null, { status: 413 });
    const reader = request.body?.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    if (!reader) return new Response(null, { status: 400 });
    try {
      for (;;) {
        const value = await reader.read();
        if (value.done) break;
        size += value.value.byteLength;
        if (size > limit) {
          await reader.cancel();
          return new Response(null, { status: 413 });
        }
        chunks.push(value.value);
      }
    } finally {
      reader.releaseLock();
    }
    const body = Buffer.concat(chunks);
    const signature =
      request.headers.get("x-forgejo-signature") ?? request.headers.get("x-gitea-signature") ?? "";
    const expected = createHmac("sha256", wikiHookSecret(options.signingKey, projectID))
      .update(body)
      .digest();
    if (
      !/^[a-f0-9]{64}$/i.test(signature) ||
      !timingSafeEqual(Buffer.from(signature, "hex"), expected)
    )
      return new Response(null, { status: 403 });
    if ((request.headers.get("x-forgejo-event") ?? request.headers.get("x-gitea-event")) !== "push")
      return new Response(null, { status: 400 });
    let value: unknown;
    try {
      value = JSON.parse(body.toString("utf8"));
    } catch {
      return new Response(null, { status: 400 });
    }
    const parsed = push.safeParse(value);
    if (!parsed.success) return new Response(null, { status: 400 });
    const current = await project(projectID);
    if (
      parsed.data.repository.full_name !==
        `${current.repository.owner}/${current.repository.name}` ||
      parsed.data.repository.default_branch !== current.branch
    )
      return new Response(null, { status: 403 });
    if (parsed.data.ref !== `refs/heads/${current.branch}` || /^0+$/.test(parsed.data.after))
      return new Response(null, { status: 204 });
    const rows = await db
      .update(operation)
      .set({
        payload: expression`${operation.payload} || jsonb_build_object(
          'eventVersion', ((${operation.payload}->>'eventVersion')::bigint + 1)::text,
          'nextAttemptAt', CASE WHEN (${operation.payload}->>'handledVersion')::bigint=(${operation.payload}->>'eventVersion')::bigint
            THEN now()+interval '1 second'
            ELSE LEAST((${operation.payload}->>'nextAttemptAt')::timestamptz,now()+interval '1 second') END
        )`,
        updatedAt: expression`now()`,
      })
      .where(
        and(
          eq(operation.kind, SOURCE_UPDATE_KIND),
          eq(operation.scopeType, SOURCE_UPDATE_SCOPE_TYPE),
          eq(operation.idempotencyKey, sourceUpdateKey(projectID)),
        ),
      )
      .returning({ projectId: operation.scopeId });
    if (!rows.length) return new Response(null, { status: 503 });
    // This wake-up is expendable. Persisted versions recover after restart and before acknowledgement.
    void drain().catch(reportFailure("Wiki event reconciliation needs retry"));
    return new Response(null, { status: 202 });
  }
  async function drain() {
    if (draining) return draining;
    const task = (async () => {
      const pending = await db
        .select({
          id: operation.scopeId,
          version: expression<string>`((${operation.payload}->>'eventVersion')::bigint)::text`,
        })
        .from(operation)
        .where(
          and(
            eq(operation.kind, SOURCE_UPDATE_KIND),
            eq(operation.scopeType, SOURCE_UPDATE_SCOPE_TYPE),
            expression`(${operation.payload}->>'handledVersion')::bigint < (${operation.payload}->>'eventVersion')::bigint`,
            expression`(${operation.payload}->>'nextAttemptAt')::timestamptz <= now()`,
          ),
        )
        .orderBy(asc(operation.updatedAt))
        .limit(20);
      for (const row of pending) {
        try {
          await options.reconcile(row.id);
          const current = await project(row.id);
          const head = await options.forge.getDefaultBranch(current.repository);
          const [generation] = await db
            .select({
              state: operation.state,
              commit: expression<string>`${operation.payload}->>'sourceCommitSha'`,
            })
            .from(operation)
            .where(
              and(
                eq(operation.kind, "knowledge.generation"),
                eq(operation.scopeType, "project"),
                eq(operation.scopeId, row.id),
              ),
            )
            .orderBy(desc(operation.createdAt))
            .limit(1);
          if (
            generation?.state !== "succeeded" ||
            generation.commit !== head.headSha ||
            head.name !== current.branch
          ) {
            await db
              .update(operation)
              .set({
                payload: expression`${operation.payload} || jsonb_build_object('nextAttemptAt', now()+interval '15 seconds')`,
              })
              .where(
                and(
                  eq(operation.kind, SOURCE_UPDATE_KIND),
                  eq(operation.scopeType, SOURCE_UPDATE_SCOPE_TYPE),
                  eq(operation.idempotencyKey, sourceUpdateKey(row.id)),
                ),
              );
            continue;
          }
          await db
            .update(operation)
            .set({
              payload: expression`${operation.payload} || jsonb_build_object(
                'handledVersion', GREATEST((${operation.payload}->>'handledVersion')::bigint,${row.version}::bigint)::text
              )`,
              error: null,
            })
            .where(
              and(
                eq(operation.kind, SOURCE_UPDATE_KIND),
                eq(operation.scopeType, SOURCE_UPDATE_SCOPE_TYPE),
                eq(operation.idempotencyKey, sourceUpdateKey(row.id)),
              ),
            );
        } catch {
          await db
            .update(operation)
            .set({
              payload: expression`${operation.payload} || jsonb_build_object('nextAttemptAt', now()+interval '30 seconds')`,
              error: "Wiki source update will retry.",
            })
            .where(
              and(
                eq(operation.kind, SOURCE_UPDATE_KIND),
                eq(operation.scopeType, SOURCE_UPDATE_SCOPE_TYPE),
                eq(operation.idempotencyKey, sourceUpdateKey(row.id)),
              ),
            );
        }
      }
    })();
    draining = task;
    try {
      await task;
    } finally {
      if (draining === task) draining = undefined;
    }
  }
  async function repair() {
    const projects = await db
      .select({ id: projectTable.id })
      .from(projectTable)
      .orderBy(asc(projectTable.id));
    for (const row of projects) {
      try {
        await ensure(row.id);
      } catch {
        /* Unsupported source is rejected, never read through Forgejo. */
      }
    }
    await drain();
  }
  return { ensure, receive, drain, repair };
}
