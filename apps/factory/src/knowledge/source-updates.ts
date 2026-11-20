import { createHmac, timingSafeEqual } from "node:crypto";
import { and, asc, desc, eq, sql as expression, isNull, lt, lte, or } from "drizzle-orm";
import { z } from "zod";
import type { createDatabase } from "../../../../packages/db/src/client";
import {
  knowledgeGeneration,
  project as projectTable,
  wikiSourceUpdate,
} from "../../../../packages/db/src/schema";
import type { createForgejoClient } from "../../../../packages/forge/src/forge";
import { CommandError } from "../command-error";
import { reportFailure } from "../failure-log";
import { factoryForgeSource } from "./forge-source";

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
  prepareProject?(projectID: string): Promise<void>;
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
    // Persist deterministic external intent before querying or creating a hook.
    await db
      .insert(wikiSourceUpdate)
      .values({ projectId: projectID, targetUrl: target })
      .onConflictDoUpdate({
        target: wikiSourceUpdate.projectId,
        set: { targetUrl: target, updatedAt: expression`now()` },
      });
    const lease = crypto.randomUUID();
    const claimed = await db
      .update(wikiSourceUpdate)
      .set({ hookLease: lease, hookLeaseUntil: expression`now()+interval '60 seconds'` })
      .where(
        and(
          eq(wikiSourceUpdate.projectId, projectID),
          or(
            isNull(wikiSourceUpdate.hookLeaseUntil),
            lt(wikiSourceUpdate.hookLeaseUntil, expression`now()`),
          ),
        ),
      )
      .returning({ projectId: wikiSourceUpdate.projectId });
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
        .update(wikiSourceUpdate)
        .set({ hookId: id, hookState: "ready", failure: null })
        .where(
          and(eq(wikiSourceUpdate.projectId, projectID), eq(wikiSourceUpdate.hookLease, lease)),
        );
    } catch {
      // Never blind-retry an ambiguous create. The next ensure discovers the exact target first.
      await db
        .update(wikiSourceUpdate)
        .set({ hookState: "failed", failure: "Wiki source hook setup needs retry." })
        .where(
          and(eq(wikiSourceUpdate.projectId, projectID), eq(wikiSourceUpdate.hookLease, lease)),
        );
    } finally {
      await db
        .update(wikiSourceUpdate)
        .set({ hookLease: null, hookLeaseUntil: null })
        .where(
          and(eq(wikiSourceUpdate.projectId, projectID), eq(wikiSourceUpdate.hookLease, lease)),
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
      .update(wikiSourceUpdate)
      .set({
        eventVersion: expression`${wikiSourceUpdate.eventVersion}+1`,
        nextAttemptAt: expression`CASE WHEN ${wikiSourceUpdate.handledVersion}=${wikiSourceUpdate.eventVersion}
          THEN now()+interval '1 second' ELSE LEAST(${wikiSourceUpdate.nextAttemptAt},now()+interval '1 second') END`,
        updatedAt: expression`now()`,
      })
      .where(eq(wikiSourceUpdate.projectId, projectID))
      .returning({ projectId: wikiSourceUpdate.projectId });
    if (!rows.length) return new Response(null, { status: 503 });
    // The same signed event admits image preparation independently of Wiki inference.
    await options.prepareProject?.(projectID);
    // This wake-up is expendable. Persisted versions recover after restart and before acknowledgement.
    void drain().catch(reportFailure("Wiki event reconciliation needs retry"));
    return new Response(null, { status: 202 });
  }
  async function drain() {
    if (draining) return draining;
    const task = (async () => {
      const pending = await db
        .select({
          id: wikiSourceUpdate.projectId,
          version: expression<string>`${wikiSourceUpdate.eventVersion}::text`,
        })
        .from(wikiSourceUpdate)
        .where(
          and(
            lt(wikiSourceUpdate.handledVersion, wikiSourceUpdate.eventVersion),
            lte(wikiSourceUpdate.nextAttemptAt, expression`now()`),
          ),
        )
        .orderBy(asc(wikiSourceUpdate.updatedAt))
        .limit(20);
      for (const row of pending) {
        try {
          await options.reconcile(row.id);
          const current = await project(row.id);
          const head = await options.forge.getDefaultBranch(current.repository);
          const [generation] = await db
            .select({
              state: knowledgeGeneration.state,
              commit: knowledgeGeneration.sourceCommitSha,
            })
            .from(knowledgeGeneration)
            .where(eq(knowledgeGeneration.projectId, row.id))
            .orderBy(desc(knowledgeGeneration.createdAt))
            .limit(1);
          if (
            generation?.state !== "succeeded" ||
            generation.commit !== head.headSha ||
            head.name !== current.branch
          ) {
            await db
              .update(wikiSourceUpdate)
              .set({ nextAttemptAt: expression`now()+interval '15 seconds'` })
              .where(eq(wikiSourceUpdate.projectId, row.id));
            continue;
          }
          await db
            .update(wikiSourceUpdate)
            .set({
              handledVersion: expression`GREATEST(${wikiSourceUpdate.handledVersion},${row.version}::bigint)`,
              failure: null,
            })
            .where(eq(wikiSourceUpdate.projectId, row.id));
        } catch {
          await db
            .update(wikiSourceUpdate)
            .set({
              nextAttemptAt: expression`now()+interval '30 seconds'`,
              failure: "Wiki source update will retry.",
            })
            .where(eq(wikiSourceUpdate.projectId, row.id));
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
        await options.prepareProject?.(row.id);
      } catch {
        /* Unsupported source is rejected, never read through Forgejo. */
      }
    }
    await drain();
  }
  return { ensure, receive, drain, repair };
}
