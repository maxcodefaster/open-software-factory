import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, open, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { SubstrateRPCError } from "#runtime-kubernetes/substrate-control";
import type { RuntimeSocketData } from "../../apps/factory/src/runtime/hub";
import { createPrivateObjects, type PrivateObjects } from "../../apps/factory/src/storage/objects";
import { createSubstrateSources } from "../../apps/factory/src/workspace/substrate-source";
import { substrateFixture } from "../fixtures/substrate";

const evidence = resolve(".factory/test-results/source-checkpoint-transfer");
const chunkBytes = 1 << 20;
const representative = process.env["FACTORY_SOURCE_TRANSFER_BENCHMARK"] === "1";
const size = representative ? 195_235_328 : 2 * chunkBytes + 512;
const objectDelayMS = process.env["FACTORY_SOURCE_TRANSFER_OBJECT_DELAY_MS"] === "10" ? 10 : 0;

type Sample = { calls: number; bytes: number; ms: number };
function sample(): Sample {
  return { calls: 0, bytes: 0, ms: 0 };
}

test("Source checkpoint confirm/materialize measures serial verified transfer at 1 MiB chunks", async () => {
  await mkdir(evidence, { recursive: true });
  const directory = await mkdtemp(join(evidence, "owned-transfer-"));
  const measurements = {
    fixture:
      "real RuntimeHub/WebSocket framing, loopback HTTP Source and immutable S3-compatible disk fixture; not native acceptance",
    bytes: size,
    chunkBytes,
    injectedObjectDelayMS: objectDelayMS,
    phases: { fixtureMS: 0, confirmMS: 0, materializeMS: 0 },
    operations: {
      sourceCheckpoint: sample(),
      sourceChunk: sample(),
      objectPut: sample(),
      objectRead: sample(),
      httpGetMissing: sample(),
      httpGet: sample(),
      httpPut: sample(),
    },
    maximumObjectConcurrency: 0,
    sources: {} as Record<string, string>,
    bundleSHA256: "",
  };
  for (const path of [
    "apps/factory/src/workspace/substrate-source.ts",
    "apps/factory/src/storage/objects.ts",
    "test/integration/source-checkpoint-transfer.test.ts",
  ])
    measurements.sources[path] = createHash("sha256")
      .update(await readFile(path))
      .digest("hex");
  let phase: "confirm" | "materialize" = "confirm";
  const phaseReads = { confirm: 0, materialize: 0 };
  let active = 0;
  const archive = join(directory, "fixture.tar");
  const whole = createHash("sha256");
  const chunks: string[] = [];
  const fixtureStart = performance.now();
  const output = await open(archive, "wx", 0o600);
  try {
    for (let offset = 0; offset < size; offset += chunkBytes) {
      // Opaque transfer bytes, not a native metadata archive: deterministic,
      // distinct full-size chunks and a realistic partial final chunk.
      const bytes = Buffer.alloc(Math.min(chunkBytes, size - offset));
      for (let i = 0; i < bytes.length; i += 4) bytes.writeUInt32LE((offset + i) >>> 0, i);
      whole.update(bytes);
      chunks.push(createHash("sha256").update(bytes).digest("hex"));
      await output.writeFile(bytes);
    }
    await output.sync();
  } finally {
    await output.close();
  }
  const bundle = {
    version: 1,
    bytes: size,
    sha256: whole.digest("hex"),
    chunks,
  };
  measurements.bundleSHA256 = bundle.sha256;
  measurements.phases.fixtureMS = performance.now() - fixtureStart;
  const objectDirectory = join(directory, "objects");
  await mkdir(objectDirectory);
  let corruptSourceChunk = false;
  const sourceHTTP = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const body = await request.json();
      if (new URL(request.url).pathname.endsWith("/checkpoint")) return Response.json(bundle);
      const index = body.chunk;
      if (!Number.isInteger(index) || index < 0 || index >= chunks.length)
        return new Response(null, { status: 400 });
      const file = Bun.file(archive).slice(index * chunkBytes, (index + 1) * chunkBytes);
      if (corruptSourceChunk) {
        const bytes = Buffer.from(await file.arrayBuffer());
        bytes[0] = (bytes[0] ?? 0) ^ 1;
        return new Response(bytes);
      }
      return new Response(file);
    },
  });
  const storageHTTP = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    maxRequestBodySize: 2 * chunkBytes,
    async fetch(request) {
      const start = performance.now();
      if (objectDelayMS) await Bun.sleep(objectDelayMS);
      const key = new URL(request.url).pathname.split("/").at(-1) ?? "";
      if (!/^(?:chunk-\d+|manifest\.json)$/.test(key)) return new Response(null, { status: 400 });
      const path = join(objectDirectory, key);
      if (request.method === "GET") {
        const file = Bun.file(path);
        const found = await file.exists();
        const metric = found
          ? measurements.operations.httpGet
          : measurements.operations.httpGetMissing;
        metric.calls++;
        metric.bytes += found ? file.size : 0;
        metric.ms += performance.now() - start;
        return found ? new Response(file) : new Response(null, { status: 404 });
      }
      if (request.method !== "PUT") return new Response(null, { status: 405 });
      const bytes = new Uint8Array(await request.arrayBuffer());
      const file = await open(path, "wx", 0o600);
      try {
        await file.writeFile(bytes);
        await file.sync();
      } finally {
        await file.close();
      }
      const metric = measurements.operations.httpPut;
      metric.calls++;
      metric.bytes += bytes.length;
      metric.ms += performance.now() - start;
      return new Response(null, { status: 200 });
    },
  });
  const binary = join(directory, "measured-materialize");
  // Stop at the existing process boundary, after validating the exact spooled
  // bytes. This deliberately does NOT simulate successful metadata extraction.
  await writeFile(
    binary,
    `#!${process.execPath}
import { createHash } from "node:crypto";
const start = performance.now();
const file = Bun.file(process.argv[3]);
const hash = createHash("sha256");
for await (const bytes of file.stream()) hash.update(bytes);
await Bun.write(process.argv[3] + ".measurement.json", JSON.stringify({
  bytes: file.size, sha256: hash.digest("hex"), verifyMS: performance.now() - start
}));
process.exit(17);
`,
    { mode: 0o700 },
  );
  const settings = {
    FACTORY_STATE_DIRECTORY: directory,
    FACTORY_SOURCE_SERVICE_BINARY: binary,
    FACTORY_OBJECT_S3_BUCKET: "owned-source-transfer",
    FACTORY_OBJECT_S3_ENDPOINT: storageHTTP.url.origin,
    FACTORY_OBJECT_S3_REGION: "owned-test",
    FACTORY_OBJECT_S3_ACCESS_KEY_ID: "owned-test-key",
    FACTORY_OBJECT_S3_SECRET_ACCESS_KEY: "owned-test-secret",
  };
  const previous = new Map<string, string | undefined>();
  const f = await substrateFixture().catch(async (cause: unknown) => {
    sourceHTTP.stop(true);
    storageHTTP.stop(true);
    await rm(directory, { recursive: true, force: true });
    throw cause;
  });
  let source: ReturnType<typeof createSubstrateSources> | undefined;
  let actor: ReturnType<typeof f.actor> | undefined;
  let relay: ReturnType<typeof Bun.serve<RuntimeSocketData>> | undefined;
  let connector: WebSocket | undefined;
  const pending = new Set<Promise<void>>();
  try {
    for (const [key, value] of Object.entries(settings)) {
      previous.set(key, process.env[key]);
      process.env[key] = value;
    }
    const stored = createPrivateObjects();
    const objects: PrivateObjects = {
      ...stored,
      async put(key, bytes, mediaType) {
        const start = performance.now();
        active++;
        measurements.maximumObjectConcurrency = Math.max(
          measurements.maximumObjectConcurrency,
          active,
        );
        try {
          await stored.put(key, bytes, mediaType);
        } finally {
          active--;
          measurements.operations.objectPut.calls++;
          measurements.operations.objectPut.bytes += bytes.length;
          measurements.operations.objectPut.ms += performance.now() - start;
        }
      },
      async read(key) {
        const start = performance.now();
        active++;
        measurements.maximumObjectConcurrency = Math.max(
          measurements.maximumObjectConcurrency,
          active,
        );
        try {
          const bytes = await stored.read(key);
          measurements.operations.objectRead.bytes += bytes.length;
          if (key.includes("/chunk-")) phaseReads[phase]++;
          return bytes;
        } finally {
          active--;
          measurements.operations.objectRead.calls++;
          measurements.operations.objectRead.ms += performance.now() - start;
        }
      },
    };
    source = createSubstrateSources(f.database, f.hub, objects);
    const controller = await f.controller(async (method) => {
      if (method === "GetAtespace") return f.space;
      if (method === "GetActorTemplate") return f.template;
      if (method === "GetActor") {
        if (!actor) throw new SubstrateRPCError("NotFound", "absent");
        return structuredClone(actor);
      }
      if (method === "CreateActor") {
        actor = await f.createdActor();
        return structuredClone(actor);
      }
      if (method === "ResumeActor" && actor) {
        actor.metadata.version = "2";
        actor.status = {
          state: "ACTOR_STATE_RUNNING",
          workerAssignment: { sandboxRuntime: f.config.runtime },
        };
        return { actor: structuredClone(actor) };
      }
      throw new Error(`Unexpected controlled runtime effect ${method}`);
    });
    await controller.start(f.projectID, f.userID);
    if (!actor) throw new Error("Controlled Source Actor is absent");
    await f.admitActorSource(actor.metadata.uid);
    const drains: string[] = [];
    f.hub.childOperation = async () => {
      drains.push("work");
    };
    f.hub.parentOperation = async () => {
      drains.push("control");
      return {};
    };
    relay = Bun.serve<RuntimeSocketData>({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request, server) {
        return server.upgrade(request, {
          data: { kind: "connector", role: "parent", attemptID: f.attemptID, generation: 1 },
        })
          ? undefined
          : new Response(null, { status: 400 });
      },
      websocket: {
        open(socket) {
          f.hub.open(socket);
        },
        message(socket, message) {
          f.hub.message(socket, message);
        },
        close(socket) {
          f.hub.close(socket);
        },
      },
    });
    const connected = Promise.withResolvers<void>();
    connector = new WebSocket(relay.url.href.replace(/^http/, "ws"));
    connector.addEventListener("open", () => connected.resolve());
    connector.addEventListener("error", () => connected.reject(new Error("Owned relay failed")));
    const requests = new Map<string, AbortController>();
    connector.addEventListener("message", (event) => {
      const frame = JSON.parse(String(event.data));
      if (frame.type === "stream-close") requests.get(frame.streamId)?.abort();
      if (frame.type !== "http-request") return;
      const socket = connector;
      if (!socket) return;
      const cancellation = new AbortController();
      requests.set(frame.streamId, cancellation);
      const transfer = (async () => {
        try {
          const response = await fetch(new URL(frame.path, sourceHTTP.url), {
            method: frame.method,
            body: Buffer.from(frame.data, "base64"),
            signal: cancellation.signal,
          });
          socket.send(
            JSON.stringify({
              type: "http-response",
              streamId: frame.streamId,
              status: response.status,
            }),
          );
          const bytes = Buffer.from(await response.arrayBuffer());
          for (let offset = 0; offset < bytes.length; offset += 64 << 10) {
            if (cancellation.signal.aborted) return;
            socket.send(
              JSON.stringify({
                type: "stream-data",
                streamId: frame.streamId,
                data: bytes.subarray(offset, offset + (64 << 10)).toString("base64"),
              }),
            );
          }
          socket.send(JSON.stringify({ type: "stream-end", streamId: frame.streamId }));
        } catch {
          if (!cancellation.signal.aborted)
            socket.send(JSON.stringify({ type: "stream-error", streamId: frame.streamId }));
        } finally {
          requests.delete(frame.streamId);
        }
      })();
      pending.add(transfer);
      void transfer.finally(() => pending.delete(transfer));
    });
    await connected.promise;
    connector.send(
      JSON.stringify({
        type: "hello",
        role: "parent",
        channels: [{ name: "source", kind: "source" }],
      }),
    );
    for (let i = 0; i < 100 && !f.hub.sourceConnected(f.attemptID); i++) await Bun.sleep(1);
    expect(f.hub.sourceConnected(f.attemptID)).toBe(true);
    const requestSource = f.hub.request.bind(f.hub);
    f.hub.request = async (_id, _channel, request, path) => {
      const start = performance.now();
      const response = await requestSource(_id, _channel, request, path);
      const bytes = await response.arrayBuffer();
      const metric = path.endsWith("/checkpoint")
        ? measurements.operations.sourceCheckpoint
        : measurements.operations.sourceChunk;
      metric.calls++;
      metric.bytes += bytes.byteLength;
      metric.ms += performance.now() - start;
      return new Response(bytes, { status: response.status });
    };
    if (!representative) {
      corruptSourceChunk = true;
      await expect(
        source.freezeActor(f.workspaceID, f.attemptID, f.database.client),
      ).rejects.toThrow("Confirmed Source chunk is missing or corrupt");
      expect(await source.lease(f.workspaceID)).toMatchObject({
        owner: "actor",
        writable: false,
        generation: 0,
        checkpoint: null,
      });
      expect(measurements.operations.objectPut.calls).toBe(0);
      corruptSourceChunk = false;
      drains.length = 0;
      for (const metric of Object.values(measurements.operations)) Object.assign(metric, sample());
    }
    let start = performance.now();
    await source.freezeActor(f.workspaceID, f.attemptID, f.database.client);
    measurements.phases.confirmMS = performance.now() - start;
    const confirmedOperations = structuredClone(measurements.operations);
    expect(drains).toEqual(["work", "control"]);
    const frozen = await source.lease(f.workspaceID);
    expect(frozen).toMatchObject({
      owner: "actor",
      writable: false,
      generation: 1,
      checkpoint: { bundle },
    });
    await f.database
      .client`UPDATE factory.runtime_attempt SET state='stopping',stop_intended_at=now() WHERE id=${f.attemptID}`;
    phase = "materialize";
    start = performance.now();
    await expect(source.makeIndependent(f.workspaceID, f.database.client)).rejects.toThrow(
      "Source metadata/materialization is unsupported or corrupt; old data retained",
    );
    measurements.phases.materializeMS = performance.now() - start;
    const { readdir } = await import("node:fs/promises");
    const workspace = join(directory, "workspace-source", f.workspaceID);
    const staging = (await readdir(workspace)).find((name) => name.startsWith("staging-"));
    if (!staging) throw new Error("Owned archive staging is absent");
    const spooled = JSON.parse(
      await readFile(join(workspace, staging, "source.tar.measurement.json"), "utf8"),
    );
    expect(spooled).toMatchObject({ bytes: size, sha256: bundle.sha256 });
    expect(
      await Bun.file(join(workspace, frozen?.checkpointID ?? "", "confirmed.json")).exists(),
    ).toBe(false);
    expect(measurements.maximumObjectConcurrency).toBe(1);
    expect(measurements.operations.sourceChunk.calls).toBe(chunks.length);
    expect(phaseReads).toEqual({ confirm: chunks.length, materialize: chunks.length });
    const result = {
      ...measurements,
      chunks: chunks.length,
      phaseReads,
      confirmedOperations,
      residualMS: {
        confirm:
          measurements.phases.confirmMS -
          confirmedOperations.sourceCheckpoint.ms -
          confirmedOperations.sourceChunk.ms -
          confirmedOperations.objectPut.ms -
          confirmedOperations.objectRead.ms,
        materialize:
          measurements.phases.materializeMS -
          (measurements.operations.objectRead.ms - confirmedOperations.objectRead.ms),
      },
      spooled,
    };
    console.info(JSON.stringify(result));
    await writeFile(
      join(evidence, `${representative ? "representative" : "focused"}-${f.workspaceID}.json`),
      `${JSON.stringify(result, null, 2)}\n`,
    );
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    try {
      await source?.close();
    } finally {
      f.hub.revoke(f.attemptID);
      connector?.close();
      relay?.stop(true);
      sourceHTTP.stop(true);
      storageHTTP.stop(true);
      await Promise.allSettled(pending);
      try {
        await f.dispose();
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    }
  }
}, 60_000);
