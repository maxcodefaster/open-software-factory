import { createHash, randomBytes } from "node:crypto";
import { lstat, mkdir, mkdtemp, open, readFile, rename, rmdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { and, eq, sql as expression, gt, isNull, notExists } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { z } from "zod";
import {
  type createDatabase,
  type DatabaseTransaction,
  drizzleTransaction,
} from "../../../../packages/db/src/client";
import {
  change,
  changeWriter,
  developmentWorkspace,
  runtimeAttempt,
  substrateBinding,
  substrateSource,
  ticket,
} from "../../../../packages/db/src/schema";
import { hashConnectorToken } from "../../../../packages/runtime-domain/src/identity";
import { CommandError } from "../command-error";
import {
  nativeInputStopIn,
  substrateRuntimePrincipalIn,
  substrateWorkspaceGrantIn,
} from "../runtime/source-api";
import { type RuntimeHub } from "../runtime/transport-api";
import { createPrivateObjects, objectDigest, type PrivateObjects } from "../storage/objects";

type Database = ReturnType<typeof createDatabase>;
type SQL = Database["client"] | DatabaseTransaction;
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
};
export type SubstrateSourceHandoff = Pick<
  ReturnType<typeof createSubstrateSources>,
  "attach" | "freezeActor" | "makeIndependent" | "resume" | "requireIndependent"
>;

