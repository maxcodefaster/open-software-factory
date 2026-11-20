import { expect, test } from "bun:test";
import { createReviewMedia } from "../../apps/factory/src/review/media";
import { candidateReviewFixture } from "../fixtures/candidate-review";
import { observe } from "../fixtures/pinned-opencode";
import { memoryPrivateObjects } from "../fixtures/private-objects";

test("media completion uses the caller's savepoint and keeps completed content and duration immutable", async () => {
  const f = await candidateReviewFixture();
  const objects = memoryPrivateObjects();
  const media = createReviewMedia(f.database, objects);
  const id = crypto.randomUUID();
  const data = new Uint8Array([0x1a, 0x45, 0xdf, 0xa3]);
  try {
    await f.database.client`INSERT INTO factory.review_media(
      id,change_id,review_id,kind,commit_sha,state)
      VALUES(${id},${f.changeID},${f.reviewID},'recording',${f.commit},'intended')`;
    const proof = await media.stage(id, data);
    await f.database.client.begin(async (sql) => {
      await expect(
        sql.savepoint(async (nested) => {
          await media.complete(proof, 1000, nested, "Unchanged frames shortened.");
          const [saved] = await nested<{ state: string }[]>`
            SELECT state FROM factory.review_media WHERE id=${id}`;
          expect(saved?.state).toBe("complete");
          throw new Error("Owned completion rollback");
        }),
      ).rejects.toThrow("Owned completion rollback");
      const [rolledBack] = await sql<{ state: string }[]>`
        SELECT state FROM factory.review_media WHERE id=${id}`;
      expect(rolledBack?.state).toBe("intended");
      await media.complete(proof, 1500, sql, "Unchanged frames shortened.");
    });
    await media.publish(id, data, 9000);
    await expect(media.publish(id, new Uint8Array([4, 3, 2, 1]))).rejects.toThrow(
      "original content",
    );
    const [saved] = await f.database.client<
      { commit: string; duration: number; reason: string }[]
    >`SELECT commit_sha AS commit,duration_ms AS duration,reason
      FROM factory.review_media WHERE id=${id}`;
    expect(saved).toEqual({
      commit: f.commit,
      duration: 1500,
      reason: "Unchanged frames shortened.",
    });
    expect(await media.bytes(id)).toEqual(data);
    expect(objects.blobs.size).toBe(1);
    const [storage] = await f.database.client<{ id: string }[]>`
      SELECT id FROM factory.attachment_storage WHERE singleton`;
    expect([...objects.blobs.keys()]).toEqual([`factory-review/${storage?.id}/${id}`]);
  } finally {
    await f.dispose();
  }
});

test("interrupted publication cleanup retries failed deletion of a late object without touching another installation", async () => {
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
  let staged: ReturnType<typeof media.stage> | undefined;
  try {
    const id = crypto.randomUUID();
    const unownedKey = `factory-review/${crypto.randomUUID()}/${id}`;
    const unownedData = new Uint8Array([4, 5, 6]);
    objects.blobs.set(unownedKey, unownedData);
    await f.database.client`INSERT INTO factory.review_media(
      id,change_id,review_id,kind,commit_sha,state)
      VALUES(${id},${f.changeID},${f.reviewID},'recording',${f.commit},'intended')`;
    staged = media.stage(id, new Uint8Array([1, 2, 3]));
    await writing.promise;
    await media.sweep();
    const [interrupted] = await f.database.client<{ state: string; reason: string }[]>`
      SELECT state,reason FROM factory.review_media WHERE id=${id}`;
    expect(interrupted).toEqual({
      state: "unavailable",
      reason: "Recording interrupted. Review results are separate.",
    });
    release.resolve();
    const proof = await staged;
    expect(objects.blobs.size).toBe(2);
    await expect(
      f.database.client.begin((sql) => media.complete(proof, 1000, sql)),
    ).rejects.toThrow("no longer current");
    expect((await media.read(f.changeID, f.userID, id, null)).status).toBe(404);
    const remove = objects.remove;
    let failDeletion = true;
    objects.remove = async (key) => {
      expect(key).not.toBe(unownedKey);
      if (failDeletion) {
        failDeletion = false;
        throw new Error("Owned cleanup deletion failed");
      }
      await remove(key);
    };
    await expect(media.sweep()).rejects.toThrow("Owned cleanup deletion failed");
    expect(objects.blobs.size).toBe(2);
    await media.sweep();
    await media.sweep();
    expect(objects.blobs.size).toBe(1);
    expect(objects.blobs.get(unownedKey)).toEqual(unownedData);
    expect(
      await f.database.client`SELECT id FROM factory.review_media
        WHERE id=${id} AND state='unavailable' AND sha256=${proof.sha}`,
    ).toHaveLength(1);
  } finally {
    release.resolve();
    await staged?.catch(() => {});
    await f.dispose();
  }
});

