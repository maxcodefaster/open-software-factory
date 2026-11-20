import { createHash } from "node:crypto";
import { readdir } from "node:fs/promises";
import { resolve } from "node:path";
import type { createDatabase } from "../../../../packages/db/src/client";
import { sourceCheckpointObjects } from "../workspace/substrate-source";
import { createPrivateObjects, objectDigest, type PrivateObjects } from "./objects";

export async function requireObjectStorage(
  database: ReturnType<typeof createDatabase>,
  stateDirectory: string,
  objects: PrivateObjects = createPrivateObjects(),
) {
  const legacy = await readdir(resolve(stateDirectory, "review-media")).catch(
    (cause: NodeJS.ErrnoException) => {
      if (cause.code === "ENOENT") return [];
      throw cause;
    },
  );
  if (legacy.length)
    throw new Error(
      "Retained QA media still uses the old state volume. Transfer it explicitly before switching file storage; retained files were not changed.",
    );
  const [storage] = await database.client<{ id: string }[]>`
    SELECT id FROM factory.attachment_storage WHERE singleton`;
  if (!storage) throw new Error("Installation storage identity is unavailable");
  const bytes = new TextEncoder().encode(`Factory private storage ${storage.id}\n`);
  const key = `factory-storage/${storage.id}/identity`;
  const deadline = Date.now() + 180_000;
  let present = false;
  for (;;) {
    try {
      const response = await objects.open(key);
      present = response.status !== 404;
      await response.body?.cancel();
      break;
    } catch (cause) {
      if (Date.now() >= deadline) throw cause;
      await Bun.sleep(500);
    }
  }
  if (!present) {
    // A replacement empty store must not become healthy against retained file
    // references. An explicit transfer must bring every published object first.
    const attachments = await database.client<
      { objects: Array<{ key: string; sha256: string; bytes: number }> }[]
    >`SELECT objects FROM factory.attachment WHERE state='ready'`;
    const media = await database.client<{ id: string; sha256: string; bytes: number }[]>`
      SELECT id,sha256,byte_length AS bytes FROM factory.review_media WHERE state='complete'`;
    const sources = await database.client<{ checkpoint: unknown }[]>`
      SELECT checkpoint FROM factory.substrate_source WHERE checkpoint IS NOT NULL`;
    const retained = [
      ...attachments.flatMap((attachment) => attachment.objects),
      ...media.map((item) => ({
        ...item,
        key: `factory-review/${storage.id}/${item.id}`,
      })),
    ];
    async function checkedObject(item: { key: string; sha256: string; bytes: number }) {
      const data = await objects.read(item.key);
      if (data.byteLength !== item.bytes || objectDigest(data) !== item.sha256)
        throw new Error("Retained file content differs");
      return data;
    }
    try {
      for (const item of retained) await checkedObject(item);
      for (const row of sources) {
        const source = sourceCheckpointObjects(row.checkpoint);
        await checkedObject(source.manifest);
        const whole = createHash("sha256");
        for (const chunk of source.chunks) whole.update(await checkedObject(chunk));
        if (whole.digest("hex") !== source.sha256)
          throw new Error("Retained Source bundle content differs");
      }
    } catch {
      throw new Error(
        "Retained files are missing or changed in this object store. Complete and verify their explicit transfer before startup; retained references were not changed.",
      );
    }
  }
  // A small permanent identity probe has deterministic content. Startup
  // reconciles the same object, never creates a bucket or replaces credentials.
  await objects.put(key, bytes, "text/plain");
}
