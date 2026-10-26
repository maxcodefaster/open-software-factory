import { z } from "zod";

const token = z.string().regex(/^[a-f0-9]{32}$/);
const digest = z.string().regex(/^[a-f0-9]{64}$/);

export const factoryboxCheckpointRequest = z.strictObject({
  source_id: z.string().regex(/^[a-z][a-z0-9-]{0,62}$/),
  snapshot_id: token,
  source_owner: token,
  checkpoint_sha256: digest,
});
export type FactoryboxCheckpointRequest = z.infer<typeof factoryboxCheckpointRequest>;

// An unresumed Pause is the only copy of the stopped processes. A completed
// Resume has independent images; confirmed Delete no longer needs any of them.
export function factoryboxObsoleteCheckpoints(sandboxID: string, value: unknown) {
  const pause = z.object({
    snapshot_id: token,
    checkpoint_sha256: digest.optional(),
    completed_at: z.string().optional(),
    resume: z.object({ completed_at: z.string().optional() }).optional(),
  });
  const record = z
    .object({
      id: z.literal(sandboxID),
      owner: token,
      phase: z.enum(["running", "paused", "deleted"]),
      pause: pause.optional(),
      pause_history: z.array(pause).optional(),
    })
    .parse(value);
  const requests = new Map<string, FactoryboxCheckpointRequest>();
  for (const generation of [
    ...(record.pause_history ?? []),
    ...(record.pause ? [record.pause] : []),
  ]) {
    if (!generation.completed_at) continue;
    if (record.phase !== "deleted" && !generation.resume?.completed_at) continue;
    const request = factoryboxCheckpointRequest.parse({
      source_id: sandboxID,
      snapshot_id: generation.snapshot_id,
      source_owner: record.owner,
      checkpoint_sha256: generation.checkpoint_sha256,
    });
    const existing = requests.get(request.snapshot_id);
    if (existing && existing.checkpoint_sha256 !== request.checkpoint_sha256)
      throw new Error("Factorybox checkpoint history changed its immutable generation");
    requests.set(request.snapshot_id, request);
  }
  return [...requests.values()];
}

export function readFactoryboxCheckpointRetirement(
  request: FactoryboxCheckpointRequest,
  controllerRoot: string,
  value: unknown,
) {
  const capacity = z.object({
    root: z.literal(controllerRoot),
    filesystem_available_bytes: z.number().int().nonnegative().safe(),
  });
  return z
    .object({
      version: z.literal(1),
      request: z.object({
        source_id: z.literal(request.source_id),
        snapshot_id: z.literal(request.snapshot_id),
        source_owner: z.literal(request.source_owner),
        checkpoint_sha256: z.literal(request.checkpoint_sha256),
      }),
      intent_sha256: digest,
      completed_at: z.string().min(1),
      before: capacity,
      after: capacity,
    })
    .parse(value);
}
