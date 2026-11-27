import { expect } from "bun:test";
import { isAbsolute } from "node:path";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { z } from "zod";
import { nativeLifecycleWindowMS } from "#runtime-domain/timing";
import {
  nativeActor,
  nativeSnapshot,
  type SubstrateCall,
  SubstrateRPCError,
} from "#runtime-kubernetes/substrate-control";
import { nativeRuntimeArchitecture } from "#runtime-kubernetes/substrate-profile";
import { parseSubstrateProjectTemplate } from "#runtime-kubernetes/substrate-project-template";
import { runtimeAttemptSchema } from "../../apps/factory/src/runtime/contracts";
import type { RuntimeArtifacts } from "../../scripts/factory/artifacts";
import { ownedMCPAuthorization, ownedMCPAuthProvider } from "./mcp-authorization";

export function starterArtifactDirectory(value: string | undefined) {
  if (value !== undefined && !isAbsolute(value))
    throw Error("FACTORY_STARTER_ARTIFACT_DIRECTORY must be an absolute owned artifact directory");
  return value ?? ".factory";
}

export function requireStarterNativeContract(content: string, artifacts: RuntimeArtifacts) {
  const template = parseSubstrateProjectTemplate(content);
  expect(template.containers.map((container) => container.name).sort()).toEqual([
    "postgres",
    "work",
  ]);
  expect(template.containers.find((container) => container.name === "work")).toMatchObject({
    image: artifacts["starter-work"],
    command: ["/bin/sh", "-ec", "npm ci && npm run db:wait && npm run db:migrate"],
    volumeMounts: [{ name: "source", mountPath: "/workspace" }],
  });
  expect(template.containers.find((container) => container.name === "postgres")).toMatchObject({
    image: artifacts["starter-postgres"],
    command: ["/usr/local/bin/docker-entrypoint.sh", "postgres", "-h", "127.0.0.1"],
    volumeMounts: [{ name: "database", mountPath: "/data" }],
  });
  expect(template.volumes).toEqual([
    { name: "source", durableDir: {} },
    { name: "database", durableDir: {} },
  ]);
  return template;
}

// Explicit destructive disposal only, never ordinary Workspace Pause. A saved
// deleted_at is not a live absence check; a changed UID is not absence either.
export async function requireStarterActorAbsent(
  call: SubstrateCall,
  binding: { atespace: string; actorName: string },
) {
  try {
    await call("GetActor", { actor: { atespace: binding.atespace, name: binding.actorName } });
  } catch (cause) {
    if (cause instanceof SubstrateRPCError && cause.code === "NotFound") return;
    throw cause;
  }
  throw Error("Disposed Starter Actor still exists; native absence was not confirmed");
}

export const starterRetainedObservationSchema = z.object({
  attemptID: z.uuid(),
  workspaceID: z.uuid(),
  projectID: z.uuid(),
  generation: z.string().regex(/^[1-9][0-9]*$/),
  // Read-only observation can see transitions; qualification below still
  // requires ready -> paused/detached -> ready.
  state: z.string().min(1),
  actor: nativeActor,
  // Retained grant metadata, not current file availability on suspended compute.
  source: z
    .object({
      workspaceID: z.uuid(),
      actorUID: z.uuid(),
      owner: z.literal("actor"),
      writerEpoch: z.number().int().positive(),
      generation: z.number().int().nonnegative(),
      writable: z.literal(true),
      checkpointID: z.null(),
    })
    .passthrough(),
  inference: z.object({
    agentTurns: z.literal(0),
    agentSessions: z.literal(0),
    modelOperations: z.literal(0),
    modelUsageEntries: z.literal(0),
  }),
});
const checkoutFile = z.object({
  path: z.string().min(1),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  gitStatus: z.string().min(1),
});
export const starterActiveObservationSchema = starterRetainedObservationSchema.extend({
  dirtySource: checkoutFile,
  stagedSource: checkoutFile,
  untrackedSource: checkoutFile,
  // Created once on the owned image-backed rootfs, outside durable mounts.
  // The live collector must only read it after Resume, never recreate it.
  rootfs: z.object({
    path: z.templateLiteral(["/home/node/factory-starter-", z.uuid(), ".rootfs"]),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    // Decimal bigint serialization preserves nanoseconds without JS rounding.
    mtimeNs: z.string().regex(/^[1-9][0-9]*$/),
  }),
  // Collected from a live long-lived probe: the nonce exists only in RAM,
  // and a fresh challenge advances its counter. A PID or saved file is not proof.
  process: z.object({
    // Read inside the sandbox, not from its host/worker or a saved probe file.
    bootID: z.uuid(),
    pid: z.number().int().positive(),
    instanceID: z.uuid(),
    memoryNonce: z.uuid(),
    challenge: z.uuid(),
    counter: z.number().int().nonnegative(),
  }),
  compiler: z.object({
    commandID: z.uuid(),
    workspaceID: z.uuid(),
    attemptID: z.uuid(),
    state: z.literal("exited"),
    exitCode: z.literal(0),
    stdout: z.string().includes("tsc --noEmit").includes("fail 0"),
  }),
  appStatus: z.literal(200),
});
export type StarterRetainedObservation = z.infer<typeof starterRetainedObservationSchema>;
export type StarterActiveObservation = z.infer<typeof starterActiveObservationSchema>;

