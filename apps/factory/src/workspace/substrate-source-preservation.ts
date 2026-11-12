import { createHash } from "node:crypto";
import { z } from "zod";
import { CommandError } from "../command-error";
import { objectDigest, type PrivateObjects } from "../storage/objects";

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const bundle = z
  .strictObject({
    version: z.literal(2),
    bytes: z
      .number()
      .int()
      .positive()
      .max(4 * 2 ** 30),
    sha256: digest,
    chunks: z.array(digest).min(1).max(4096),
  })
  .refine((value) => value.chunks.length === Math.ceil(value.bytes / (1 << 20)));

// Retention of the observed initial CLI metadata case only. This is not a normal
// Source generation, service materialization, writer grant or runtime lifecycle.
export const sourcePreservation = z.strictObject({
  version: z.literal(1),
  projectID: z.uuid(),
  workspaceID: z.uuid(),
  attemptID: z.uuid(),
  actorUID: z.uuid(),
  checkpointID: z.uuid(),
  writerEpoch: z.number().int().positive(),
  sourceGeneration: z.literal(0),
  manifestSHA256: digest,
  bundle,
});
export type SourcePreservation = z.infer<typeof sourcePreservation>;

export function sourcePreservationPrefix(
  saved: Pick<SourcePreservation, "workspaceID" | "checkpointID">,
) {
  return `workspace-source-recovery/v2/${saved.workspaceID}/${saved.checkpointID}/noatime`;
}

export async function readSourcePreservation(
  objects: PrivateObjects,
  scope: Omit<SourcePreservation, "bundle">,
): Promise<SourcePreservation> {
  const unavailable = () =>
    new CommandError(
      "unavailable",
      "Complete initial Source preservation is unconfirmed; original owner remains fenced",
    );
  try {
    const prefix = sourcePreservationPrefix(scope);
    const bytes = await objects.read(`${prefix}/recovery.json`);
    if (bytes.length > 1 << 20 || objectDigest(bytes) !== scope.manifestSHA256) throw unavailable();
    const producer = z
      .object({
        version: z.literal(1),
        kind: z.literal("retained-source-preservation"),
        projectID: z.uuid(),
        workspaceID: z.uuid(),
        attemptID: z.uuid(),
        actorUID: z.uuid(),
        checkpointID: z.uuid(),
        writerEpoch: z.number().int().positive(),
        sourceGeneration: z.literal(0),
        archiveObjectPrefix: z.literal(prefix),
        objectPrefix: z.literal(prefix),
        actorRecoveryArchive: z.literal(
          `/home/rootless/persist/connector/source-preservation-${scope.checkpointID}-noatime/source.tar`,
        ),
        predecessorSHA256: digest,
        toolSHA256: digest,
        originalLockfile: z.object({
          uid: z.literal(0),
          gid: z.literal(0),
          mode: z.literal(0o100644),
          ino: z.string().regex(/^\d+$/),
          size: z.string().regex(/^\d+$/),
          atime: z.string().regex(/^\d+$/),
          mtime: z.string().regex(/^\d+$/),
          ctime: z.string().regex(/^\d+$/),
        }),
        bundle,
      })
      .parse(JSON.parse(new TextDecoder().decode(bytes)));
    for (const key of [
      "projectID",
      "workspaceID",
      "attemptID",
      "actorUID",
      "checkpointID",
      "writerEpoch",
      "sourceGeneration",
    ] as const)
      if (producer[key] !== scope[key]) throw unavailable();
    const whole = createHash("sha256");
    for (let i = 0; i < producer.bundle.chunks.length; i++) {
      const chunk = await objects.read(`${prefix}/chunk-${i}`);
      if (
        chunk.length !== Math.min(1 << 20, producer.bundle.bytes - i * (1 << 20)) ||
        objectDigest(chunk) !== producer.bundle.chunks[i]
      )
        throw unavailable();
      whole.update(chunk);
    }
    if (whole.digest("hex") !== producer.bundle.sha256) throw unavailable();
    return sourcePreservation.parse({ ...scope, bundle: producer.bundle });
  } catch {
    throw unavailable();
  }
}