function objectKey(saved: Checkpoint, suffix: string) {
  return `workspace-source/v1/${saved.workspaceID}/${saved.id}/${suffix}`;
}
function checkpointChunk(saved: Checkpoint, index: number) {
  const sha256 = saved.bundle.chunks[index];
  if (!sha256)
    throw new CommandError(
      "unavailable",
      "Confirmed Source chunk is missing or corrupt. Old data was retained.",
    );
  return {
    key: objectKey(saved, `chunk-${index}`),
    bytes: Math.min(1 << 20, saved.bundle.bytes - index * (1 << 20)),
    sha256,
  };
}
function checkpointManifest(saved: Checkpoint) {
  const bytes = new TextEncoder().encode(JSON.stringify(saved));
  return {
    key: objectKey(saved, "manifest.json"),
    bytes: bytes.byteLength,
    sha256: objectDigest(bytes),
  };
}
export function sourceCheckpointObjects(value: unknown) {
  const saved = checkpoint.parse(value);
  return {
    manifest: checkpointManifest(saved),
    chunks: saved.bundle.chunks.map((_, index) => checkpointChunk(saved, index)),
    sha256: saved.bundle.sha256,
  };
}
function checkedBundle(data: Uint8Array, saved: Checkpoint, index: number) {
  const item = checkpointChunk(saved, index);
  if (data.byteLength !== item.bytes || objectDigest(data) !== item.sha256)
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
    const [row] = await drizzleTransaction(sql)
      .select({
        workspaceID: substrateSource.workspaceId,
        actorUID: substrateSource.actorUid,
        owner: expression<SubstrateSourceLease["owner"]>`${substrateSource.owner}`,
        writerEpoch: substrateSource.writerEpoch,
        writable: substrateSource.writable,
        generation: substrateSource.generation,
        checkpointID: substrateSource.checkpointId,
        checkpoint: substrateSource.checkpoint,
        serviceBase: substrateSource.serviceBase,
      })
      .from(substrateSource)
      .where(eq(substrateSource.workspaceId, workspaceID));
    return row
      ? { ...row, checkpoint: row.checkpoint ? checkpoint.parse(row.checkpoint) : null }
      : null;
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
    const [workspace] = await drizzleTransaction(sql)
      .select({
        kind: developmentWorkspace.kind,
        epoch: changeWriter.epoch,
        writable: expression<boolean | null>`(${changeWriter.state}='human'
          AND ${change.state} IN ('starting','active','failed')
          AND ${change.cancelRequestedAt} IS NULL AND ${ticket.trashedAt} IS NULL)`,
      })
      .from(developmentWorkspace)
      .leftJoin(changeWriter, eq(changeWriter.changeId, developmentWorkspace.changeId))
      .leftJoin(change, eq(change.id, developmentWorkspace.changeId))
      .leftJoin(ticket, eq(ticket.id, developmentWorkspace.ticketId))
      .where(eq(developmentWorkspace.id, row.workspaceID));
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
      await drizzleTransaction(sql)
        .update(substrateSource)
        .set({
          writerEpoch: expression`${substrateSource.writerEpoch}+1`,
          writable: false,
          checkpointId: id,
        })
        .where(
          and(
            eq(substrateSource.workspaceId, workspaceID),
            eq(substrateSource.owner, owner),
            eq(substrateSource.writerEpoch, row.writerEpoch),
            eq(substrateSource.writable, true),
          ),
        );
      row = await lease(workspaceID, sql);
    }
    if (!row || row.writable || !row.checkpointID)
      throw new CommandError("conflict", "Source freeze is unconfirmed");
    return { ...row, checkpointID: row.checkpointID };
  }
  async function verifiedManifest(saved: Checkpoint) {
    const item = checkpointManifest(saved);
    const bytes = await objects.read(item.key);
    if (bytes.byteLength !== item.bytes || objectDigest(bytes) !== item.sha256)
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
    const result = await drizzleTransaction(sql)
      .update(substrateSource)
      .set({ generation: saved.generation, checkpoint: saved })
      .where(
        and(
          eq(substrateSource.workspaceId, row.workspaceID),
          eq(substrateSource.writerEpoch, row.writerEpoch),
          eq(substrateSource.owner, row.owner),
          eq(substrateSource.writable, false),
          eq(substrateSource.checkpointId, saved.id),
        ),
      )
      .returning({ workspaceID: substrateSource.workspaceId });
    if (result.length !== 1)
      throw new CommandError("conflict", "Source confirmation lost its writer fence");
    const confirmed = await lease(row.workspaceID, sql);
    if (!confirmed) throw new CommandError("unavailable", "Confirmed Source owner is missing");
    return confirmed;
  }
  async function transfer(
    row: SubstrateSourceLease,
    owner: "actor" | "service",
    sql: SQL,
    actorUID = row.actorUID,
  ) {
    if (!row.checkpoint || row.checkpoint.id !== row.checkpointID || row.writable)
      throw new CommandError("conflict", "Source generation is not confirmed");
    revoke(row.workspaceID);
    const result = await drizzleTransaction(sql)
      .update(substrateSource)
      .set({
        owner,
        actorUid: actorUID,
        writerEpoch: expression`${substrateSource.writerEpoch}+1`,
        writable: true,
        checkpointId: null,
        serviceBase: owner === "service" ? row.checkpointID : substrateSource.serviceBase,
      })
      .where(
        and(
          eq(substrateSource.workspaceId, row.workspaceID),
          eq(substrateSource.actorUid, row.actorUID),
          eq(substrateSource.owner, row.owner),
          eq(substrateSource.writerEpoch, row.writerEpoch),
          eq(substrateSource.writable, false),
          eq(substrateSource.checkpointId, row.checkpointID),
        ),
      )
      .returning({ workspaceID: substrateSource.workspaceId });
    if (result.length !== 1)
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
      // Materialization and process readiness must not occupy the application
      // pool. The same Workspace lock still excludes a concurrent transfer.
      const sql = database.coordination();
      let held = false;
      try {
        const [lock] = await sql<
          { acquired: boolean }[]
        >`SELECT pg_try_advisory_lock(hashtext(${`runtime:${workspaceID}`})) AS acquired`;
        if (!lock?.acquired) return false;
        held = true;
        const row = await lease(workspaceID, sql);
        if (row?.owner === "service" && row.writable) {
          await service(row, sql);
          return true;
        }
        return false;
      } finally {
        try {
          if (held) await sql`SELECT pg_advisory_unlock(hashtext(${`runtime:${workspaceID}`}))`;
        } finally {
          await sql.end({ timeout: 1 });
        }
      }
    },
    async attach(workspaceID: string, actorUID: string, sql: SQL) {
      await drizzleTransaction(sql)
        .insert(substrateSource)
        .values({ workspaceId: workspaceID, actorUid: actorUID })
        .onConflictDoNothing({ target: substrateSource.workspaceId });
      const row = await lease(workspaceID, sql);
      if (!row) throw new Error("Source owner is missing");
      if (row.actorUID === actorUID) return;
      // Authorize this exact native successor in one read of both generations
      // and their frozen provisioning identities before exporting or changing UID.
      const [successor] = await sql<{ id: string }[]>`
        SELECT current.id FROM factory.runtime_attempt predecessor
        JOIN factory.substrate_binding old_binding ON old_binding.runtime_attempt_id=predecessor.id
        JOIN factory.runtime_attempt current ON current.workspace_id=predecessor.workspace_id
          AND current.generation=predecessor.generation+1
        JOIN factory.substrate_binding new_binding ON new_binding.runtime_attempt_id=current.id
        JOIN factory.substrate_workspace p ON p.workspace_id=current.workspace_id AND p.generation=current.generation
        WHERE predecessor.workspace_id=${workspaceID} AND predecessor.state='stopped'
          AND old_binding.actor_uid=${row.actorUID} AND old_binding.deleted_at IS NOT NULL
          AND current.state='create-intended' AND current.stop_intended_at IS NULL
          AND new_binding.actor_uid=${actorUID} AND NOT new_binding.create_rejected
          AND new_binding.create_attempted_at IS NOT NULL
          AND new_binding.delete_intended_at IS NULL AND new_binding.deleted_at IS NULL
          AND new_binding.intent->>'workspaceID'=${workspaceID}
          AND new_binding.intent->>'generation'=current.generation::text
          AND new_binding.intent->>'atespaceUID'=p.atespace#>>'{metadata,uid}'
          AND new_binding.intent->>'templateUID'=p.template#>>'{metadata,uid}'
          AND new_binding.intent->>'templateVersion'=p.template#>>'{metadata,version}'
          AND new_binding.intent->>'templateSHA256'=p.intent->>'templateSHA256'
          AND NOT EXISTS(SELECT 1 FROM factory.runtime_attempt newer
            WHERE newer.workspace_id=current.workspace_id AND newer.generation>current.generation)`;
      if (!successor || row.owner !== "service")
        throw new Error("Original Source Actor UID changed without a confirmed native successor");
      // Freeze and export the latest offline edits, not the older pause bundle.
      // Transfer only after the original Source process has actually exited.
      const frozen = await confirm(await freeze(workspaceID, "service", sql), successor.id, sql);
      await stopHost(workspaceID);
      await transfer(frozen, "actor", sql, actorUID);
    },
    async freezeActor(workspaceID: string, attemptID: string, sql: SQL) {
      const current = await lease(workspaceID, sql);
      if (current?.owner === "service") return;
      if (
        current &&
        (current.writable || current.checkpoint?.id !== current.checkpointID) &&
        !hub.sourceConnected(attemptID)
      )
        throw new CommandError(
          "unavailable",
          "Confirmed independent Source is unavailable; the original Parent was retained.",
        );
      const row = await freeze(workspaceID, "actor", sql);
      if (row.checkpoint?.id === row.checkpointID) return;
      await hub.parentOperation(attemptID, {
        operationId: row.checkpointID,
        action: "source-drain",
      });
      await confirm(row, attemptID, sql);
    },
    async makeIndependent(workspaceID: string, sql: SQL) {
      const row = await lease(workspaceID, sql);
      if (!row) throw new Error("Source owner is missing");
      if (row.owner === "actor") await transfer(row, "service", sql);
      const current = await lease(workspaceID, sql);
      if (!current) throw new CommandError("unavailable", "Transferred Source owner is missing");
      await service(current, sql);
    },
    async requireIndependent(workspaceID: string, actorUID: string, sql: SQL) {
      const row = await lease(workspaceID, sql);
      if (
        !row ||
        row.actorUID !== actorUID ||
        row.owner !== "service" ||
        !row.writable ||
        !row.checkpoint ||
        !row.serviceBase
      )
        throw new CommandError(
          "unavailable",
          "Workspace Stop requires confirmed independent Source; the original Actor was retained",
        );
      // A durable ROOTFS is not the independent editable checkout. Confirm its
      // retained materialization and live Source service before deleting it.
      await service(row, sql);
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
      requireLiveRole = false,
    ) {
      const row = await lease(workspaceID, sql);
      // Initial bootstrap reads the saved Change role before exposing Source.
      if (!row) {
        if (requireLiveRole)
          throw new CommandError("unavailable", "Current Source role is unavailable");
        return;
      }
      if (
        requireLiveRole &&
        (row.owner !== "actor" ||
          !row.writable ||
          !hub.ready(attemptID) ||
          !hub.sourceConnected(attemptID))
      )
        throw new CommandError("unavailable", "Current Source role cannot be confirmed");
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
    async restoreEndpoint(request: Request, attemptID: string) {
      const newer = alias(runtimeAttempt, "newer");
      const [attempt] = await database.db
        .select({
          workspaceID: developmentWorkspace.id,
          projectID: runtimeAttempt.projectId,
          userID: runtimeAttempt.createdBy,
          token: runtimeAttempt.parentConnectorTokenHash,
          actorUID: substrateBinding.actorUid,
          generation: runtimeAttempt.generation,
        })
        .from(runtimeAttempt)
        .innerJoin(substrateBinding, eq(substrateBinding.runtimeAttemptId, runtimeAttempt.id))
        .innerJoin(
          developmentWorkspace,
          and(
            eq(developmentWorkspace.id, runtimeAttempt.workspaceId),
            eq(developmentWorkspace.projectId, runtimeAttempt.projectId),
            expression`${developmentWorkspace.changeId} IS NOT DISTINCT FROM ${runtimeAttempt.changeId}`,
          ),
        )
        .where(
          and(
            eq(runtimeAttempt.id, attemptID),
            eq(runtimeAttempt.state, "starting"),
            isNull(runtimeAttempt.stopIntendedAt),
            isNull(substrateBinding.deleteIntendedAt),
            isNull(substrateBinding.deletedAt),
            notExists(
              database.db
                .select({ id: newer.id })
                .from(newer)
                .where(
                  and(
                    eq(newer.workspaceId, runtimeAttempt.workspaceId),
                    gt(newer.generation, runtimeAttempt.generation),
                  ),
                ),
            ),
          ),
        );
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
      const inputStop = await nativeInputStopIn(database.client, attemptID);
      if (inputStop && (!inputStop.resumed || inputStop.completed))
        return new Response(null, { status: 409 });
      if (!inputStop)
        await database.client.begin(async (sql) => {
          const principal = await substrateRuntimePrincipalIn(sql, attemptID);
          await substrateWorkspaceGrantIn(database, sql, attempt.workspaceID, principal);
        });
      const row = await lease(attempt.workspaceID);
      if (!row || row.actorUID !== attempt.actorUID || row.owner !== "actor" || !row.writable)
        return new Response(null, { status: 409 });
      if (
        inputStop &&
        (row.checkpoint?.id !== inputStop.sourceCheckpointID ||
          row.writerEpoch !== inputStop.sourceWriterEpoch)
      )
        return new Response(null, { status: 409 });
      if (row.checkpoint && row.checkpoint.actorUID !== attempt.actorUID) {
        const [predecessor] = await database.db
          .select({ actorUID: substrateBinding.actorUid })
          .from(runtimeAttempt)
          .innerJoin(substrateBinding, eq(substrateBinding.runtimeAttemptId, runtimeAttempt.id))
          .where(
            and(
              eq(runtimeAttempt.workspaceId, attempt.workspaceID),
              eq(runtimeAttempt.generation, attempt.generation - 1),
              eq(runtimeAttempt.state, "stopped"),
              expression`${substrateBinding.deletedAt} IS NOT NULL`,
              eq(substrateBinding.actorUid, row.checkpoint.actorUID),
            ),
          );
        if (!predecessor) return new Response(null, { status: 409 });
      }
      const url = new URL(request.url);
      const chunk = url.searchParams.get("chunk");
      if (chunk === null) {
        if (row.checkpoint) await verifiedManifest(row.checkpoint);
        const role = await writer(row, database.client);
        return Response.json(
          {
            actorUID: row.actorUID,
            checkpointActorUID: row.checkpoint?.actorUID ?? null,
            writerEpoch: row.writerEpoch,
            changeWriterEpoch: role.epoch,
            readOnly: Boolean(inputStop) || !role.writable,
            checkpoint: row.checkpoint,
            ...(inputStop ? { inputStop: inputStop.assignment } : {}),
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