// Pure assertions for the maintained live caller's real observations. Unit
// fixtures qualify these guards, not native execution. Nothing here collects
// files while paused, wakes compute, exports Source or claims a native pass.
export function requireStarterRetainedLifecycleEvidence(value: unknown) {
  const evidence = z
    .object({
      before: starterActiveObservationSchema,
      paused: starterRetainedObservationSchema,
      after: starterActiveObservationSchema,
      templateUID: z.uuid(),
      // Expected RESTORE fidelity, not necessarily the paused snapshot's label.
      // Native detached Resume can cold-restore a MEMORY snapshot on an
      // incompatible runtime without changing that original snapshot label.
      fidelity: nativeSnapshot.shape.fidelity,
    })
    .parse(value);
  const { before, paused, after, templateUID, fidelity } = evidence;
  expect(before.actor.status.state).toBe("ACTOR_STATE_RUNNING");
  const sandboxRuntime = before.actor.status.workerAssignment?.sandboxRuntime;
  if (!sandboxRuntime) throw Error("Starter running Actor has no observed native runtime");
  expect(before.state).toBe("ready");
  expect(before.actor.metadata.atespace).toBe(`fa-${before.attemptID.replaceAll("-", "")}`);
  expect(before.actor.metadata.name).toBe(`runtime-${before.attemptID.replaceAll("-", "")}`);
  for (const observed of [before, paused, after]) {
    expect(observed.attemptID).toBe(before.attemptID);
    expect(observed.workspaceID).toBe(before.workspaceID);
    expect(observed.projectID).toBe(before.projectID);
    expect(observed.generation).toBe(before.generation);
    expect(observed.actor.metadata).toMatchObject({
      uid: before.actor.metadata.uid,
      atespace: before.actor.metadata.atespace,
      name: before.actor.metadata.name,
      createTime: before.actor.metadata.createTime,
    });
    expect(observed.actor.actorTemplate).toEqual(before.actor.actorTemplate);
    expect(observed.source).toEqual(before.source);
  }
  expect(before.source.workspaceID).toBe(before.workspaceID);
  expect(before.source.actorUID).toBe(before.actor.metadata.uid);
  expect(paused.state).toBe("paused");
  expect(paused.actor.status.state).toBe("ACTOR_STATE_SUSPENDED");
  expect(paused.actor.status.workerAssignment).toBeUndefined();
  // Upstream can release the worker assignment before detaching from its node.
  expect(paused.actor.status.assignedNode).toBeUndefined();
  const snapshots = (paused.actor.status.snapshots ?? []).filter(
    (item) =>
      z.object({ generation: z.number() }).parse(item).generation ===
      paused.actor.status.lastAssignedGeneration,
  );
  if (snapshots.length !== 1)
    throw Error("Starter Pause has no unique confirmed latest durable native snapshot");
  const snapshot = nativeSnapshot.parse(snapshots[0]);
  if (fidelity === "SNAPSHOT_FIDELITY_MEMORY") expect(snapshot.fidelity).toBe(fidelity);
  expect(snapshot.actorTemplateUid).toBe(templateUID);
  expect(snapshot.sandboxRuntime).toEqual(sandboxRuntime);
  const snapshotURL = new URL(snapshot.durableSnapshot.object.snapshotUri);
  expect(["s3:", "gs:"]).toContain(snapshotURL.protocol);
  expect(snapshotURL.hostname).not.toBe("");
  expect(snapshotURL.search + snapshotURL.hash + snapshotURL.username + snapshotURL.password).toBe(
    "",
  );
  expect(
    snapshotURL.pathname.endsWith(
      `/atespaces/${paused.actor.metadata.atespace}/actors/${paused.actor.metadata.uid}/snapshots/${snapshot.uuid}`,
    ),
  ).toBe(true);
  expect(after.state).toBe("ready");
  expect(after.actor.status.state).toBe("ACTOR_STATE_RUNNING");
  const restoredRuntime = after.actor.status.workerAssignment?.sandboxRuntime;
  if (!restoredRuntime) throw Error("Starter resumed Actor has no observed native runtime");
  expect(restoredRuntime.sandboxClass).toBe(sandboxRuntime.sandboxClass);
  expect(nativeRuntimeArchitecture(restoredRuntime)).toBe(
    nativeRuntimeArchitecture(sandboxRuntime),
  );
  expect(after.rootfs).toEqual(before.rootfs);
  for (const kind of ["dirtySource", "stagedSource", "untrackedSource"] as const) {
    expect(after[kind]).toEqual(before[kind]);
    expect(before[kind].gitStatus).toContain(before[kind].path);
  }
  expect(
    new Set([before.dirtySource.path, before.stagedSource.path, before.untrackedSource.path]).size,
  ).toBe(3);
  expect(before.dirtySource.gitStatus).toMatch(/^ M /);
  expect(before.stagedSource.gitStatus).toMatch(/^A {2}/);
  expect(before.untrackedSource.gitStatus).toMatch(/^\?\? /);
  for (const observed of [before, after]) {
    expect(observed.compiler.workspaceID).toBe(before.workspaceID);
    expect(observed.compiler.attemptID).toBe(before.attemptID);
  }
  expect(after.compiler.commandID).not.toBe(before.compiler.commandID);
  expect(after.process.challenge).not.toBe(before.process.challenge);
  if (fidelity === "SNAPSHOT_FIDELITY_MEMORY") {
    expect(restoredRuntime).toEqual(sandboxRuntime);
    expect(after.process.bootID).toBe(before.process.bootID);
    expect(after.process.instanceID).toBe(before.process.instanceID);
    expect(after.process.memoryNonce).toBe(before.process.memoryNonce);
    expect(after.process.pid).toBe(before.process.pid);
    expect(after.process.counter).toBeGreaterThan(before.process.counter);
  } else {
    if (snapshot.fidelity === "SNAPSHOT_FIDELITY_MEMORY") {
      // A mere process restart cannot prove native incompatible-runtime fallback.
      // Compare attribute values, not their order or Actor metadata.version.
      const attributes = (runtime: typeof sandboxRuntime) =>
        runtime.version.attributes.toSorted(
          (a, b) => a.key.localeCompare(b.key) || a.value.localeCompare(b.value),
        );
      expect({
        ...restoredRuntime.version,
        attributes: attributes(restoredRuntime),
      }).not.toEqual({ ...sandboxRuntime.version, attributes: attributes(sandboxRuntime) });
    }
    // ROOTFS may reuse the same numeric PID. Require a new sandbox boot and
    // process RAM identity as well as retained rootfs and Source witnesses.
    expect(after.process.bootID).not.toBe(before.process.bootID);
    expect(after.process.memoryNonce).not.toBe(before.process.memoryNonce);
    expect(after.process.instanceID).not.toBe(before.process.instanceID);
  }
  return evidence;
}