test("concurrent still retries retain the original author, Runtime Attempt basis and source context", async () => {
  const f = await candidateReviewFixture();
  const media = createReviewMedia(f.database, memoryPrivateObjects());
  const jpeg = new Uint8Array(32);
  jpeg.set([0xff, 0xd8, 0xff, 0xc0, 0, 17, 8, 0, 1, 0, 1]);
  const id = crypto.randomUUID();
  const context = {
    source: "preview",
    attemptId: f.attemptID,
    representation: "dom-reconstruction",
  };
  try {
    const [first, retry] = await Promise.all([
      media.still(f.changeID, f.userID, context, jpeg, id),
      media.still(f.changeID, f.userID, context, jpeg, id),
    ]);
    expect(retry).toEqual(first);
    const [saved] = await f.database.client<
      { author: string; commit: string; attempt: string; context: unknown }[]
    >`SELECT created_by AS author,commit_sha AS commit,runtime_attempt_id AS attempt,source_context AS context
      FROM factory.review_media WHERE id=${id}`;
    expect(saved).toEqual({
      author: f.userID,
      commit: "a".repeat(40),
      attempt: f.attemptID,
      context: {
        ...context,
        checkoutState: "unverified",
        commitMeaning: "runtime-attempt-basis-not-a-clean-checkout-proof",
      },
    });
    await expect(
      media.still(f.changeID, f.userID, { ...context, representation: undefined }, jpeg, id),
    ).rejects.toThrow("identity changed input");
    await expect(
      media.still(f.changeID, f.userID, { ...context, attemptId: crypto.randomUUID() }, jpeg, id),
    ).rejects.toThrow("identity changed input");
    expect(await media.bytes(id)).toEqual(jpeg);
  } finally {
    await f.dispose();
  }
});

test("still retention rechecks feedback after a contended Change lock and preserves attached objects", async () => {
  const f = await candidateReviewFixture();
  const objects = memoryPrivateObjects();
  const media = createReviewMedia(f.database, objects);
  const id = crypto.randomUUID();
  const unused = crypto.randomUUID();
  const entered = Promise.withResolvers<number>();
  const release = Promise.withResolvers<void>();
  let attaching: Promise<unknown> | undefined;
  let sweeping: Promise<void> | undefined;
  try {
    for (const item of [id, unused]) {
      await f.database.client`INSERT INTO factory.review_media(
        id,change_id,created_by,kind,commit_sha,state,created_at)
        VALUES(${item},${f.changeID},${f.userID},'still',${f.commit},'intended',now()-interval '2 days')`;
      await media.publish(item, new Uint8Array([1, 2, 3]));
    }
    attaching = f.database.client.begin(async (sql) => {
      await sql`SELECT id FROM factory.change WHERE id=${f.changeID} FOR UPDATE`;
      const [session] = await sql<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
      if (!session) throw new Error("Missing owned attachment transaction");
      entered.resolve(session.pid);
      await release.promise;
      await sql`INSERT INTO factory.review_feedback(
        id,change_id,author_id,kind,commit_sha,annotation,media_id)
        VALUES(${crypto.randomUUID()},${f.changeID},${f.userID},'comment',${f.commit},'{}',${id})`;
    });
    const owner = await entered.promise;
    sweeping = media.sweep();
    await observe(
      async () => {
        const [waiting] = await f.database.client<{ waiting: boolean }[]>`
          SELECT EXISTS(SELECT 1 FROM pg_stat_activity
            WHERE datname=current_database() AND ${owner}=ANY(pg_blocking_pids(pid))) AS waiting`;
        return waiting?.waiting;
      },
      Boolean,
      "Media retention did not contend on the Change lock",
    );
    release.resolve();
    await Promise.all([attaching, sweeping]);
    expect(await media.bytes(id)).toEqual(new Uint8Array([1, 2, 3]));
    expect((await media.read(f.changeID, f.userID, unused, null)).status).toBe(404);
    await media.sweep();
    expect(objects.blobs.size).toBe(1);
    expect([...objects.blobs.keys()][0]?.endsWith(`/${id}`)).toBe(true);
    const [saved] = await f.database.client<{ state: string }[]>`
      SELECT state FROM factory.review_media WHERE id=${unused}`;
    expect(saved?.state).toBe("deleted");
    await expect(media.publish(unused, new Uint8Array([1, 2, 3]))).rejects.toThrow(
      "no longer current",
    );
  } finally {
    release.resolve();
    await Promise.allSettled([attaching, sweeping]);
    await f.dispose();
  }
});
