import { z } from "zod";

// Concrete process boundary to the official generated gRPC client. Vendor
// protobuf types stay here, never in the Workspace/Attempt domain.
export const substrateConnection = z.strictObject({
  bridge: z.string().startsWith("/"),
  endpoint: z.string().min(1),
  serverName: z.literal("api.ate-system.svc"),
  caFile: z.string().startsWith("/"),
  tokenFile: z.string().startsWith("/"),
});
export type SubstrateConnection = z.infer<typeof substrateConnection>;
export class SubstrateRPCError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}
export type SubstrateCall = (method: string, request: unknown) => Promise<unknown>;

export function createSubstrateControl(configuration: SubstrateConnection): SubstrateCall {
  const { bridge, ...connection } = substrateConnection.parse(configuration);
  return async (method, request) => {
    const child = Bun.spawn([bridge], {
      stdin: new Blob([JSON.stringify({ ...connection, method, request })]),
      stdout: "pipe",
      stderr: "pipe",
      // Do not hand Forgejo, model or human credentials to the bridge.
      env: { PATH: process.env["PATH"] ?? "/usr/bin:/bin" },
      // Native lifecycle budgets include snapshot transfer and wakeup. Do not
      // kill their one-RPC bridge before Substrate finishes finalization.
      timeout: method === "SuspendActor" || method === "ResumeActor" ? 0 : 185_000,
    });
    const [stdout, stderr, exit] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    if (exit !== 0 || stdout.length > 2 << 20)
      throw new Error(`Native control response unavailable (${exit}): ${stderr.slice(0, 300)}`);
    const value: unknown = JSON.parse(stdout);
    const failure = z
      .object({ error: z.object({ code: z.string(), message: z.string() }) })
      .safeParse(value);
    if (failure.success)
      throw new SubstrateRPCError(failure.data.error.code, failure.data.error.message);
    return value;
  };
}

export const nativeMetadata = z.object({
  name: z.string(),
  atespace: z.string().optional(),
  uid: z.uuid(),
  version: z.string().regex(/^[1-9][0-9]*$/),
  createTime: z.iso.datetime(),
});
export const nativeRuntime = z.object({
  sandboxClass: z.literal("gvisor"),
  version: z.object({
    schemaVersion: z.literal("v1"),
    attributes: z.array(z.object({ key: z.string(), value: z.string() })).min(1),
  }),
});
export const nativeSnapshot = z.object({
  uuid: z.uuid(),
  generation: z.number().int().positive(),
  owner: z.literal("SNAPSHOT_OWNER_ACTOR"),
  fidelity: z.literal("SNAPSHOT_FIDELITY_ROOTFS"),
  actorTemplateUid: z.uuid(),
  sandboxRuntime: nativeRuntime,
  durableSnapshot: z.object({
    state: z.literal("SNAPSHOT_STORAGE_STATE_COMPLETED"),
    object: z.object({ snapshotUri: z.string().min(1) }),
  }),
});
export const nativeActor = z.object({
  metadata: nativeMetadata,
  actorTemplate: z.object({ atespace: z.string(), name: z.string() }),
  workerSelector: z.object({ matchLabels: z.record(z.string(), z.string()) }).optional(),
  sourceTag: z.unknown().optional(),
  status: z.object({
    state: z.string(),
    crash: z
      .object({ message: z.string().max(4096), crashTime: z.iso.datetime().optional() })
      .optional(),
    lastAssignedGeneration: z.number().int().nonnegative().optional(),
    snapshots: z.array(z.unknown()).optional(),
    workerAssignment: z.object({ sandboxRuntime: nativeRuntime }).passthrough().optional(),
  }),
});
export type NativeActor = z.infer<typeof nativeActor>;
