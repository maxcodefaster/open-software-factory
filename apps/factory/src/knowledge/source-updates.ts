import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import type { createDatabase } from "../../../../packages/db/src/client";
import type { createForgejoClient } from "../../../../packages/forge/src/forge";
import { factoryForgeSource } from "./forge-source";
import { CommandError } from "../command-error";

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
  owner: string;
  receiverURL: string;
  signingKey: string;
  reconcile(projectID: string): Promise<void>;
  prepareProject?(projectID: string): Promise<void>;
}) {
  const sql = options.database.client;
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
    const [row] = await sql<Array<{ url: string; branch: string }>>`
      SELECT repository_url AS url,default_branch AS branch FROM factory.project WHERE id=${projectID}
    `;
    if (!row) throw new CommandError("not-found", "Project not found");
    return { ...row, repository: factoryForgeSource(row.url, options.apiURL, options.owner) };
  }
  async function ensure(projectID: string) {
    const current = await project(projectID);
    const target = new URL(`/api/wiki/source-events/${projectID}`, receiver).href;
    // Persist deterministic external intent before querying or creating a hook.
    await sql`INSERT INTO factory.wiki_source_update(project_id,target_url) VALUES(${projectID},${target})
      ON CONFLICT(project_id) DO UPDATE SET target_url=EXCLUDED.target_url,updated_at=now()`;
    const lease = crypto.randomUUID();
    const claimed =
      await sql`UPDATE factory.wiki_source_update SET hook_lease=${lease},hook_lease_until=now()+interval '60 seconds'
      WHERE project_id=${projectID} AND (hook_lease_until IS NULL OR hook_lease_until<now()) RETURNING project_id`;
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
      await sql`UPDATE factory.wiki_source_update SET hook_id=${id},hook_state='ready',failure=NULL
        WHERE project_id=${projectID} AND hook_lease=${lease}`;
    } catch {
      // Never blind-retry an ambiguous create. The next ensure discovers the exact target first.
      await sql`UPDATE factory.wiki_source_update SET hook_state='failed',failure='Wiki source hook setup needs retry.'
        WHERE project_id=${projectID} AND hook_lease=${lease}`;
    } finally {
      await sql`UPDATE factory.wiki_source_update SET hook_lease=NULL,hook_lease_until=NULL WHERE project_id=${projectID} AND hook_lease=${lease}`;
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
    const rows = await sql`UPDATE factory.wiki_source_update SET event_version=event_version+1,
      next_attempt_at=CASE WHEN handled_version=event_version THEN now()+interval '1 second'
        ELSE LEAST(next_attempt_at,now()+interval '1 second') END,updated_at=now()
      WHERE project_id=${projectID} RETURNING project_id`;
    if (!rows.length) return new Response(null, { status: 503 });
    // The same signed event admits image preparation independently of Wiki inference.
    await options.prepareProject?.(projectID);
    // This wake-up is expendable. Persisted versions recover after restart and before acknowledgement.
    void drain().catch(() => console.error("Wiki event reconciliation needs retry"));
    return new Response(null, { status: 202 });
  }
  async function drain() {
    if (draining) return draining;
    const task = (async () => {
      const pending = await sql<Array<{ id: string; version: string }>>`
        SELECT project_id AS id,event_version::text AS version FROM factory.wiki_source_update
        WHERE handled_version<event_version AND next_attempt_at<=now() ORDER BY updated_at LIMIT 20
      `;
      for (const row of pending) {
        try {
          await options.reconcile(row.id);
          const current = await project(row.id);
          const head = await options.forge.getDefaultBranch(current.repository);
          const [generation] = await sql<
            Array<{ state: string; commit: string }>
          >`SELECT state,source_commit_sha AS commit FROM factory.knowledge_generation
            WHERE project_id=${row.id} ORDER BY created_at DESC LIMIT 1`;
          if (
            generation?.state !== "succeeded" ||
            generation.commit !== head.headSha ||
            head.name !== current.branch
          ) {
            await sql`UPDATE factory.wiki_source_update SET next_attempt_at=now()+interval '15 seconds' WHERE project_id=${row.id}`;
            continue;
          }
          await sql`UPDATE factory.wiki_source_update SET handled_version=GREATEST(handled_version,${row.version}::bigint),failure=NULL WHERE project_id=${row.id}`;
        } catch {
          await sql`UPDATE factory.wiki_source_update SET next_attempt_at=now()+interval '30 seconds',failure='Wiki source update will retry.' WHERE project_id=${row.id}`;
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
    const projects = await sql<Array<{ id: string }>>`SELECT id FROM factory.project ORDER BY id`;
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
