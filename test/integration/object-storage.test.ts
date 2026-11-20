import { expect, test } from "bun:test";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createAttachmentStore } from "../../apps/factory/src/attachments/store";
import { createReviewMedia } from "../../apps/factory/src/review/media";
import { requireObjectStorage } from "../../apps/factory/src/storage/bootstrap";
import { objectDigest } from "../../apps/factory/src/storage/objects";
import {
  createSubstrateSources,
  sourceCheckpointObjects,
} from "../../apps/factory/src/workspace/substrate-source";
import { candidateReviewFixture } from "../fixtures/candidate-review";
import { memoryPrivateObjects } from "../fixtures/private-objects";
import { substrateFixture } from "../fixtures/substrate";
import { fixtureValue } from "../fixtures/value";

test("Source checkpoint object descriptions enforce the existing checkpoint and bundle schema", () => {
  const bytes = new Uint8Array([1, 2, 3]);
  const saved = {
    id: crypto.randomUUID(),
    workspaceID: crypto.randomUUID(),
    actorUID: crypto.randomUUID(),
    writerEpoch: 2,
    generation: 1,
    bundle: {
      version: 1,
      bytes: bytes.length,
      sha256: objectDigest(bytes),
      chunks: [objectDigest(bytes)],
    },
  };
  for (const value of [
    { ...saved, id: "../unowned" },
    { ...saved, writerEpoch: 0 },
    { ...saved, generation: 0 },
    { ...saved, extra: true },
    { ...saved, bundle: { ...saved.bundle, version: 2 } },
    { ...saved, bundle: { ...saved.bundle, bytes: 0 } },
    { ...saved, bundle: { ...saved.bundle, bytes: 4 * 2 ** 30 + 1 } },
    { ...saved, bundle: { ...saved.bundle, bytes: (1 << 20) + 1 } },
    { ...saved, bundle: { ...saved.bundle, sha256: "invalid" } },
    { ...saved, bundle: { ...saved.bundle, chunks: [] } },
    { ...saved, bundle: { ...saved.bundle, chunks: ["invalid"] } },
  ])
    expect(() => sourceCheckpointObjects(value)).toThrow();
});

test("Source-only retained checkpoints require every matching chunk and manifest before writing storage identity", async () => {
  const f = await substrateFixture();
  const directory = resolve(
    ".factory/test-results/object-storage-controllers",
    crypto.randomUUID(),
  );
  const original = memoryPrivateObjects();
  const replacement = memoryPrivateObjects();
  const source = createSubstrateSources(f.database, f.hub, original);
  const actorUID = crypto.randomUUID();
  const bytes = new Uint8Array((1 << 20) + 37).fill(7);
  const chunks = [bytes.slice(0, 1 << 20), bytes.slice(1 << 20)];
  f.hub.parentOperation = async () => ({});
  f.hub.request = async (_attempt, channel, request, path) => {
    expect(channel).toBe("source");
    const input = await request.json();
    return path.endsWith("/checkpoint")
      ? Response.json({
          version: 1,
          bytes: bytes.length,
          sha256: objectDigest(bytes),
          chunks: chunks.map(objectDigest),
        })
      : new Response(fixtureValue(chunks[input.chunk], "Source export chunk"));
  };
  try {
    await f.database.client.begin(async (sql) => {
      await sql`INSERT INTO factory.runtime_attempt(id,project_id,workspace_id,generation,revision,state,parent_connector_token_hash,child_connector_token_hash,create_intended_at,created_by)
        VALUES(${f.attemptID},${f.projectID},${f.workspaceID},1,${"a".repeat(40)},'create-intended',${"b".repeat(64)},${"c".repeat(64)},now(),${f.userID})`;
      await sql`INSERT INTO factory.substrate_binding(runtime_attempt_id,atespace,actor_name,intent,actor_uid,create_attempted_at)
        VALUES(${f.attemptID},${f.atespace},${`runtime-${f.attemptID.replaceAll("-", "")}`},'{}',${actorUID},now())`;
    });
    await source.attach(f.workspaceID, actorUID, f.database.client);
    await source.freezeActor(f.workspaceID, f.attemptID, f.database.client);
    const before = await source.lease(f.workspaceID);
    expect(before).toMatchObject({
      actorUID,
      owner: "actor",
      writerEpoch: 2,
      writable: false,
      generation: 1,
    });
    expect(original.blobs.size).toBe(3);
    expect(
      await f.database.client`SELECT id FROM factory.attachment WHERE state='ready'`,
    ).toHaveLength(0);
    expect(
      await f.database.client`SELECT id FROM factory.review_media WHERE state='complete'`,
    ).toHaveLength(0);
    const storage = fixtureValue(
      (
        await f.database.client<
          { id: string }[]
        >`SELECT id FROM factory.attachment_storage WHERE singleton`
      )[0],
      "Installation storage identity",
    );
    const identityKey = `factory-storage/${storage.id}/identity`;
    const identityBytes = new TextEncoder().encode(`Factory private storage ${storage.id}\n`);
    const installationBefore = [
      ...(await f.database.client`SELECT * FROM factory.attachment_storage`),
    ];
    const descriptions = sourceCheckpointObjects(before?.checkpoint);
    expect(descriptions.chunks.map((chunk) => chunk.bytes)).toEqual([1 << 20, 37]);
    async function refused() {
      const retainedBefore = new Map(replacement.blobs);
      await expect(requireObjectStorage(f.database, directory, replacement)).rejects.toThrow(
        "Retained files are missing or changed",
      );
      expect(replacement.blobs).toEqual(retainedBefore);
      expect(replacement.blobs.has(identityKey)).toBe(false);
      expect(await source.lease(f.workspaceID)).toEqual(before);
      expect([...(await f.database.client`SELECT * FROM factory.attachment_storage`)]).toEqual(
        installationBefore,
      );
    }
    function transfer() {
      replacement.blobs.clear();
      for (const [key, data] of original.blobs) replacement.blobs.set(key, data.slice());
    }
    await refused();
    for (const [key] of original.blobs) {
      transfer();
      replacement.blobs.delete(key);
      await refused();
    }
    for (const chunk of descriptions.chunks) {
      transfer();
      replacement.blobs.set(chunk.key, new Uint8Array(chunk.bytes));
      await refused();
      transfer();
      replacement.blobs.set(chunk.key, new Uint8Array(chunk.bytes - 1));
      await refused();
    }
    transfer();
    const manifest = fixtureValue(
      replacement.blobs.get(descriptions.manifest.key),
      "Source manifest",
    );
    // A syntactically valid, same-length manifest with a different Actor is not this checkpoint.
    const changed = JSON.parse(new TextDecoder().decode(manifest));
    changed.actorUID = crypto.randomUUID();
    replacement.blobs.set(
      descriptions.manifest.key,
      new TextEncoder().encode(JSON.stringify(changed)),
    );
    expect(replacement.blobs.get(descriptions.manifest.key)?.byteLength).toBe(manifest.byteLength);
    await refused();
    transfer();
    replacement.blobs.set(descriptions.manifest.key, manifest.slice(1));
    await refused();
    transfer();
    await requireObjectStorage(f.database, directory, replacement);
    expect(replacement.blobs.get(identityKey)).toEqual(identityBytes);
    expect(replacement.blobs.size).toBe(original.blobs.size + 1);
    await requireObjectStorage(f.database, directory, replacement);
    expect(replacement.blobs.size).toBe(original.blobs.size + 1);
    for (const [key, data] of original.blobs) expect(replacement.blobs.get(key)).toEqual(data);
    expect(await source.lease(f.workspaceID)).toEqual(before);
    expect([...(await f.database.client`SELECT * FROM factory.attachment_storage`)]).toEqual(
      installationBefore,
    );
  } finally {
    await source.close();
    await f.dispose();
  }
});

