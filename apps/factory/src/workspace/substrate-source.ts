import { createHash, randomBytes } from "node:crypto";
import { lstat, mkdir, mkdtemp, open, readFile, rename, rmdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { z } from "zod";
import type { createDatabase } from "../../../../packages/db/src/client";
import { hashConnectorToken } from "../../../../packages/runtime-domain/src/identity";
import type { AgentTurnTransaction } from "../agent/turn-store";
import { CommandError } from "../command-error";
import type { RuntimeHub } from "../runtime/hub";
import { substrateRuntimePrincipalIn, substrateWorkspaceGrantIn } from "../runtime/substrate-grant";
import { createPrivateObjects, objectDigest, type PrivateObjects } from "../storage/objects";
import {
  readSourcePreservation,
  type SourcePreservation,
  sourcePreservation,
} from "./substrate-source-preservation";

type Database = ReturnType<typeof createDatabase>;
type SQL = Database["client"] | AgentTurnTransaction;
const digest = z.string().regex(/^[a-f0-9]{64}$/);
export const sourceBundle = z
  .strictObject({
    version: z.literal(1),
    bytes: z
      .number()
      .int()
      .positive()
      .max(4 * 2 ** 30),
    sha256: digest,
    chunks: z.array(digest).min(1).max(4096),
  })
  .refine((b) => b.chunks.length === Math.ceil(b.bytes / (1 << 20)));
const checkpoint = z.strictObject({
  id: z.uuid(),
  workspaceID: z.uuid(),
  actorUID: z.uuid(),
  writerEpoch: z.number().int().positive(),
  generation: z.number().int().positive(),
  bundle: sourceBundle,
});
type Checkpoint = z.infer<typeof checkpoint>;
export type SubstrateSourceLease = {
  workspaceID: string;
  actorUID: string;
  owner: "actor" | "service";
  writerEpoch: number;
  writable: boolean;
  generation: number;
  checkpointID: string | null;
  checkpoint: Checkpoint | null;
  serviceBase: string | null;
  preservation: SourcePreservation | null;
};
export type SubstrateSourceHandoff = Pick<
  ReturnType<typeof createSubstrateSources>,
  "attach" | "freezeActor" | "paused" | "resume"
>;

function objectKey(saved: Checkpoint, suffix: string) {
  return `workspace-source/v1/${saved.workspaceID}/${saved.id}/${suffix}`;
}
function checkedBundle(data: Uint8Array, saved: Checkpoint, index: number) {
  if (
    data.byteLength !== Math.min(1 << 20, saved.bundle.bytes - index * (1 << 20)) ||
    objectDigest(data) !== saved.bundle.chunks[index]
  )
    throw new CommandError(
      "unavailable",
      "Confirmed Source chunk is missing or corrupt. Old data was retained.",
    );
  return data;
}

// Concrete Source handoff only. The existing Workspace runtime lock serializes
// these bounded functions; this is not another runtime or lifecycle controller.
export function createSubstrateSources(
  database: Database,
  hub: RuntimeHub,
  objects: PrivateObjects = createPrivateObjects(),
) {
  let revoke = (_workspaceID: string) => {};
  const root = resolve(
    process.env["FACTORY_STATE_DIRECTORY"] ?? "/var/lib/factory",
    "workspace-source",
  );
  const binary =
    process.env["FACTORY_SOURCE_SERVICE_BINARY"] ?? "/usr/local/bin/factory-runtime-connector";
  const hosts = new Map<
    string,
    {
      epoch: number;
      base: string;
      token: string;
      socket: string;
      directory: string;
      child: ReturnType<typeof Bun.spawn>;
      ready: Promise<void>;
    }
  >();
  async function lease(
    workspaceID: string,
    sql: SQL = database.client,
  ): Promise<SubstrateSourceLease | null> {
    const [row] = await sql<
      SubstrateSourceLease[]
    >`SELECT workspace_id AS "workspaceID",actor_uid::text AS "actorUID",owner,writer_epoch::float8 AS "writerEpoch",writable,generation::float8 AS generation,checkpoint_id::text AS "checkpointID",checkpoint,service_base::text AS "serviceBase",preservation FROM factory.substrate_source WHERE workspace_id=${workspaceID}`;
    if (row?.checkpoint) row.checkpoint = checkpoint.parse(row.checkpoint);
    if (row?.preservation) row.preservation = sourcePreservation.parse(row.preservation);
    return row ?? null;
  }
  async function sourceRequest(
    workspaceID: string,
    attemptID: string,
    row: SubstrateSourceLease,
    operation: string,
    request: Request,
    sql: SQL,
  ) {
    if (row.owner === "actor")
      return hub.request(
        attemptID,
        "source",
        request,
        `/v1/workspaces/${workspaceID}/${operation}`,
      );
    const host = await service(row, sql);
    return fetch(`http://source.internal/v1/workspaces/${workspaceID}/${operation}`, {
      unix: host.socket,
      method: request.method,
      redirect: "error",
      signal: request.signal,
      headers: {
        authorization: `Bearer ${host.token}`,
        "X-Factory-Source-Service": `source-${workspaceID.replaceAll("-", "")}`,
        "X-Factory-Source-Epoch": String(host.epoch),
        "X-Factory-Writer-Epoch": request.headers.get("X-Factory-Writer-Epoch") ?? "",
        "content-type": "application/json",
      },
      ...(request.method === "GET" ? {} : { body: await request.arrayBuffer() }),
    });
  }
  async function stopHost(workspaceID: string) {
    const host = hosts.get(workspaceID);
    if (!host) return;
    host.child.kill("SIGTERM");
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        host.child.exited,
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () =>
              reject(
                new CommandError(
                  "unavailable",
                  "Source service termination is unconfirmed; owner was not transferred",
                ),
              ),
            10_000,
          );
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
    hosts.delete(workspaceID);
    await rmdir(host.directory).catch(() => {}); // empty, exact owned IPC directory only
  }
  async function materialize(saved: Checkpoint, base: string) {
    await verifiedManifest(saved);
    const marker = join(base, "confirmed.json");
    try {
      if ((await readFile(marker, "utf8")) !== JSON.stringify(saved))
        throw new Error("Source materialization identity changed");
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    try {
      await lstat(base);
      throw new CommandError("unavailable", "Unconfirmed existing Source was preserved");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    // A previous incomplete extraction is never reused or deleted. New staging
    // identity, validated complete archive and its marker publish together. A
    // process crash must not leave a published tree without its confirmation.
    await mkdir(dirname(base), { recursive: true, mode: 0o700 });
    const staging = await mkdtemp(join(dirname(base), `staging-${saved.id}-`));
    const file = join(staging, "source.tar");
    const output = await open(file, "wx", 0o600);
    const hash = createHash("sha256");
    try {
      for (let i = 0; i < saved.bundle.chunks.length; i++) {
        const bytes = checkedBundle(await objects.read(objectKey(saved, `chunk-${i}`)), saved, i);
        hash.update(bytes);
        await output.writeFile(bytes);
      }
      await output.sync();
    } finally {
      await output.close();
    }
    if (hash.digest("hex") !== saved.bundle.sha256)
      throw new CommandError("unavailable", "Source bundle checksum differs; old data retained");
    const child = Bun.spawn([binary, "source-materialize", file, join(staging, "project")], {
      stdout: "ignore",
      stderr: "ignore",
      env: { PATH: process.env["PATH"] ?? "/usr/bin:/bin" },
    });
    if (await child.exited)
      throw new CommandError(
        "unavailable",
        "Source metadata/materialization is unsupported or corrupt; old data retained",
      );
    const confirmation = await open(join(staging, "confirmed.json"), "wx", 0o600);
    try {
      await confirmation.writeFile(JSON.stringify(saved));
      await confirmation.sync();
    } finally {
      await confirmation.close();
    }
    const staged = await open(staging, "r");
    try {
      await staged.sync();
    } finally {
      await staged.close();
    }
    // The existing Workspace lock excludes another publication or file writer.
    await rename(staging, base);
    const parent = await open(dirname(base), "r");
    try {
      await parent.sync();
    } finally {
      await parent.close();
    }
  }
  async function writer(row: SubstrateSourceLease, sql: SQL) {
    const [workspace] = await sql<
      { kind: string; epoch: number | null; writable: boolean | null }[]
    >`SELECT w.kind,c.epoch::float8 AS epoch,
      (c.state='human' AND change.state IN ('starting','active','failed')
        AND change.cancel_requested_at IS NULL AND ticket.trashed_at IS NULL) AS writable
      FROM factory.development_workspace w
      LEFT JOIN factory.change_writer c ON c.change_id=w.change_id
      LEFT JOIN factory.change change ON change.id=w.change_id
      LEFT JOIN factory.ticket ticket ON ticket.id=w.ticket_id
      WHERE w.id=${row.workspaceID} AND w.substrate`;
    if (!workspace || (workspace.kind !== "personal" && !workspace.epoch))
      throw new CommandError("unavailable", "Current Source writing authority is unavailable");
    return {
      epoch: workspace.epoch ?? row.writerEpoch,
      writable: row.writable && (workspace.kind === "personal" || workspace.writable === true),
    };
  }
  async function service(row: SubstrateSourceLease, sql: SQL) {
    if (row.owner !== "service" || !row.serviceBase || !row.checkpoint)
      throw new CommandError("unavailable", "Independent Source owner is unconfirmed");
    const retained = hosts.get(row.workspaceID);
    if (retained?.base === row.serviceBase && retained.child.exitCode === null) {
      await retained.ready;
      return retained;
    }
    if (retained) await stopHost(row.workspaceID);
    const base = join(root, row.workspaceID, row.serviceBase);
    // Its base stays fixed throughout offline edits and freeze retries. Never
    // import a prior checkpoint over an existing service-owned dirty tree.
    const marker = join(base, "confirmed.json");
    if (
      !(await stat(marker).then(
        () => true,
        () => false,
      ))
    ) {
      if (row.checkpoint.id !== row.serviceBase)
        throw new CommandError(
          "unavailable",
          "Service-owned Source is missing; reinitialization refused",
        );
      await materialize(row.checkpoint, base);
    }
    let materialized: Checkpoint;
    try {
      materialized = checkpoint.parse(JSON.parse(await readFile(marker, "utf8")));
    } catch {
      throw new CommandError(
        "unavailable",
        "Source materialization identity changed; existing data was preserved",
      );
    }
    if (
      materialized.id !== row.serviceBase ||
      materialized.workspaceID !== row.workspaceID ||
      materialized.actorUID !== row.actorUID ||
      materialized.writerEpoch >= row.writerEpoch ||
      materialized.generation > row.generation
    )
      throw new CommandError(
        "unavailable",
        "Source materialization identity changed; existing data was preserved",
      );
    await verifiedManifest(materialized);
    const role = await writer(row, sql);
    const access = {
      workspaceId: row.workspaceID,
      serviceId: `source-${row.workspaceID.replaceAll("-", "")}`,
      epoch: row.writerEpoch,
      ownerEpoch: row.writerEpoch,
      writerEpoch: role.epoch,
      readOnly: !role.writable,
      token: randomBytes(32).toString("hex"),
    };
    const directory = await mkdtemp(join(tmpdir(), "factory-source-"));
    const socket = join(directory, "api.sock");
    const child = Bun.spawn([binary, "source-host"], {
      stdin: new Blob([JSON.stringify({ root: join(base, "project"), socket, access })]),
      stdout: "ignore",
      stderr: "ignore",
      env: { PATH: process.env["PATH"] ?? "/usr/bin:/bin" },
    });
    const host = {
      epoch: row.writerEpoch,
      base: row.serviceBase,
      token: access.token,
      socket,
      directory,
      child,
      ready: Promise.resolve(),
    };
    host.ready = (async () => {
      for (let i = 0; i < 100; i++) {
        if (child.exitCode !== null)
          throw new CommandError("unavailable", "Independent Source process exited");
        try {
          const result = await fetch(
            `http://source.internal/v1/workspaces/${row.workspaceID}/stat`,
            {
              unix: socket,
              method: "POST",
              body: '{"path":""}',
              headers: {
                authorization: `Bearer ${access.token}`,
                "X-Factory-Source-Service": access.serviceId,
                "X-Factory-Source-Epoch": String(access.epoch),
              },
              signal: AbortSignal.timeout(1000),
            },
          );
          if (result.ok) {
            await result.body?.cancel();
            return;
          }
          await result.body?.cancel();
        } catch {
          /* bounded connection readiness only */
        }
        await Bun.sleep(100);
      }
      throw new CommandError("unavailable", "Independent Source connection is unconfirmed");
    })();
    hosts.set(row.workspaceID, host);
    await host.ready;
    return host;
  }
  async function freeze(workspaceID: string, owner: "actor" | "service", sql: SQL) {
    let row = await lease(workspaceID, sql);
    if (!row || row.owner !== owner) throw new CommandError("conflict", "Source owner changed");
    if (row.writable) {
      const id = crypto.randomUUID();
      await sql`UPDATE factory.substrate_source SET writer_epoch=writer_epoch+1,writable=false,checkpoint_id=${id} WHERE workspace_id=${workspaceID} AND owner=${owner} AND writer_epoch=${row.writerEpoch} AND writable`;
      row = await lease(workspaceID, sql);
    }
    if (!row || row.writable || !row.checkpointID)
      throw new CommandError("conflict", "Source freeze is unconfirmed");
    return { ...row, checkpointID: row.checkpointID };
  }
  async function verifiedManifest(saved: Checkpoint) {
    const bytes = await objects.read(objectKey(saved, "manifest.json"));
    if (objectDigest(bytes) !== objectDigest(new TextEncoder().encode(JSON.stringify(saved))))
      throw new CommandError(
        "unavailable",
        "Confirmed Source manifest is missing or corrupt; old data retained",
      );
  }
  async function confirm(row: SubstrateSourceLease, attemptID: string, sql: SQL) {
    if (row.checkpoint?.id === row.checkpointID) return row;
    const call = (operation: string, value: unknown) =>
      sourceRequest(
        row.workspaceID,
        attemptID,
        row,
        operation,
        new Request("http://source.internal/", {
          method: "POST",
          body: JSON.stringify(value),
          signal: AbortSignal.timeout(120_000),
        }),
        sql,
      );
    const identity = { checkpointId: row.checkpointID, writerEpoch: row.writerEpoch };
    const response = await call("checkpoint", identity);
    if (!response.ok) {
      const failure = response.headers.get("X-Factory-Source-Checkpoint-Failure");
      const reason =
        failure &&
        /^(?:io-\d{1,3}|path-boundary|conflicting-writer|size-limit|ownership-mode|entry-type|external-git|xattr-enumeration|xattr-namespace|xattr-value|external-hardlink|unconfirmed)$/.test(
          failure,
        )
          ? `; ${failure}`
          : "";
      await response.body?.cancel();
      throw new CommandError(
        "unavailable",
        `Complete Source checkpoint is unavailable (HTTP ${response.status}${reason}); original owner remains fenced`,
      );
    }
    const bundle = sourceBundle.parse(await response.json());
    const saved = checkpoint.parse({
      id: row.checkpointID,
      workspaceID: row.workspaceID,
      actorUID: row.actorUID,
      writerEpoch: row.writerEpoch,
      generation: row.generation + 1,
      bundle,
    });
    const whole = createHash("sha256");
    for (let i = 0; i < bundle.chunks.length; i++) {
      const chunk = await call("chunk", { ...identity, chunk: i });
      if (!chunk.ok)
        throw new CommandError(
          "unavailable",
          "Source export chunk is unconfirmed; original owner retained",
        );
      const bytes = checkedBundle(new Uint8Array(await chunk.arrayBuffer()), saved, i);
      whole.update(bytes);
      await objects.put(objectKey(saved, `chunk-${i}`), bytes, "application/octet-stream");
    }
    if (whole.digest("hex") !== bundle.sha256)
      throw new CommandError("unavailable", "Complete Source export checksum differs");
    const manifest = new TextEncoder().encode(JSON.stringify(saved));
    await objects.put(objectKey(saved, "manifest.json"), manifest, "application/json");
    if (
      objectDigest(await objects.read(objectKey(saved, "manifest.json"))) !== objectDigest(manifest)
    )
      throw new Error("Source manifest confirmation failed");
    for (let i = 0; i < bundle.chunks.length; i++)
      checkedBundle(await objects.read(objectKey(saved, `chunk-${i}`)), saved, i);
    const result =
      await sql`UPDATE factory.substrate_source SET generation=${saved.generation},checkpoint=${JSON.stringify(saved)}::text::jsonb WHERE workspace_id=${row.workspaceID} AND writer_epoch=${row.writerEpoch} AND owner=${row.owner} AND NOT writable AND checkpoint_id=${saved.id}`;
    if (result.count !== 1)
      throw new CommandError("conflict", "Source confirmation lost its writer fence");
    const confirmed = await lease(row.workspaceID, sql);
    if (!confirmed) throw new CommandError("unavailable", "Confirmed Source owner is missing");
    return confirmed;
  }
  async function transfer(row: SubstrateSourceLease, owner: "actor" | "service", sql: SQL) {
    if (!row.checkpoint || row.checkpoint.id !== row.checkpointID || row.writable)
      throw new CommandError("conflict", "Source generation is not confirmed");
    revoke(row.workspaceID);
    const result =
      await sql`UPDATE factory.substrate_source SET owner=${owner},writer_epoch=writer_epoch+1,writable=true,checkpoint_id=NULL,service_base=CASE WHEN ${owner}='service' THEN ${row.checkpointID}::uuid ELSE service_base END WHERE workspace_id=${row.workspaceID} AND owner=${row.owner} AND writer_epoch=${row.writerEpoch} AND NOT writable AND checkpoint_id=${row.checkpointID}`;
    if (result.count !== 1)
      throw new CommandError("conflict", "Source owner transfer lost its epoch");
  }
  return {
    lease,
    onTransfer(callback: (workspaceID: string) => void) {
      revoke = callback;
    },
    async available(workspaceID: string) {
      // Status reads can arrive together or race Resume. Starting the Source
      // process is serialized by the same Workspace lock as forwarding and
      // owner transfer, never by a separate service/runtime coordinator.
      return database.client.begin(async (sql) => {
        const [lock] = await sql<
          { acquired: boolean }[]
        >`SELECT pg_try_advisory_xact_lock(hashtext(${`runtime:${workspaceID}`})) AS acquired`;
        if (!lock?.acquired) return false;
        const row = await lease(workspaceID, sql);
        if (row?.owner === "service" && row.writable) {
          await service(row, sql);
          return true;
        }
        return false;
      });
    },
    async attach(workspaceID: string, actorUID: string, sql: SQL) {
      await sql`INSERT INTO factory.substrate_source(workspace_id,actor_uid) VALUES(${workspaceID},${actorUID}) ON CONFLICT(workspace_id) DO NOTHING`;
      const row = await lease(workspaceID, sql);
      if (row?.actorUID !== actorUID) throw new Error("Original Source Actor UID changed");
    },
    async freezeActor(workspaceID: string, attemptID: string, sql: SQL) {
      const current = await lease(workspaceID, sql);
      if (current?.owner === "service") return;
      const row = await freeze(workspaceID, "actor", sql);
      if (row.preservation) {
        const saved = row.preservation;
        if (
          saved.workspaceID !== workspaceID ||
          saved.attemptID !== attemptID ||
          saved.actorUID !== row.actorUID ||
          saved.checkpointID !== row.checkpointID ||
          saved.writerEpoch !== row.writerEpoch ||
          row.generation !== 0 ||
          row.checkpoint
        )
          throw new CommandError(
            "unavailable",
            "Initial Source preservation differs from its original frozen owner",
          );
        await readSourcePreservation(objects, saved);
        return;
      }
      if (row.checkpoint?.id === row.checkpointID) return;
      await hub.parentOperation(attemptID, {
        operationId: row.checkpointID,
        action: "source-drain",
      });
      await confirm(row, attemptID, sql);
    },
    async paused(workspaceID: string, sql: SQL) {
      const row = await lease(workspaceID, sql);
      if (!row) throw new Error("Source owner is missing");
      // A legacy root-owned lockfile can be retained completely without
      // pretending it is supported by the normal development-user editor.
      // Keep that failed initial owner fenced; do not transfer or materialize it.
      if (row.preservation) return;
      if (row.owner === "actor") await transfer(row, "service", sql);
      const current = await lease(workspaceID, sql);
      if (!current) throw new CommandError("unavailable", "Transferred Source owner is missing");
      await service(current, sql);
    },
    async resume(workspaceID: string, attemptID: string, sql: SQL) {
      const current = await lease(workspaceID, sql);
      if (!current) throw new Error("Source owner is missing");
      if (current.owner === "actor") {
        if (!current.writable)
          throw new CommandError("unavailable", "Finish the recorded Source pause before resuming");
        return;
      }
      const row = await confirm(await freeze(workspaceID, "service", sql), attemptID, sql);
      await stopHost(workspaceID);
      await transfer(row, "actor", sql);
    },
    async forward(
      workspaceID: string,
      attemptID: string,
      operation: string,
      request: Request,
      sql: SQL,
    ) {
      const row = await lease(workspaceID, sql);
      if (!row?.writable || (row.owner === "actor" && !hub.sourceConnected(attemptID)))
        throw new CommandError(
          "unavailable",
          "Current Source writer is frozen or unavailable; keep the editor buffer",
        );
      if (["write", "mkdir", "rename", "delete"].includes(operation)) {
        const role = await writer(row, sql);
        if (!role.writable || request.headers.get("X-Factory-Writer-Epoch") !== String(role.epoch))
          throw new CommandError("conflict", "Source writer changed; keep the editor buffer");
        const fence = await sourceRequest(
          workspaceID,
          attemptID,
          row,
          "fence",
          new Request("http://source.internal/", {
            method: "POST",
            body: JSON.stringify({ writerEpoch: role.epoch, writable: true }),
            signal: request.signal,
          }),
          sql,
        );
        if (!fence.ok || (await fence.json()).confirmed !== true)
          throw new CommandError("unavailable", "Source writing fence is unconfirmed");
      }
      return sourceRequest(workspaceID, attemptID, row, operation, request, sql);
    },
    async fence(
      workspaceID: string,
      attemptID: string,
      epoch: string,
      writable: boolean,
      sql: SQL,
    ) {
      const row = await lease(workspaceID, sql);
      // Initial bootstrap reads the saved Change role before exposing Source.
      if (!row) return;
      if (!row.writable) {
        if (!writable && row.checkpoint?.id === row.checkpointID) return;
        throw new CommandError(
          "unavailable",
          "Source owner is frozen; writing fence is unconfirmed",
        );
      }
      const response = await sourceRequest(
        workspaceID,
        attemptID,
        row,
        "fence",
        new Request("http://source.internal/", {
          method: "POST",
          body: JSON.stringify({ writerEpoch: Number(epoch), writable }),
          signal: AbortSignal.timeout(10_000),
        }),
        sql,
      );
      if (!response.ok || (await response.json()).confirmed !== true)
        throw new CommandError(
          "unavailable",
          "Source writing fence is unconfirmed. Existing buffers are preserved.",
        );
    },
    async preservationEndpoint(request: Request, attemptID: string) {
      if (request.method !== "POST") return new Response(null, { status: 405 });
      const auth = request.headers.get("authorization")?.replace(/^Bearer /, "");
      if (!auth) return new Response(null, { status: 403 });
      const [attempt] = await database.client<
        {
          workspaceID: string;
          projectID: string;
          userID: string;
          token: string;
          actorUID: string;
          generation: number;
        }[]
      >`SELECT a.workspace_id AS "workspaceID",a.project_id AS "projectID",a.created_by AS "userID",a.parent_connector_token_hash AS token,b.actor_uid::text AS "actorUID",a.generation::float8 AS generation
        FROM factory.runtime_attempt a JOIN factory.development_workspace w ON w.id=a.workspace_id
        JOIN factory.substrate_binding b ON b.runtime_attempt_id=a.id
        WHERE a.id=${attemptID} AND a.substrate AND w.substrate AND w.kind='personal'
          AND a.change_id IS NULL AND w.change_id IS NULL AND w.owner_user_id=a.created_by
          AND a.ready_at IS NULL AND a.failure IS NOT NULL AND a.state IN ('failed','pausing')
          AND a.stop_intended_at IS NULL AND NOT b.create_rejected AND b.actor_uid IS NOT NULL
          AND b.checkpoint IS NULL AND b.delete_intended_at IS NULL AND b.deleted_at IS NULL
          AND NOT EXISTS(SELECT 1 FROM factory.runtime_attempt n WHERE n.workspace_id=w.id AND n.generation>a.generation)
          AND NOT EXISTS(SELECT 1 FROM factory.change_agent_turn_intent i WHERE i.runtime_attempt_id=a.id)`;
      if (
        !attempt ||
        hashConnectorToken(auth) !== attempt.token ||
        request.headers.get("X-Factory-Runtime-Actor-UID") !== attempt.actorUID ||
        request.headers.get("X-Factory-Runtime-Generation") !== String(attempt.generation)
      )
        return new Response(null, { status: 403 });
      const reader = request.body?.getReader();
      if (!reader) return new Response(null, { status: 400 });
      const parts: Uint8Array[] = [];
      let size = 0;
      try {
        for (;;) {
          const part = await reader.read();
          if (part.done) break;
          size += part.value.length;
          if (size > 4096) {
            await reader.cancel();
            return new Response(null, { status: 413 });
          }
          parts.push(part.value);
        }
      } finally {
        reader.releaseLock();
      }
      let payload: unknown;
      try {
        payload = JSON.parse(new TextDecoder().decode(Buffer.concat(parts)));
      } catch {
        return new Response(null, { status: 400 });
      }
      const parsed = z
        .strictObject({ checkpointID: z.uuid(), manifestSHA256: digest })
        .safeParse(payload);
      if (!parsed.success) return new Response(null, { status: 400 });
      const sql = database.coordination();
      let held = false;
      try {
        const [lock] = await sql<
          { acquired: boolean }[]
        >`SELECT pg_try_advisory_lock(hashtext(${`runtime:${attempt.workspaceID}`})) AS acquired`;
        if (!lock?.acquired) return new Response(null, { status: 409 });
        held = true;
        const current = async (tx: AgentTurnTransaction) => {
          await substrateWorkspaceGrantIn(database, tx, attempt.workspaceID, attempt.userID);
          const [active] =
            await tx`SELECT a.id FROM factory.runtime_attempt a JOIN factory.substrate_binding b ON b.runtime_attempt_id=a.id
            WHERE a.id=${attemptID} AND a.workspace_id=${attempt.workspaceID} AND a.substrate
              AND a.state IN ('failed','pausing') AND a.ready_at IS NULL AND a.failure IS NOT NULL AND a.stop_intended_at IS NULL
              AND b.actor_uid=${attempt.actorUID} AND b.checkpoint IS NULL AND b.delete_intended_at IS NULL AND b.deleted_at IS NULL`;
          const row = await lease(attempt.workspaceID, tx);
          if (
            !active ||
            !row ||
            row.actorUID !== attempt.actorUID ||
            row.owner !== "actor" ||
            row.writable ||
            row.generation !== 0 ||
            row.checkpoint ||
            row.serviceBase ||
            row.checkpointID !== parsed.data.checkpointID ||
            row.writerEpoch <= 1
          )
            throw new CommandError(
              "conflict",
              "Initial Source preservation requires the exact frozen failed owner",
            );
          if (row.preservation && row.preservation.manifestSHA256 !== parsed.data.manifestSHA256)
            throw new CommandError(
              "conflict",
              "Original Source preservation reference is immutable",
            );
          return row;
        };
        const row = await sql.begin((tx) => current(tx));
        const scope = {
          version: 1 as const,
          projectID: attempt.projectID,
          workspaceID: attempt.workspaceID,
          attemptID,
          actorUID: attempt.actorUID,
          checkpointID: parsed.data.checkpointID,
          writerEpoch: row.writerEpoch,
          sourceGeneration: 0 as const,
          manifestSHA256: parsed.data.manifestSHA256,
        };
        const saved = await readSourcePreservation(objects, scope);
        // Recheck current human authority after object I/O. The Workspace lock
        // stays held, but permission revocation is never blocked by those reads.
        await sql.begin(async (tx) => {
          await current(tx);
          const result =
            await tx`UPDATE factory.substrate_source SET preservation=${JSON.stringify(saved)}::text::jsonb
          WHERE workspace_id=${attempt.workspaceID} AND actor_uid=${attempt.actorUID} AND owner='actor' AND NOT writable
            AND writer_epoch=${row.writerEpoch} AND generation=0 AND checkpoint IS NULL AND checkpoint_id=${saved.checkpointID}
            AND (preservation IS NULL OR preservation=${JSON.stringify(saved)}::text::jsonb)`;
          if (result.count !== 1)
            throw new CommandError("conflict", "Source preservation lost its original fence");
        });
        return Response.json(
          { confirmed: true, sourceHandoff: "pending" },
          { headers: { "cache-control": "no-store" } },
        );
      } finally {
        try {
          if (held)
            await sql`SELECT pg_advisory_unlock(hashtext(${`runtime:${attempt.workspaceID}`}))`;
        } finally {
          await sql.end({ timeout: 1 });
        }
      }
    },
    async restoreEndpoint(request: Request, attemptID: string) {
      const [attempt] = await database.client<
        {
          workspaceID: string;
          projectID: string;
          userID: string;
          token: string;
          actorUID: string;
          generation: number;
        }[]
      >`SELECT a.workspace_id AS "workspaceID",a.project_id AS "projectID",a.created_by AS "userID",a.parent_connector_token_hash AS token,b.actor_uid::text AS "actorUID",a.generation::float8 AS generation FROM factory.runtime_attempt a JOIN factory.substrate_binding b ON b.runtime_attempt_id=a.id JOIN factory.development_workspace w ON w.id=a.workspace_id AND w.substrate AND w.project_id=a.project_id AND w.change_id IS NOT DISTINCT FROM a.change_id WHERE a.id=${attemptID} AND a.substrate AND a.state='starting' AND a.stop_intended_at IS NULL AND b.delete_intended_at IS NULL AND b.deleted_at IS NULL AND (w.kind='ticket' OR w.owner_user_id=a.created_by) AND NOT EXISTS(SELECT 1 FROM factory.runtime_attempt n WHERE n.workspace_id=a.workspace_id AND n.generation>a.generation)`;
      const auth = request.headers.get("authorization")?.replace(/^Bearer /, "");
      if (
        !attempt ||
        request.method !== "GET" ||
        !auth ||
        hashConnectorToken(auth) !== attempt.token ||
        request.headers.get("X-Factory-Runtime-Actor-UID") !== attempt.actorUID ||
        request.headers.get("X-Factory-Runtime-Generation") !== String(attempt.generation)
      )
        return new Response(null, { status: 403 });
      await database.client.begin(async (sql) => {
        const principal = await substrateRuntimePrincipalIn(sql, attemptID);
        await substrateWorkspaceGrantIn(database, sql, attempt.workspaceID, principal);
      });
      const row = await lease(attempt.workspaceID);
      if (!row || row.actorUID !== attempt.actorUID || row.owner !== "actor" || !row.writable)
        return new Response(null, { status: 409 });
      const url = new URL(request.url);
      const chunk = url.searchParams.get("chunk");
      if (chunk === null) {
        if (row.checkpoint) await verifiedManifest(row.checkpoint);
        const role = await writer(row, database.client);
        return Response.json(
          {
            writerEpoch: row.writerEpoch,
            changeWriterEpoch: role.epoch,
            readOnly: !role.writable,
            checkpoint: row.checkpoint,
          },
          { headers: { "cache-control": "no-store" } },
        );
      }
      if (
        !/^\d{1,4}$/.test(chunk) ||
        !row.checkpoint ||
        request.headers.get("X-Factory-Source-Writer-Epoch") !== String(row.writerEpoch) ||
        url.searchParams.get("checkpoint") !== row.checkpoint.id ||
        Number(chunk) >= row.checkpoint.bundle.chunks.length
      )
        return new Response(null, { status: 409 });
      return new Response(
        new Uint8Array(
          checkedBundle(
            await objects.read(objectKey(row.checkpoint, `chunk-${Number(chunk)}`)),
            row.checkpoint,
            Number(chunk),
          ),
        ).buffer,
        { headers: { "content-type": "application/octet-stream", "cache-control": "no-store" } },
      );
    },
    async close() {
      for (const workspace of hosts.keys()) await stopHost(workspace);
    },
  };
}
