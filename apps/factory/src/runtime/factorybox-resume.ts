import { z } from "zod";

// A failed copy is not an attempted restore. The native operation lock makes
// this fresh observation exclusive with the original copy/restore caller.
export function unattemptedFactoryboxResume(
  value: unknown,
  sandboxID: string,
  snapshotID: string,
  start: unknown,
  pause: unknown,
) {
  const original = z
    .object({
      id: z.literal(sandboxID),
      owner: z.string().regex(/^[a-f0-9]{32}$/),
      inputSHA256: z.string().regex(/^[a-f0-9]{64}$/),
    })
    .parse(start);
  const saved = z
    .object({
      id: z.literal(original.id),
      owner: z.literal(original.owner),
      inputSHA256: z.literal(original.inputSHA256),
      phase: z.literal("paused"),
      snapshotID: z.literal(snapshotID),
      checkpointSHA256: z.string().regex(/^[a-f0-9]{64}$/),
    })
    .parse(pause);
  const source = z
    .object({
      record: z.object({
        version: z.literal(1),
        id: z.literal(original.id),
        owner: z.literal(original.owner),
        runtime_id: z.literal(`fbx-${original.owner}`),
        input_sha256: z.literal(original.inputSHA256),
        phase: z.enum(["paused", "resuming"]),
        pause: z.object({
          snapshot_id: z.literal(saved.snapshotID),
          checkpoint_sha256: z.literal(saved.checkpointSHA256),
          completed_at: z.iso.datetime({ offset: true }),
          resume: z
            .object({
              requested_at: z.iso.datetime({ offset: true }),
              attempted: z.literal(false),
              completed_at: z.undefined().optional(),
            })
            .optional(),
        }),
      }),
      runtime: z.object({ status: z.literal("stopped"), pid: z.literal(0) }),
    })
    .safeParse(value);
  if (!source.success) return false;
  return source.data.record.phase === "paused"
    ? source.data.record.pause.resume === undefined
    : source.data.record.pause.resume !== undefined;
}

// The native record of a Resume that was dispatched and positively failed before
// activation: attempted, an error recorded, no completion, and the original process
// stopped. Native Delete accepts exactly this proof. Anything else (a lost reply,
// a missing error, a running or unreadable runtime) is an unknown outcome and the
// caller must not treat it as failed. Returns the native error text.
export function confirmedFailedFactoryboxResume(
  value: unknown,
  sandboxID: string,
  snapshotID: string,
  start: unknown,
  pause: unknown,
) {
  const original = z
    .object({
      id: z.literal(sandboxID),
      owner: z.string().regex(/^[a-f0-9]{32}$/),
      inputSHA256: z.string().regex(/^[a-f0-9]{64}$/),
    })
    .safeParse(start);
  if (!original.success) return undefined;
  const saved = z
    .object({
      owner: z.literal(original.data.owner),
      snapshotID: z.literal(snapshotID),
      checkpointSHA256: z.string().regex(/^[a-f0-9]{64}$/),
    })
    .safeParse(pause);
  if (!saved.success) return undefined;
  const source = z
    .object({
      record: z.object({
        id: z.literal(sandboxID),
        owner: z.literal(original.data.owner),
        input_sha256: z.literal(original.data.inputSHA256),
        phase: z.literal("resuming"),
        pause: z.object({
          snapshot_id: z.literal(snapshotID),
          checkpoint_sha256: z.literal(saved.data.checkpointSHA256),
          resume: z.object({
            attempted: z.literal(true),
            error: z.string().trim().min(1),
            completed_at: z.undefined().optional(),
          }),
        }),
      }),
      runtime: z.object({ status: z.literal("stopped") }),
    })
    .safeParse(value);
  return source.success ? source.data.record.pause.resume.error : undefined;
}
