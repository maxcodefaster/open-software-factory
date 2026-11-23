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
import type { SystemContract } from "../../../../packages/system-contract/src/system-contract";
import { CommandError } from "../command-error";
import {
  nativeInputStopIn,
  substrateRuntimePrincipalIn,
  substrateWorkspaceGrantIn,
} from "../runtime/source-api";
import type { RuntimeHub } from "../runtime/transport-api";
import { createPrivateObjects, objectDigest, type PrivateObjects } from "../storage/objects";
import {
  confirmInitialSourcePublication,
  type InitialSourceSeed,
  initialSourceActorIn,
  initialSourceSeed,
  materializeInitialSource,
} from "./source-initialization";
import { boundedSourceBody } from "./source-body";
import { sourceStartupContract } from "./source-startup";

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
const checkpoint = z
  .strictObject({
    id: z.uuid(),
    workspaceID: z.uuid(),
    actorUID: z.uuid().nullable(),
    seedID: z.uuid().optional(),
    writerEpoch: z.number().int().positive(),
    generation: z.number().int().positive(),
    bundle: sourceBundle,
  })
  .refine((value) => (value.actorUID === null ? Boolean(value.seedID) : !value.seedID));
type Checkpoint = z.infer<typeof checkpoint>;
export type SubstrateSourceLease = {
  workspaceID: string;
  actorUID: string | null;
  owner: "actor" | "service";
  writerEpoch: number;
  writable: boolean;
  generation: number;
  checkpointID: string | null;
  checkpoint: Checkpoint | null;
  serviceBase: string | null;
  seed: InitialSourceSeed | null;
  seedConfirmedAt: Date | null;
};
export type SubstrateSourceHandoff = Pick<
  ReturnType<typeof createSubstrateSources>,
  "attach" | "freezeActor" | "makeIndependent" | "resume" | "requireIndependent"
> &
  Partial<Pick<ReturnType<typeof createSubstrateSources>, "startupContract">>;

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