test("Source-only startup rejects a full bundle checksum mismatch even when every object matches its descriptor", async () => {
  const f = await substrateFixture();
  const objects = memoryPrivateObjects();
  const source = createSubstrateSources(f.database, f.hub, objects);
  const directory = resolve(
    ".factory/test-results/object-storage-controllers",
    crypto.randomUUID(),
  );
  const actorUID = crypto.randomUUID();
  const bytes = new Uint8Array((1 << 20) + 11).fill(9);
  const saved = {
    id: crypto.randomUUID(),
    workspaceID: f.workspaceID,
    actorUID,
    writerEpoch: 2,
    generation: 1,
    bundle: {
      version: 1,
      bytes: bytes.byteLength,
      sha256: objectDigest(new Uint8Array(bytes.length)),
      chunks: [objectDigest(bytes.slice(0, 1 << 20)), objectDigest(bytes.slice(1 << 20))],
    },
  };
  try {
    await f.database.client.begin(async (sql) => {
      await sql`INSERT INTO factory.runtime_attempt(id,project_id,workspace_id,generation,revision,state,parent_connector_token_hash,child_connector_token_hash,create_intended_at,created_by)
        VALUES(${f.attemptID},${f.projectID},${f.workspaceID},1,${"a".repeat(40)},'create-intended',${"b".repeat(64)},${"c".repeat(64)},now(),${f.userID})`;
      await sql`INSERT INTO factory.substrate_binding(runtime_attempt_id,atespace,actor_name,intent,actor_uid,create_attempted_at)
        VALUES(${f.attemptID},${f.atespace},${`runtime-${f.attemptID.replaceAll("-", "")}`},'{}',${actorUID},now())`;
      await source.attach(f.workspaceID, actorUID, sql);
      await sql`UPDATE factory.substrate_source SET writable=false,writer_epoch=2,checkpoint_id=${saved.id} WHERE workspace_id=${f.workspaceID}`;
      await sql`UPDATE factory.substrate_source SET generation=1,checkpoint=${JSON.stringify(saved)}::text::jsonb WHERE workspace_id=${f.workspaceID}`;
    });
    const descriptions = sourceCheckpointObjects(saved);
    await objects.put(
      descriptions.manifest.key,
      new TextEncoder().encode(JSON.stringify(saved)),
      "application/json",
    );
    for (const [index, chunk] of descriptions.chunks.entries()) {
      const data = bytes.slice(index * (1 << 20), index * (1 << 20) + chunk.bytes);
      expect(objectDigest(data)).toBe(chunk.sha256);
      await objects.put(chunk.key, data, "application/octet-stream");
    }
    const before = await source.lease(f.workspaceID);
    const retainedBefore = new Map(objects.blobs);
    await expect(requireObjectStorage(f.database, directory, objects)).rejects.toThrow(
      "Retained files are missing or changed",
    );
    expect(objects.blobs).toEqual(retainedBefore);
    expect(await source.lease(f.workspaceID)).toEqual(before);
  } finally {
    await source.close();
    await f.dispose();
  }
});

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
