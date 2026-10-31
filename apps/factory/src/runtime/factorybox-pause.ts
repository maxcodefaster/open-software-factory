import { z } from "zod";

// A failed CLI call is not a rollback receipt. Only a fresh state observation,
// bound to the completed original Start and exact rejected snapshot, can prove
// the original process is running again.
export function rejectedFactoryboxPause(
  value: unknown,
  sandboxID: string,
  snapshotID: string,
  start: unknown,
) {
  const original = z
    .object({
      id: z.literal(sandboxID),
      owner: z.string().regex(/^[a-f0-9]{32}$/),
      inputSHA256: z.string().regex(/^[a-f0-9]{64}$/),
    })
    .parse(start);
  const source = z
    .object({
      record: z.object({
        version: z.literal(1),
        id: z.literal(original.id),
        owner: z.literal(original.owner),
        runtime_id: z.literal(`fbx-${original.owner}`),
        input_sha256: z.literal(original.inputSHA256),
        phase: z.string(),
        pause: z.unknown().optional(),
        pause_history: z.array(z.unknown()).optional(),
      }),
      runtime: z
        .object({
          status: z.string(),
          pid: z.number().int().nonnegative(),
        })
        .optional(),
    })
    .parse(value);
  if (
    source.record.phase !== "running" ||
    source.record.pause != null ||
    source.runtime?.status !== "running"
  )
    return undefined;
  const matches = (source.record.pause_history ?? []).filter(
    (entry) => z.object({ snapshot_id: z.literal(snapshotID) }).safeParse(entry).success,
  );
  if (matches.length !== 1) return undefined;
  const rejection = z
    .object({
      snapshot_id: z.literal(snapshotID),
      source_pid: z.number().int().min(2),
      rejected_at: z.iso.datetime({ offset: true }),
      error: z.string().min(1).max(4096),
      completed_at: z.undefined().optional(),
      checkpoint_sha256: z.undefined().optional(),
      resume: z.undefined().optional(),
    })
    .safeParse(matches[0]);
  if (!rejection.success || rejection.data.source_pid !== source.runtime.pid) return undefined;
  return {
    version: 1,
    id: original.id,
    owner: original.owner,
    inputSHA256: original.inputSHA256,
    phase: "running" as const,
    snapshotID,
    rejected: true as const,
    sourcePID: rejection.data.source_pid,
    rejectedAt: rejection.data.rejected_at,
    reason: rejection.data.error,
  };
}
