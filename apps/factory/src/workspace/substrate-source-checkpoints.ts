import { z } from "zod";
import { CommandError } from "../command-error";
import { objectDigest, type PrivateObjects } from "../storage/objects";

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
    treeSHA256: digest.optional(),
    chunks: z.array(digest).min(1).max(4096),
  })
  .refine((b) => b.chunks.length === Math.ceil(b.bytes / (1 << 20)));

export const sourceCheckpoint = z
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

export type SourceCheckpoint = z.infer<typeof sourceCheckpoint>;

export function objectKey(saved: SourceCheckpoint, suffix: string) {
  return `workspace-source/v1/${saved.workspaceID}/${saved.id}/${suffix}`;
}

export function checkpointChunk(saved: SourceCheckpoint, index: number) {
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

export function checkpointManifest(saved: SourceCheckpoint) {
  const bytes = new TextEncoder().encode(JSON.stringify(saved));
  return {
    key: objectKey(saved, "manifest.json"),
    bytes: bytes.byteLength,
    sha256: objectDigest(bytes),
  };
}

export function sourceCheckpointObjects(value: unknown) {
  const saved = sourceCheckpoint.parse(value);
  return {
    manifest: checkpointManifest(saved),
    chunks: saved.bundle.chunks.map((_, index) => checkpointChunk(saved, index)),
    sha256: saved.bundle.sha256,
  };
}

export function checkedBundle(data: Uint8Array, saved: SourceCheckpoint, index: number) {
  const item = checkpointChunk(saved, index);
  if (data.byteLength !== item.bytes || objectDigest(data) !== item.sha256)
    throw new CommandError(
      "unavailable",
      "Confirmed Source chunk is missing or corrupt. Old data was retained.",
    );
  return data;
}

export async function verifiedManifest(objects: PrivateObjects, saved: SourceCheckpoint) {
  const item = checkpointManifest(saved);
  const bytes = await objects.read(item.key);
  if (bytes.byteLength !== item.bytes || objectDigest(bytes) !== item.sha256)
    throw new CommandError(
      "unavailable",
      "Confirmed Source manifest is missing or corrupt; old data retained",
    );
}
