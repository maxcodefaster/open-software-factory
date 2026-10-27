import { expect, test } from "bun:test";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createAttachmentStore } from "../../apps/factory/src/attachments/store";
import { createReviewMedia } from "../../apps/factory/src/review/media";
import { requireObjectStorage } from "../../apps/factory/src/storage/bootstrap";
import { objectDigest } from "../../apps/factory/src/storage/objects";
import { candidateReviewFixture } from "../fixtures/candidate-review";
import { memoryPrivateObjects } from "../fixtures/private-objects";
import { fixtureValue } from "../fixtures/value";

test("startup refuses an empty replacement store and verifies an explicit transfer without rewriting file identities", async () => {
  const f = await candidateReviewFixture();
  const directory = resolve(
    ".factory/test-results/object-storage-controllers",
    crypto.randomUUID(),
  );
  const original = memoryPrivateObjects();
  const replacement = memoryPrivateObjects();
  const attachments = createAttachmentStore(f.database, original, async () => ({
    text: "",
    previews: [],
  }));
  const media = createReviewMedia(f.database, original);
  try {
    const data = new TextEncoder().encode("Retained original content.");
    const id = crypto.randomUUID();
    await attachments.begin(f.userID, {
      id,
      projectId: f.projectID,
      name: "original.txt",
      mediaType: "text/plain",
      bytes: data.length,
      sha256: objectDigest(data),
    });
    await attachments.upload(f.userID, id, data);
    const recordingID = crypto.randomUUID();
    await f.database
      .client`INSERT INTO factory.review_media(id,change_id,review_id,kind,commit_sha,state)
      VALUES(${recordingID},${f.changeID},${f.reviewID},'recording',${f.commit},'intended')`;
    await media.publish(recordingID, data, 500);
    const before = await attachments.metadata(f.userID, id);
    await expect(requireObjectStorage(f.database, directory, replacement)).rejects.toThrow(
      "Retained files are missing or changed",
    );
    expect(replacement.blobs.size).toBe(0);
    for (const [key, bytes] of original.blobs) await replacement.put(key, bytes, "text/plain");
    const videoKey = fixtureValue(
      [...replacement.blobs.keys()].find((key) => key.endsWith(`/${recordingID}`)),
      `[...replacement.blobs.keys()].find((key) => key.endsWith(\`/\${recordingID}\`))`,
    );
    // Same-size corruption must not initialize a replacement store either.
    replacement.blobs.set(videoKey, new Uint8Array(data.length));
    await expect(requireObjectStorage(f.database, directory, replacement)).rejects.toThrow(
      "Retained files are missing or changed",
    );
    replacement.blobs.set(videoKey, data);
    await requireObjectStorage(f.database, directory, replacement);
    const count = replacement.blobs.size;
    await requireObjectStorage(f.database, directory, replacement);
    expect(replacement.blobs.size).toBe(count);
    expect(await attachments.metadata(f.userID, id)).toEqual(before);
    expect(await createReviewMedia(f.database, replacement).bytes(recordingID)).toEqual(data);
  } finally {
    await f.dispose();
  }
});

test("legacy QA files block startup without changing retained bytes or writing storage", async () => {
  const f = await candidateReviewFixture();
  const directory = resolve(
    ".factory/test-results/object-storage-controllers",
    crypto.randomUUID(),
  );
  const legacy = resolve(directory, "review-media", crypto.randomUUID());
  const objects = memoryPrivateObjects();
  try {
    await mkdir(resolve(directory, "review-media"), { recursive: true });
    await writeFile(legacy, "Retained local QA content");
    await expect(requireObjectStorage(f.database, directory, objects)).rejects.toThrow(
      "Retained QA media still uses the old state volume",
    );
    expect(await readFile(legacy, "utf8")).toBe("Retained local QA content");
    expect(objects.blobs.size).toBe(0);
  } finally {
    await rm(directory, { recursive: true, force: true });
    await f.dispose();
  }
});

test("review streaming rechecks access after object I/O and cancels a revoked response", async () => {
  const f = await candidateReviewFixture();
  const objects = memoryPrivateObjects();
  const media = createReviewMedia(f.database, objects);
  try {
    const id = crypto.randomUUID();
    await f.database
      .client`INSERT INTO factory.review_media(id,change_id,review_id,kind,commit_sha,state)
      VALUES(${id},${f.changeID},${f.reviewID},'recording',${f.commit},'intended')`;
    await media.publish(id, new Uint8Array([1, 2, 3]), 1000);
    let cancelled = false;
    objects.open = async () => {
      await f.database.client`DELETE FROM factory.project_membership
        WHERE project_id=${f.projectID} AND user_id=${f.userID}`;
      return new Response(
        new ReadableStream({
          cancel() {
            cancelled = true;
          },
        }),
        { headers: { "content-length": "3" } },
      );
    };
    await expect(media.read(f.changeID, f.userID, id, null)).rejects.toThrow();
    expect(cancelled).toBe(true);
  } finally {
    await f.dispose();
  }
});

test("a recording claims its content before external writes and rejects a different staged retry", async () => {
  const f = await candidateReviewFixture();
  const objects = memoryPrivateObjects();
  const media = createReviewMedia(f.database, objects);
  const writing = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const original = objects.put;
  objects.put = async (...args) => {
    writing.resolve();
    await release.promise;
    await original(...args);
  };
  let first: Promise<unknown> | undefined;
  try {
    const id = crypto.randomUUID();
    await f.database
      .client`INSERT INTO factory.review_media(id,change_id,review_id,kind,commit_sha,state)
      VALUES(${id},${f.changeID},${f.reviewID},'recording',${f.commit},'intended')`;
    first = media.stage(id, new Uint8Array([1, 2, 3]));
    await writing.promise;
    await expect(media.stage(id, new Uint8Array([3, 2, 1]))).rejects.toThrow("original content");
    release.resolve();
    await first;
  } finally {
    release.resolve();
    await first?.catch(() => {});
    await f.dispose();
  }
});
