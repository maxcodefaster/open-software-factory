import { readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { z } from "zod";
import { RuntimeHub } from "../../apps/factory/src/runtime/hub";
import { createSubstrateIsolated } from "../../apps/factory/src/runtime/substrate-isolated";
import {
  createSubstrateWorkspaces,
  substrateInstallationConfiguration,
} from "../../apps/factory/src/runtime/substrate-workspaces";
import { createSubstrateSources } from "../../apps/factory/src/workspace/substrate-source";
import type { createDatabase } from "../../packages/db/src/client";
import { runtimeConnectorTokens } from "../../packages/runtime-domain/src/identity";
import {
  nativeActor,
  type SubstrateCall,
  SubstrateRPCError,
} from "../../packages/runtime-kubernetes/src/substrate-control";
import type { SystemContract } from "../../packages/system-contract/src/system-contract";
import { eventually, type factoryProcess, ownedFactorySigningSecret } from "./factory-process";

type Host = Awaited<ReturnType<typeof factoryProcess>>;
type Database = ReturnType<typeof createDatabase>;
const ConnectorSocket = WebSocket as typeof WebSocket & {
  new (url: string, options: Bun.WebSocketOptions): WebSocket;
};

// Process/transport regression peer, never native runtime acceptance. Factory
// persists and provisions its normal owners. Its running process observes them
// through the unchanged bridge boundary. Only the RPC peer is controlled; no
// Actor or external write exists.
export async function nativeProcessProtocol(
  host: Host,
  database: Database,
  beforeCall?: (method: string) => Promise<void>,
) {
  const expected = resolve(".factory/test-results/factory-process", host.id, "substrate.json");
  if (
    host.nativeConfiguration !== expected ||
    host.processes.some((child) => child.exitCode === null && child.signalCode === null)
  )
    throw Error("Controlled native protocol requires its stopped, uncommissioned Factory fixture");
  const original = await readFile(expected, "utf8");
  const base = substrateInstallationConfiguration(JSON.parse(original));
  const [scope] = await database.client<{ database: string }[]>`
    SELECT current_database() AS database`;
  if (
    base.deployment !== "owned-test" ||
    base.database !== `owned_${host.id.replaceAll("-", "")}` ||
    scope?.database !== base.database ||
    base.connection.bridge !== join(dirname(expected), "unavailable-native-control") ||
    base.connection.endpoint !== "127.0.0.1:1"
  )
    throw Error("Controlled native protocol requires the exact owned database");

  const resources = new Map<string, Map<string, Record<string, unknown>>>();
  const calls: { method: string; scope: string }[] = [];
  const token = crypto.randomUUID();
  const hub = new RuntimeHub(async () => {});
  const sources = createSubstrateSources(database, hub);
  const sockets = new Set<WebSocket>();
  const socketOwners = new WeakMap<WebSocket, { attemptID: string; role: "parent" | "child" }>();
  const sourceFences: {
    attemptID: string;
    workspaceID: string;
    writerEpoch: number;
    writable: boolean;
  }[] = [];
  const call: SubstrateCall = async (method, input) => {
    if (
      !/^(Get|Create)(Atespace|AtespaceAccessPolicy|ActorTemplate|ActorEgressPolicy|Actor)$/.test(
        method,
      ) &&
      !["ResumeActor", "DeleteActor"].includes(method)
    )
      throw Error("Uncommissioned controlled native method");
    const request = input as Record<string, Record<string, unknown>>;
    const kind = method.replace(/^(Get|Create|Resume|Delete)/, "");
    const declaration =
      request["accessPolicy"] ??
      request["egressPolicy"] ??
      request[`${kind[0]?.toLowerCase()}${kind.slice(1)}`];
    const metadata = declaration?.["metadata"] as Record<string, unknown> | undefined;
    const scope =
      request["atespace"]?.["name"] ??
      metadata?.["atespace"] ??
      request["actorTemplate"]?.["atespace"] ??
      request["actor"]?.["atespace"] ??
      (kind === "Atespace" ? metadata?.["name"] : undefined);
    if (typeof scope !== "string" || !/^fa-[a-f0-9]{32}$/.test(scope))
      throw Error("Controlled native protocol requires its exact scope");
    calls.push({ method, scope });
    let objects = resources.get(scope);
    if (!objects) {
      objects = new Map();
      resources.set(scope, objects);
    }
    if (method.startsWith("Get")) {
      const saved = objects.get(kind);
      if (!saved) throw new SubstrateRPCError("NotFound", "Controlled native resource absent");
      return structuredClone(saved);
    }
    if (method.startsWith("Create")) {
      if (!declaration || objects.has(kind))
        throw Error("Controlled native Create cannot replace an existing resource");
      const [clock] = await database.client<{ created: string }[]>`
        SELECT clock_timestamp()::text AS created`;
      if (!clock) throw Error("Controlled native protocol clock is unavailable");
      const value = {
        ...declaration,
        metadata: {
          ...metadata,
          uid: crypto.randomUUID(),
          version: "1",
          createTime: new Date(clock.created).toISOString(),
        },
      };
      if (kind === "Actor") Object.assign(value, { status: { state: "ACTOR_STATE_SUSPENDED" } });
      objects.set(kind, value);
      return structuredClone(value);
    }
    const actor = nativeActor.parse(objects.get("Actor"));
    if (request["actor"]?.["name"] !== actor.metadata.name)
      throw Error("Controlled native operation names another Actor");
    if (method === "ResumeActor") {
      actor.metadata.version = String(BigInt(actor.metadata.version) + 1n);
      actor.status = {
        state: "ACTOR_STATE_RUNNING",
        workerAssignment: { sandboxRuntime: base.runtime },
      };
      objects.set("Actor", actor);
      return { actor: structuredClone(actor) };
    }
    if (
      request["options"]?.["uid"] !== actor.metadata.uid ||
      request["options"]?.["version"] !== actor.metadata.version
    )
      throw Error("Controlled native Delete must name its original UID and version");
    objects.delete("Actor");
    return {};
  };
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      if (
        request.method !== "POST" ||
        new URL(request.url).pathname !== "/rpc" ||
        request.headers.get("authorization") !== `Bearer ${token}`
      )
        return new Response(null, { status: 403 });
      try {
        const input = (await request.json()) as { method: string; request: unknown };
        await beforeCall?.(input.method);
        return Response.json(await call(input.method, input.request));
      } catch (cause) {
        return Response.json({
          error: {
            code: cause instanceof SubstrateRPCError ? cause.code : "Internal",
            message: cause instanceof SubstrateRPCError ? cause.message : "Controlled RPC refused",
          },
        });
      }
    },
  });
  const directory = dirname(expected);
  const tokenFile = join(directory, "controlled-native-peer-token");
  const bridge = join(directory, "controlled-native-bridge");
  try {
    await writeFile(tokenFile, token, { mode: 0o600 });
    await writeFile(
      bridge,
      `#!${process.execPath}
const input = await Bun.stdin.json();
const token = await Bun.file(input.tokenFile).text();
const response = await fetch("http://" + input.endpoint + "/rpc", {
  method: "POST",
  headers: { authorization: "Bearer " + token, "content-type": "application/json" },
  body: JSON.stringify({ method: input.method, request: input.request }),
  signal: AbortSignal.timeout(10000),
});
if (!response.ok) process.exit(1);
process.stdout.write(await response.text());
`,
      { mode: 0o700 },
    );
    const connection = { ...base.connection, bridge, tokenFile, endpoint: server.url.host };
    const configuration = {
      ...base,
      connection,
      provisioner: connection,
      egressHosts: ["owned-build.factory.invalid"],
    };
    await writeFile(expected, JSON.stringify(configuration), { mode: 0o600 });
    return {
      calls,
      sourceFences,
      async startWorkspace(
        projectID: string,
        userID: string,
        contract: SystemContract,
        changeID?: string,
      ) {
        const owner = createSubstrateWorkspaces(
          database,
          hub,
          ownedFactorySigningSecret,
          { ...configuration, projectID },
          call,
          call,
          async () => contract,
          changeID ? sources : undefined,
        );
        const previousImage = process.env["FACTORY_BROWSER_TOOLS_IMAGE"];
        try {
          process.env["FACTORY_BROWSER_TOOLS_IMAGE"] =
            `registry.example.invalid/owned-browser@sha256:${"d".repeat(64)}`;
          return await owner.start(userID, changeID);
        } finally {
          if (previousImage === undefined) delete process.env["FACTORY_BROWSER_TOOLS_IMAGE"];
          else process.env["FACTORY_BROWSER_TOOLS_IMAGE"] = previousImage;
        }
      },
      async startStaging(projectID: string, userID: string, contract: SystemContract) {
        const owner = createSubstrateIsolated(
          database,
          hub,
          ownedFactorySigningSecret,
          { ...configuration, projectID },
          async () => contract,
          call,
          call,
        );
        return owner.stage(userID);
      },
      async connectorHeaders(attemptID: string, role: "parent" | "child") {
        const [attempt] = await database.client<{ actorUID: string; generation: number }[]>`
          SELECT binding.actor_uid AS "actorUID",attempt.generation::float8 AS generation
          FROM factory.runtime_attempt attempt JOIN factory.substrate_binding binding
            ON binding.runtime_attempt_id=attempt.id
          WHERE attempt.id=${attemptID} AND binding.actor_uid IS NOT NULL AND binding.deleted_at IS NULL`;
        if (!attempt) throw Error("Controlled Connector requires its original Actor binding");
        const tokens = runtimeConnectorTokens(
          ownedFactorySigningSecret,
          attemptID,
          attempt.generation,
        );
        return {
          authorization: `Bearer ${tokens[role]}`,
          "x-factory-connector-role": role,
          "x-factory-runtime-attempt": attemptID,
          "x-factory-runtime-generation": String(attempt.generation),
          "x-factory-runtime-actor-uid": attempt.actorUID,
        };
      },
      async connect(
        attemptID: string,
        role: "parent" | "child",
        receive: (socket: WebSocket) => void,
      ): Promise<WebSocket> {
        const headers = await this.connectorHeaders(attemptID, role);
        const [source] =
          role === "parent"
            ? await database.client<{ id: string }[]>`
          SELECT source.workspace_id AS id FROM factory.substrate_source source
          JOIN factory.runtime_attempt attempt ON attempt.workspace_id=source.workspace_id
          WHERE attempt.id=${attemptID} AND source.actor_uid=${headers["x-factory-runtime-actor-uid"]}
            AND source.owner='actor' AND source.writable`
            : [];
        // Process readiness precedes its asynchronous native recovery. Like a
        // real Connector, retry only this transport upgrade until the original
        // binding is admitted. No native lifecycle operation or input is replayed.
        const deadline = Date.now() + 10_000;
        const connected = await eventually(
          async () => {
            const socket = new ConnectorSocket(
              `${host.base.replace("http:", "ws:")}/internal/runtime-connect`,
              { protocols: [RuntimeHub.protocol()], headers },
            );
            sockets.add(socket);
            socketOwners.set(socket, { attemptID, role });
            socket.addEventListener("close", () => sockets.delete(socket), { once: true });
            receive(socket);
            const opened = await new Promise<boolean>((resolve) => {
              const opened = () => finish(true);
              const failed = () => finish(false);
              const finish = (value: boolean) => {
                clearTimeout(timeout);
                socket.removeEventListener("open", opened);
                socket.removeEventListener("error", failed);
                socket.removeEventListener("close", failed);
                resolve(value);
              };
              // Native authorization may still be reading the original Actor.
              // Keep this upgrade until it settles or the existing overall
              // connection deadline expires, rather than guessing one second.
              const timeout = setTimeout(failed, Math.max(0, deadline - Date.now()));
              socket.addEventListener("open", opened, { once: true });
              socket.addEventListener("error", failed, { once: true });
              socket.addEventListener("close", failed, { once: true });
            });
            if (opened) return socket;
            socket.close();
            return undefined;
          },
          (socket) => socket !== undefined,
          "Original native Connector binding was not admitted after process recovery",
        );
        if (!connected) throw Error("Controlled native Connector is unavailable");
        connected.send(
          JSON.stringify({
            type: "hello",
            role,
            channels: source ? [{ name: "source", kind: "source" }] : [],
          }),
        );
        return connected;
      },
      async sourceFence(socket: WebSocket, value: unknown) {
        const connection = socketOwners.get(socket);
        if (connection?.role !== "parent")
          throw Error("Controlled Source requires its original Parent Connector");
        const frame = z
          .object({
            type: z.literal("http-request"),
            channel: z.literal("source"),
            method: z.literal("POST"),
            path: z.string(),
            streamId: z.uuid(),
            data: z.string(),
          })
          .parse(value);
        const path = /^\/v1\/workspaces\/([a-f0-9-]{36})\/fence$/.exec(frame.path);
        const body = z
          .strictObject({
            writerEpoch: z.number().int().positive(),
            writable: z.boolean(),
          })
          .parse(JSON.parse(Buffer.from(frame.data, "base64").toString()));
        const [owner] = path
          ? await database.client<
              {
                attemptID: string;
                epoch: number;
                state: string;
              }[]
            >`SELECT attempt.id AS "attemptID",writer.epoch::float8 AS epoch,writer.state
          FROM factory.substrate_source source JOIN factory.runtime_attempt attempt
            ON attempt.workspace_id=source.workspace_id
          JOIN factory.substrate_binding binding ON binding.runtime_attempt_id=attempt.id AND binding.actor_uid=source.actor_uid
          JOIN factory.development_workspace workspace ON workspace.id=source.workspace_id
          JOIN factory.change_writer writer ON writer.change_id=workspace.change_id
          WHERE source.workspace_id=${path[1] ?? ""} AND source.owner='actor' AND source.writable
            AND attempt.id=${connection.attemptID}
            AND attempt.state='ready' AND attempt.stop_intended_at IS NULL
            AND binding.delete_intended_at IS NULL AND binding.deleted_at IS NULL`
          : [];
        const confirmed =
          !!owner &&
          body.writerEpoch === owner.epoch &&
          body.writable === (owner.state === "human");
        if (confirmed && owner && path?.[1])
          sourceFences.push({ attemptID: owner.attemptID, workspaceID: path[1], ...body });
        socket.send(
          JSON.stringify({
            type: "http-response",
            streamId: frame.streamId,
            status: confirmed ? 200 : 409,
            headers: { "content-type": "application/json" },
          }),
        );
        socket.send(
          JSON.stringify({
            type: "stream-data",
            streamId: frame.streamId,
            data: Buffer.from(JSON.stringify({ confirmed })).toString("base64"),
          }),
        );
        socket.send(JSON.stringify({ type: "stream-end", streamId: frame.streamId }));
      },
      async close() {
        if (host.processes.some((child) => child.exitCode === null && child.signalCode === null))
          throw Error("Stop the owned Factory before closing its controlled native protocol");
        await sources.close();
        for (const socket of sockets) socket.close();
        await server.stop(true);
        await writeFile(expected, original, { mode: 0o600 });
        await rm(bridge, { force: true });
        await rm(tokenFile, { force: true });
      },
    };
  } catch (cause) {
    await sources.close();
    await server.stop(true);
    await writeFile(expected, original, { mode: 0o600 });
    await rm(bridge, { force: true });
    await rm(tokenFile, { force: true });
    throw cause;
  }
}