// Source ownership has its own short lock. Native Resume waits for bootstrap,
// which must be able to import Source without waiting on that Runtime lock.
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
  async function locked<T>(
    workspaceID: string,
    sql: SQL,
    action: (sql: SQL) => Promise<T>,
  ): Promise<T> {
    if ("savepoint" in sql)
      return sql.savepoint(async (tx) => {
        await tx`SELECT pg_advisory_xact_lock(hashtext(${`source:${workspaceID}`}))`;
        return action(tx);
      });
    // Freeze and object publication are durable facts even if a later external
    // reply is lost. A session lock serializes them without rolling them back.
    const owner = database.coordination();
    try {
      await owner`SELECT pg_advisory_lock(hashtext(${`source:${workspaceID}`}))`;
      return await action(owner);
    } finally {
      try {
        await owner`SELECT pg_advisory_unlock(hashtext(${`source:${workspaceID}`}))`;
      } finally {
        await owner.end({ timeout: 1 });
      }
    }
  }
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
        seed: substrateSource.seed,
        seedConfirmedAt: substrateSource.seedConfirmedAt,
      })
      .from(substrateSource)
      .where(eq(substrateSource.workspaceId, workspaceID));
    return row
      ? {
          ...row,
          checkpoint: row.checkpoint ? checkpoint.parse(row.checkpoint) : null,
          seed: row.seed ? initialSourceSeed.parse(row.seed) : null,
        }
      : null;
  }
  async function sourceRequest(
    workspaceID: string,
    attemptID: string | null,
    row: SubstrateSourceLease,
    operation: string,
    request: Request,
    sql: SQL,
  ) {
    if (row.owner === "actor") {
      if (!attemptID) throw new CommandError("unavailable", "Actor Source binding is unavailable");
      return hub.request(
        attemptID,
        "source",
        request,
        `/v1/workspaces/${workspaceID}/${operation}`,
      );
    }
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
    if (row.owner !== "service" || !row.serviceBase)
      throw new CommandError("unavailable", "Independent Source owner is unconfirmed");
    const retained = hosts.get(row.workspaceID);
    if (
      retained?.base === row.serviceBase &&
      retained.child.exitCode === null &&
      (retained.epoch === row.writerEpoch || !row.writable) &&
      (!row.seed || row.serviceBase !== row.seed.id || row.seedConfirmedAt !== null)
    ) {
      await retained.ready;
      return retained;
    }
    if (retained) await stopHost(row.workspaceID);
    const base = join(root, row.workspaceID, row.serviceBase);
    // Its base stays fixed throughout offline edits and freeze retries. Never
    // import a prior checkpoint over an existing service-owned dirty tree.
    if (row.seed && row.seed.id === row.serviceBase) {
      if (row.actorUID !== null || row.seed.workspaceID !== row.workspaceID)
        throw new CommandError("unavailable", "Initial Source owner identity changed");
      await materializeInitialSource(binary, root, row.seed, row.seedConfirmedAt !== null);
      if (!row.seedConfirmedAt)
        await confirmInitialSourcePublication(database, row.workspaceID, row.seed.id);
    } else {
      if (!row.checkpoint)
        throw new CommandError("unavailable", "Independent Source checkpoint is unavailable");
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
    }
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
      ...(row.actorUID === null ? { seedID: row.seed?.id } : {}),
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
          row.actorUID === null
            ? isNull(substrateSource.actorUid)
            : eq(substrateSource.actorUid, row.actorUID),
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
  async function recipient(row: SubstrateSourceLease, actorUID: string, sql: SQL) {
    if (row.owner !== "service")
      throw new CommandError("conflict", "Independent Source owner changed");
    const [current] =
      row.actorUID === null && row.seed
        ? await initialSourceActorIn(sql, row.seed, actorUID)
        : await sql<{ id: string }[]>`
          SELECT current.id FROM factory.runtime_attempt current
          JOIN factory.substrate_binding binding ON binding.runtime_attempt_id=current.id
          JOIN factory.substrate_workspace p ON p.workspace_id=current.workspace_id AND p.generation=current.generation
          WHERE current.workspace_id=${row.workspaceID}
            AND current.state IN ('create-intended','starting','paused')
            AND current.stop_intended_at IS NULL
            AND binding.actor_uid=${actorUID} AND NOT binding.create_rejected
            AND binding.create_attempted_at IS NOT NULL
            AND binding.delete_intended_at IS NULL AND binding.deleted_at IS NULL
            AND binding.intent->>'workspaceID'=${row.workspaceID}
            AND binding.intent->>'generation'=current.generation::text
            AND binding.intent->>'atespaceUID'=p.atespace#>>'{metadata,uid}'
            AND binding.intent->>'templateUID'=p.template#>>'{metadata,uid}'
            AND binding.intent->>'templateVersion'=p.template#>>'{metadata,version}'
            AND binding.intent->>'templateSHA256'=p.intent->>'templateSHA256'
            AND (${row.actorUID}::uuid=${actorUID}::uuid OR EXISTS(
              SELECT 1 FROM factory.runtime_attempt predecessor
              JOIN factory.substrate_binding old_binding ON old_binding.runtime_attempt_id=predecessor.id
              WHERE predecessor.workspace_id=current.workspace_id
                AND predecessor.generation<current.generation AND predecessor.state='stopped'
                AND old_binding.actor_uid=${row.actorUID} AND old_binding.deleted_at IS NOT NULL
                AND NOT EXISTS(
                  SELECT 1 FROM factory.runtime_attempt skipped
                  LEFT JOIN factory.substrate_binding retired ON retired.runtime_attempt_id=skipped.id
                  WHERE skipped.workspace_id=current.workspace_id
                    AND skipped.generation>predecessor.generation AND skipped.generation<current.generation
                    AND (skipped.state='stopped' AND retired.deleted_at IS NOT NULL
                      AND retired.intent->>'sourceRestoreProtocol'='2') IS NOT TRUE)))
            AND NOT EXISTS(SELECT 1 FROM factory.runtime_attempt newer
              WHERE newer.workspace_id=current.workspace_id AND newer.generation>current.generation)`;
    if (!current)
      throw new CommandError(
        "conflict",
        "Original Source Actor UID changed without a confirmed native successor",
      );
    return current.id;
  }
  async function ungrantedStop(workspaceID: string, actorUID: string, sql: SQL) {
    const [attempt] = await sql<{ id: string }[]>`
      SELECT a.id FROM factory.runtime_attempt a
      JOIN factory.substrate_binding b ON b.runtime_attempt_id=a.id
      JOIN factory.substrate_source s ON s.workspace_id=a.workspace_id AND s.owner='service'
      WHERE a.workspace_id=${workspaceID} AND a.stop_intended_at IS NOT NULL
        AND b.actor_uid=${actorUID} AND b.intent->>'sourceRestoreProtocol'='2'
        AND b.create_attempted_at IS NOT NULL AND NOT b.create_rejected
        AND ((a.state='stopping' AND b.deleted_at IS NULL)
          OR (a.state='stopped' AND b.deleted_at IS NOT NULL))
        AND NOT EXISTS(SELECT 1 FROM factory.runtime_attempt newer
          WHERE newer.workspace_id=a.workspace_id AND newer.generation>a.generation)`;
    return Boolean(attempt);
  }
  return {
    lease,
    async startupContract(
      workspaceID: string,
      sql: SQL,
    ): Promise<SystemContract | null | undefined> {
      return locked(workspaceID, sql, async (sql) => {
        let row = await lease(workspaceID, sql);
        if (!row) return;
        if (row.owner !== "service" || !row.writable)
          throw new CommandError(
            "unavailable",
            "Independent Source is not ready for Workspace Start",
          );
        await service(row, sql);
        row = await lease(workspaceID, sql);
        if (!row)
          throw new CommandError("unavailable", "Source owner changed before Workspace Start");
        const role = await writer(row, sql);
        return sourceStartupContract(sql, row, (operation, body) =>
          this.forward(
            workspaceID,
            null,
            operation,
            new Request("http://source.internal/", {
              method: "POST",
              headers: {
                "content-type": "application/json",
                "X-Factory-Writer-Epoch": String(role.epoch),
              },
              body: JSON.stringify(body),
              signal: AbortSignal.timeout(15_000),
            }),
            sql,
          ),
        );
      });
    },
    onTransfer(callback: (workspaceID: string) => void) {
      revoke = callback;
    },
    async available(workspaceID: string) {
      // Source remains readable while native compute is starting. Process
      // materialization never occupies the application connection pool.
      const sql = database.coordination();
      let held = false;
      try {
        const [lock] = await sql<
          { acquired: boolean }[]
        >`SELECT pg_try_advisory_lock(hashtext(${`source:${workspaceID}`})) AS acquired`;
        if (!lock?.acquired) return false;
        held = true;
        const row = await lease(workspaceID, sql);
        if (row?.owner === "service") {
          await service(row, sql);
          return true;
        }
        return false;
      } finally {
        try {
          if (held) await sql`SELECT pg_advisory_unlock(hashtext(${`source:${workspaceID}`}))`;
        } finally {
          await sql.end({ timeout: 1 });
        }
      }
    },
    async attach(workspaceID: string, actorUID: string, sql: SQL) {
      return locked(workspaceID, sql, async (sql) => {
        const row = await lease(workspaceID, sql);
        if (!row) throw new CommandError("unavailable", "Independent Source was not admitted");
        if (row.owner === "actor" && row.actorUID === actorUID) return;
        // Native allocation is not Source import or permission to execute.
        // Leave the saved tree live until this exact recipient requests it.
        await recipient(row, actorUID, sql);
      });
    },
    async freezeActor(workspaceID: string, attemptID: string, sql: SQL) {
      return locked(workspaceID, sql, async (sql) => {
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
      });
    },
    async makeIndependent(workspaceID: string, sql: SQL) {
      return locked(workspaceID, sql, async (sql) => {
        const row = await lease(workspaceID, sql);
        if (!row) throw new Error("Source owner is missing");
        if (row.owner === "actor") await transfer(row, "service", sql);
        else if (!row.writable) {
          const [attempt] = await sql<{ actorUID: string }[]>`
          SELECT b.actor_uid AS "actorUID" FROM factory.runtime_attempt a
          JOIN factory.substrate_binding b ON b.runtime_attempt_id=a.id
          WHERE a.workspace_id=${workspaceID} AND a.state='stopping'
            AND a.stop_intended_at IS NOT NULL AND b.actor_uid IS NOT NULL
            AND NOT EXISTS(SELECT 1 FROM factory.runtime_attempt newer
              WHERE newer.workspace_id=a.workspace_id AND newer.generation>a.generation)`;
          if (!attempt || !(await ungrantedStop(workspaceID, attempt.actorUID, sql)))
            throw new CommandError("conflict", "Source import has not been safely cancelled");
          await stopHost(workspaceID);
          revoke(workspaceID);
          await drizzleTransaction(sql)
            .update(substrateSource)
            .set({
              writable: true,
              writerEpoch: expression`${substrateSource.writerEpoch}+1`,
              checkpointId: null,
            })
            .where(
              and(
                eq(substrateSource.workspaceId, workspaceID),
                eq(substrateSource.owner, "service"),
                eq(substrateSource.writerEpoch, row.writerEpoch),
                eq(substrateSource.writable, false),
              ),
            );
        }
        const current = await lease(workspaceID, sql);
        if (!current) throw new CommandError("unavailable", "Transferred Source owner is missing");
        await service(current, sql);
      });
    },
    async requireIndependent(workspaceID: string, actorUID: string, sql: SQL) {
      return locked(workspaceID, sql, async (sql) => {
        const row = await lease(workspaceID, sql);
        if (
          row?.owner !== "service" ||
          !row.writable ||
          !row.serviceBase ||
          (!(await ungrantedStop(workspaceID, actorUID, sql)) &&
            (row.actorUID !== actorUID || !row.checkpoint))
        )
          throw new CommandError(
            "unavailable",
            "Workspace Stop requires confirmed independent Source; the original Actor was retained",
          );
        // A durable ROOTFS is not the independent editable checkout. Confirm its
        // retained materialization and live Source service before deleting it.
        await service(row, sql);
      });
    },
    async resume(workspaceID: string, attemptID: string, sql: SQL, inputStop = false) {
      return locked(workspaceID, sql, async (sql) => {
        const current = await lease(workspaceID, sql);
        if (!current) throw new Error("Source owner is missing");
        if (current.owner === "actor") {
          if (!current.writable)
            throw new CommandError(
              "unavailable",
              "Finish the recorded Source pause before resuming",
            );
          return;
        }
        // Stop-only continuation pins its exact offline export before native
        // dispatch. Ordinary Start waits until the recipient actually fetches it.
        if (inputStop) await confirm(await freeze(workspaceID, "service", sql), attemptID, sql);
      });
    },
    async forward(
      workspaceID: string,
      attemptID: string | null,
      operation: string,
      request: Request,
      sql: SQL,
    ) {
      const row = await lease(workspaceID, sql);
      if (
        !row ||
        (!row.writable &&
          (row.owner !== "service" ||
            !["stat", "list", "read", "search", "events"].includes(operation))) ||
        (row.owner === "actor" && (!attemptID || !hub.sourceConnected(attemptID)))
      )
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
      if (
        !["GET", "POST"].includes(request.method) ||
        request.headers.get("X-Factory-Source-Protocol") !== "2"
      )
        return new Response(null, { status: 403 });
      const commit =
        request.method === "POST"
          ? z
              .strictObject({
                checkpointID: z.uuid(),
                writerEpoch: z.number().int().positive(),
              })
              .safeParse(
                await boundedSourceBody(request)
                  .then((body) => JSON.parse(new TextDecoder().decode(body)) as unknown)
                  .catch(() => null),
              )
          : null;
      if (commit && !commit.success) return new Response(null, { status: 400 });
      return database.client.begin(async (sql) => {
        const db = drizzleTransaction(sql);
        const admitted = alias(runtimeAttempt, "restore_attempt");
        const newer = alias(runtimeAttempt, "newer");
        const [attempt] = await db
          .select({
            workspaceID: developmentWorkspace.id,
            projectID: admitted.projectId,
            userID: admitted.createdBy,
            token: admitted.parentConnectorTokenHash,
            actorUID: substrateBinding.actorUid,
            generation: admitted.generation,
          })
          .from(admitted)
          .innerJoin(substrateBinding, eq(substrateBinding.runtimeAttemptId, admitted.id))
          .innerJoin(
            developmentWorkspace,
            and(
              eq(developmentWorkspace.id, admitted.workspaceId),
              eq(developmentWorkspace.projectId, admitted.projectId),
              expression`${developmentWorkspace.changeId} IS NOT DISTINCT FROM ${admitted.changeId}`,
            ),
          )
          .where(
            and(
              eq(admitted.id, attemptID),
              eq(admitted.state, "starting"),
              isNull(admitted.stopIntendedAt),
              isNull(substrateBinding.deleteIntendedAt),
              isNull(substrateBinding.deletedAt),
              expression`${substrateBinding.intent}->>'sourceRestoreProtocol'='2'`,
              notExists(
                db
                  .select({ id: newer.id })
                  .from(newer)
                  .where(
                    and(
                      eq(newer.workspaceId, admitted.workspaceId),
                      gt(newer.generation, admitted.generation),
                    ),
                  ),
              ),
            ),
          )
          .for("share", { of: admitted });
        const auth = request.headers.get("authorization")?.replace(/^Bearer /, "");
        if (
          !attempt ||
          !auth ||
          hashConnectorToken(auth) !== attempt.token ||
          request.headers.get("X-Factory-Runtime-Actor-UID") !== attempt.actorUID ||
          request.headers.get("X-Factory-Runtime-Generation") !== String(attempt.generation)
        )
          return new Response(null, { status: 403 });
        // Keep the authority transaction's shared locks, but publish Source
        // facts durably on its dedicated connection before any external ACK.
        return locked(attempt.workspaceID, database.client, async (owner) => {
          const inputStop = await nativeInputStopIn(sql, attemptID);
          if (inputStop && (!inputStop.resumed || inputStop.completed))
            return new Response(null, { status: 409 });
          if (!inputStop) {
            const principal = await substrateRuntimePrincipalIn(sql, attemptID);
            await substrateWorkspaceGrantIn(database, sql, attempt.workspaceID, principal);
          }
          let row = await lease(attempt.workspaceID, owner);
          if (!row || !attempt.actorUID) return new Response(null, { status: 409 });
          const receipt = commit?.success ? commit.data : null;
          if (row.owner === "actor") {
            // A lost ACK can only confirm the same committed grant. GET never
            // replays a checkpoint over a tree this Actor may already have changed.
            if (
              !receipt ||
              !row.writable ||
              row.actorUID !== attempt.actorUID ||
              row.writerEpoch !== receipt.writerEpoch ||
              row.checkpoint?.id !== receipt.checkpointID
            )
              return new Response(null, { status: 409 });
            const role = await writer(row, sql);
            return Response.json(
              {
                version: 2,
                actorUID: attempt.actorUID,
                ...receipt,
                changeWriterEpoch: role.epoch,
                readOnly: Boolean(inputStop) || !role.writable,
              },
              { headers: { "cache-control": "no-store" } },
            );
          }
          await recipient(row, attempt.actorUID, owner);
          if (!receipt && (row.writable || row.checkpoint?.id !== row.checkpointID)) {
            // A seed may not have been opened in the IDE before explicit Start.
            // Its publication confirmation commits separately from this request.
            await service(row, owner);
            row = await lease(attempt.workspaceID, owner);
            if (!row) throw new CommandError("unavailable", "Independent Source owner changed");
            row = await confirm(
              await freeze(attempt.workspaceID, "service", owner),
              attemptID,
              owner,
            );
          }
          const plannedEpoch = row.writerEpoch + 1;
          if (!row.checkpoint || row.writable || row.checkpoint.id !== row.checkpointID)
            return new Response(null, { status: 409 });
          if (
            inputStop &&
            (row.checkpoint?.id !== inputStop.sourceCheckpointID ||
              plannedEpoch !== inputStop.sourceWriterEpoch)
          )
            return new Response(null, { status: 409 });
          if (row.checkpoint?.actorUID === null) {
            if (
              inputStop ||
              !row.seedConfirmedAt ||
              !row.seed ||
              row.checkpoint.seedID !== row.seed.id ||
              row.seed.workspaceID !== attempt.workspaceID
            )
              return new Response(null, { status: 409 });
          } else if (row.checkpoint.actorUID !== attempt.actorUID) {
            const [predecessor] = await db
              .select({ actorUID: substrateBinding.actorUid })
              .from(runtimeAttempt)
              .innerJoin(substrateBinding, eq(substrateBinding.runtimeAttemptId, runtimeAttempt.id))
              .where(
                and(
                  eq(runtimeAttempt.workspaceId, attempt.workspaceID),
                  expression`${runtimeAttempt.generation}<${attempt.generation}`,
                  eq(runtimeAttempt.state, "stopped"),
                  expression`${substrateBinding.deletedAt} IS NOT NULL`,
                  eq(substrateBinding.actorUid, row.checkpoint.actorUID),
                ),
              );
            if (!predecessor) return new Response(null, { status: 409 });
          }
          if (receipt) {
            if (receipt.checkpointID !== row.checkpoint.id || receipt.writerEpoch !== plannedEpoch)
              return new Response(null, { status: 409 });
            const role = await writer({ ...row, writable: true, writerEpoch: plannedEpoch }, sql);
            await verifiedManifest(row.checkpoint);
            await stopHost(attempt.workspaceID);
            await transfer(row, "actor", owner, attempt.actorUID);
            // This durable writer grant precedes the ACK. Docker starts only
            // after receiving it; a lost ACK can confirm this exact receipt.
            return Response.json(
              {
                version: 2,
                actorUID: attempt.actorUID,
                ...receipt,
                changeWriterEpoch: role.epoch,
                readOnly: Boolean(inputStop) || !role.writable,
              },
              { headers: { "cache-control": "no-store" } },
            );
          }
          const url = new URL(request.url);
          const chunk = url.searchParams.get("chunk");
          if (chunk === null) {
            if (row.checkpoint) await verifiedManifest(row.checkpoint);
            const role = await writer({ ...row, writable: true, writerEpoch: plannedEpoch }, sql);
            return Response.json(
              {
                version: 2,
                actorUID: attempt.actorUID,
                checkpointActorUID: row.checkpoint?.actorUID ?? null,
                checkpointSeedID: row.checkpoint?.seedID ?? null,
                writerEpoch: plannedEpoch,
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
            request.headers.get("X-Factory-Source-Writer-Epoch") !== String(plannedEpoch) ||
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
            {
              headers: { "content-type": "application/octet-stream", "cache-control": "no-store" },
            },
          );
        });
      });
    },
    async close() {
      for (const workspace of hosts.keys()) await stopHost(workspace);
    },
  };
}