const workspace = z.object({
  workspaceID: z.uuid(),
  runtime: runtimeAttemptSchema.nullable(),
});
const file = z.object({
  content: z.string(),
  version: z.string().min(1),
  nextOffset: z.number().nullable(),
});
const command = z.object({
  commandID: z.uuid(),
  workspaceID: z.uuid(),
  attemptID: z.uuid(),
  state: z.string(),
  exitCode: z.number().int().nullable(),
});
const output = command.extend({
  stdout: z.string(),
  stderr: z.string(),
  outputAvailable: z.literal(true),
  outputLost: z.literal(false),
  stdoutFrom: z.number().int().nonnegative(),
  stderrFrom: z.number().int().nonnegative(),
  stdoutNext: z.number().int().nonnegative(),
  stderrNext: z.number().int().nonnegative(),
});

class StarterNativeToolError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export function starterNativeLifecycle(client: Pick<Client, "callTool">) {
  async function call<T>(name: string, args: Record<string, unknown>, schema: z.ZodType<T>) {
    const mayResume = name === "writeFile" || name === "readFile";
    const response = await client.callTool(
      { name, arguments: args },
      {
        timeout:
          mayResume || ["runCommand", "startWorkspace", "pauseWorkspace"].includes(name)
            ? nativeLifecycleWindowMS + 30_000
            : 30_000,
      },
    );
    const text = response.content.find((part) => part.type === "text");
    if (text?.type !== "text") throw Error(`Starter ${name} returned no MCP outcome`);
    if (response.isError) {
      const failure = z
        .object({ error: z.object({ code: z.string(), message: z.string() }) })
        .parse(JSON.parse(text.text));
      throw new StarterNativeToolError(failure.error.code, failure.error.message);
    }
    return schema.parse(JSON.parse(text.text));
  }
  return {
    workspace: (workspaceID: string) => call("getWorkspace", { workspaceID }, workspace),
    async file(workspaceID: string, path: string) {
      const value = await call("readFile", { workspaceID, path, limit: 16384 }, file);
      if (value.nextOffset !== null)
        throw Error("Starter proof file exceeds its single-page bound");
      return value;
    },
    async currentFile(workspaceID: string, path: string) {
      const value = await call(
        "readFile",
        { workspaceID, path, location: "container", limit: 16384 },
        file,
      );
      if (value.nextOffset !== null)
        throw Error("Current Starter file exceeds its single-page bound");
      return value;
    },
    save: (workspaceID: string, path: string, content: string, version: string) =>
      call("writeFile", { workspaceID, path, content, version }, z.unknown()),
    // The caller retains the ID before dispatch, including on a lost reply.
    // Reusing it observes that intent; this helper never retries or replaces it.
    start: (workspaceID: string, requestID: string) =>
      call(
        "startWorkspace",
        { workspaceID, requestID: z.uuid().parse(requestID) },
        runtimeAttemptSchema,
      ),
    pause: (workspaceID: string, requestID: string) =>
      call(
        "pauseWorkspace",
        { workspaceID, requestID: z.uuid().parse(requestID) },
        runtimeAttemptSchema,
      ),
    async command(input: { workspaceID: string; attemptID: string; command: string }) {
      const commandID = crypto.randomUUID();
      const started = performance.now();
      let completed = false;
      let stdout = "";
      let stderr = "";
      let stdoutCursor = 0;
      let stderrCursor = 0;
      const selected = {
        commandID,
        workspaceID: input.workspaceID,
        attemptID: input.attemptID,
      };
      try {
        // The shipped Linux Work image must provide GNU timeout. The remote
        // process tree is bounded too, not merely this observer's HTTP request.
        const bounded = `timeout --signal=TERM --kill-after=5s 300s /bin/sh -ec '${input.command.replaceAll("'", "'\\''")}'`;
        const admission = await call(
          "runCommand",
          { requestID: commandID, workspaceID: input.workspaceID, command: bounded, env: {} },
          command,
        );
        expect(admission).toMatchObject(selected);
        if (!["starting", "running", "exited"].includes(admission.state))
          throw Error(`Starter command ${commandID} admission is ${admission.state}`);
        const deadline = Date.now() + 360_000;
        while (Date.now() < deadline) {
          const page = await call(
            "readCommandOutput",
            { commandID, stdout: stdoutCursor, stderr: stderrCursor },
            output,
          );
          expect(page).toMatchObject(selected);
          expect(page.stdoutFrom).toBe(stdoutCursor);
          expect(page.stderrFrom).toBe(stderrCursor);
          stdout += page.stdout;
          stderr += page.stderr;
          stdoutCursor = page.stdoutNext;
          stderrCursor = page.stderrNext;
          if (Buffer.byteLength(stdout) + Buffer.byteLength(stderr) > 1_048_576)
            throw Error(`Starter command ${commandID} exceeds its output bound`);
          if (["exited", "cancelled", "failed", "interrupted"].includes(page.state)) {
            completed = true;
            expect(page.state).toBe("exited");
            expect(page.exitCode).toBe(0);
            return {
              ...selected,
              state: page.state,
              exitCode: page.exitCode,
              stdout,
              stderr,
              elapsedMS: Math.round(performance.now() - started),
            };
          }
          await Bun.sleep(250);
        }
        throw Error(`Starter command ${commandID} did not complete within its observation bound`);
      } catch (failure) {
        // A lost admission response does not mean no dispatch. Cancel the same
        // deterministic ID even then; never replay runCommand or Stop compute.
        if (!completed) {
          try {
            const cancelled = await call("cancelCommand", { commandID }, command);
            expect(cancelled).toMatchObject(selected);
            const deadline = Date.now() + 30_000;
            let observed = cancelled;
            while (!["exited", "cancelled", "failed", "interrupted"].includes(observed.state)) {
              if (Date.now() >= deadline)
                throw Error(`Starter command ${commandID} cancellation remains unconfirmed`);
              observed = await call("getCommand", { commandID }, command);
              expect(observed).toMatchObject(selected);
              await Bun.sleep(250);
            }
          } catch (cause) {
            // No recorded handle can be cancelled. Keep the original failure
            // or unknown outcome; this is not evidence of successful execution.
            if (!(cause instanceof StarterNativeToolError && cause.code === "not-found"))
              throw new AggregateError(
                [failure, cause],
                `Starter command ${commandID} failed and exact-command cancellation is unconfirmed`,
              );
          }
        }
        throw failure;
      }
    },
  };
}

export async function connectStarterNativeLifecycle(base: string, cookie: string) {
  const grant = await ownedMCPAuthorization(base, cookie);
  const client = new Client({ name: "owned-starter-native-proof", version: "1.0.0" });
  try {
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${base}/api/mcp`), {
        authProvider: ownedMCPAuthProvider(grant),
      }),
    );
    return { ...starterNativeLifecycle(client), close: () => client.close() };
  } catch (cause) {
    await client.close();
    throw cause;
  }
}
