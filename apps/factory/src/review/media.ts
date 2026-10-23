import { createHash } from "node:crypto";
import { mkdir, open, readFile, readdir, rename, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { z } from "zod";
import type { createDatabase } from "../../../../packages/db/src/client";
import { CommandError } from "../command-error";
import { reviewChangeIn } from "./controller";
import type { AgentTurnTransaction } from "../agent/turn-store";

export const maximumRecordingBytes = 96 * 1024 * 1024;
export const stillContextInput = z.discriminatedUnion("source", [
  z.strictObject({
    source: z.literal("recording"),
    recordingId: z.uuid(),
    timestampMs: z.number().int().nonnegative(),
  }),
  z.strictObject({
    source: z.literal("preview"),
    attemptId: z.uuid(),
    representation: z.literal("dom-reconstruction").optional(),
  }),
]);

// Parse JPEG dimensions without trusting the browser's supplied MIME or size.
export function jpegDimensions(data: Uint8Array) {
  if (data[0] !== 0xff || data[1] !== 0xd8) return null;
  let offset = 2;
  while (offset + 9 < data.length) {
    if (data[offset++] !== 0xff) return null;
    const marker = data[offset++];
    if (marker === undefined || marker === 0xda || marker === 0xd9) return null;
    const length = (data[offset] ?? 0) * 256 + (data[offset + 1] ?? 0);
    if (length < 2 || offset + length > data.length) return null;
    if ([0xc0, 0xc1, 0xc2].includes(marker))
      return {
        width: (data[offset + 5] ?? 0) * 256 + (data[offset + 6] ?? 0),
        height: (data[offset + 3] ?? 0) * 256 + (data[offset + 4] ?? 0),
      };
    offset += length;
  }
  return null;
}

export function createReviewMedia(database: ReturnType<typeof createDatabase>, directory?: string) {
  const root = resolve(
    directory ?? process.env["FACTORY_STATE_DIRECTORY"] ?? ".factory",
    "review-media",
  );
  function path(id: string) {
    return resolve(root, z.uuid().parse(id).toLowerCase());
  }
  async function stage(id: string, data: Uint8Array) {
    const sha = createHash("sha256").update(data).digest("hex");
    const proof = { id, sha, bytes: data.byteLength };
    const [intent] = await database.client<{ state: string; sha: string | null }[]>`
        SELECT state,sha256 AS sha FROM factory.review_media WHERE id=${id}`;
    if (intent?.sha && intent.sha !== sha)
      throw new CommandError("conflict", "Media identity changed its original content");
    if (intent?.state === "complete" && intent.sha === sha) return proof;
    if (!intent || !["intended", "recording"].includes(intent.state))
      throw new CommandError("conflict", "Media publication is no longer current");
    if (data.byteLength < 1 || data.byteLength > maximumRecordingBytes)
      throw new CommandError("conflict", "Media publication exceeds its size bound");
    await mkdir(root, { recursive: true, mode: 0o700 });
    const temporary = `${path(id)}.${crypto.randomUUID()}.part`;
    try {
      const file = await open(temporary, "wx", 0o600);
      try {
        await file.writeFile(data);
        await file.sync();
      } finally {
        await file.close();
      }
      await rename(temporary, path(id));
      const directory = await open(root, "r");
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
    } finally {
      await rm(temporary, { force: true });
    }
    return proof;
  }
  async function complete(
    proof: Awaited<ReturnType<typeof stage>>,
    durationMs: number | undefined,
    sql: AgentTurnTransaction,
  ) {
    const [intent] = await sql<{ state: string; sha: string | null }[]>`
      SELECT state,sha256 AS sha FROM factory.review_media WHERE id=${proof.id} FOR UPDATE`;
    if (intent?.sha && intent.sha !== proof.sha)
      throw new CommandError("conflict", "Media identity changed its original content");
    if (intent?.state === "complete" && intent.sha === proof.sha) return;
    if (!intent || !["intended", "recording"].includes(intent.state))
      throw new CommandError("conflict", "Media publication is no longer current");
    await sql`UPDATE factory.review_media SET state='complete',sha256=${proof.sha},
      byte_length=${proof.bytes},duration_ms=${durationMs ?? null},completed_at=now() WHERE id=${proof.id}`;
  }
  async function publish(id: string, data: Uint8Array, durationMs?: number) {
    const proof = await stage(id, data);
    await database.client.begin((sql) => complete(proof, durationMs, sql));
  }
  return {
    publish,
    stage,
    complete,
    async still(
      changeID: string,
      userID: string,
      context: unknown,
      data: Uint8Array,
      uploadID: string = crypto.randomUUID(),
    ) {
      const input = stillContextInput.parse(context);
      const dimensions = jpegDimensions(data);
      if (
        !dimensions ||
        dimensions.width < 1 ||
        dimensions.height < 1 ||
        data.byteLength > 2_097_152 ||
        dimensions.width > 2560 ||
        dimensions.height > 1600
      )
        throw new CommandError("conflict", "Use a JPEG frame up to 2560×1600 and 2 MiB");
      const id = z.uuid().parse(uploadID).toLowerCase();
      const sha = createHash("sha256").update(data).digest("hex");
      let page: string | undefined;
      await database.client.begin(async (sql) => {
        await reviewChangeIn(sql, changeID, userID, true);
        await sql`SELECT pg_advisory_xact_lock(hashtext(${`review-media:${id}`}))`;
        const [previous] = await sql<
          {
            changeID: string;
            author: string;
            kind: string;
            context: Record<string, unknown>;
            sha: string | null;
            state: string;
          }[]
        >`
          SELECT change_id AS "changeID",created_by AS author,kind,source_context AS context,sha256 AS sha,state
          FROM factory.review_media WHERE id=${id}`;
        if (previous) {
          if (
            previous.changeID !== changeID ||
            previous.author !== userID ||
            previous.kind !== "still" ||
            previous.sha !== sha ||
            Object.entries(input).some(([key, value]) => previous.context?.[key] !== value)
          )
            throw new CommandError("conflict", "Frame upload identity changed input");
          if (!["intended", "complete"].includes(previous.state))
            throw new CommandError("conflict", "This unused frame expired. Capture a frame again.");
          if (typeof previous.context["page"] === "string") page = previous.context["page"];
          return;
        }
        let commitSHA: string | undefined;
        let attemptID: string | null = null;
        if (input.source === "recording") {
          const [recording] = await sql<
            {
              commitSHA: string;
              attemptID: string | null;
              duration: number;
              session: string | null;
              evidence: unknown[];
            }[]
          >`
            SELECT media.commit_sha AS "commitSHA",media.runtime_attempt_id AS "attemptID",media.duration_ms AS duration,
              media.browser_session_id AS session,review.evidence
            FROM factory.review_media media JOIN factory.candidate_review review ON review.id=media.review_id
            WHERE media.id=${input.recordingId} AND media.change_id=${changeID}
              AND media.kind='recording' AND media.state IN ('complete','deleted') AND media.sha256 IS NOT NULL FOR SHARE OF media`;
          commitSHA = recording?.commitSHA;
          attemptID = recording?.attemptID ?? null;
          if (recording && input.timestampMs > recording.duration + 100)
            throw new CommandError("conflict", "Frame timestamp exceeds the original recording");
          const observed = recording?.evidence
            .flatMap((item) => {
              if (
                !item ||
                typeof item !== "object" ||
                !("context" in item) ||
                !item.context ||
                typeof item.context !== "object"
              )
                return [];
              const context = item.context as Record<string, unknown>;
              return context["sessionId"] === recording.session &&
                typeof context["page"] === "string" &&
                typeof context["recordingTimeMs"] === "number" &&
                context["recordingTimeMs"] <= input.timestampMs
                ? [context]
                : [];
            })
            .at(-1);
          if (observed)
            page = `Last observed page: ${String(observed["app"])}${String(observed["page"])}`;
        } else {
          const [attempt] = await sql<{ commitSHA: string }[]>`
            SELECT revision AS "commitSHA" FROM factory.runtime_attempt
            WHERE id=${input.attemptId} AND change_id=${changeID}`;
          commitSHA = attempt?.commitSHA;
          attemptID = input.attemptId;
        }
        if (!commitSHA)
          throw new CommandError("conflict", "Original review context is no longer available");
        const sourceContext = {
          ...input,
          ...(page ? { page } : {}),
          ...(input.source === "preview"
            ? {
                checkoutState: "unverified",
                commitMeaning: "runtime-attempt-basis-not-a-clean-checkout-proof",
              }
            : {}),
        };
        await sql`INSERT INTO factory.review_media(id,change_id,created_by,kind,commit_sha,runtime_attempt_id,source_context,sha256,byte_length,state)
          VALUES(${id},${changeID},${userID},'still',${commitSHA},${attemptID},${JSON.stringify(sourceContext)}::jsonb,${sha},${data.byteLength},'intended')`;
      });
      const proof = await stage(id, data);
      await database.client.begin(async (sql) => {
        await reviewChangeIn(sql, changeID, userID, true);
        await complete(proof, undefined, sql);
      });
      return { id, ...(page ? { page } : {}) };
    },
    async read(changeID: string, userID: string, id: string, range: string | null) {
      const media = await database.client.begin(async (sql) => {
        await reviewChangeIn(sql, changeID, userID);
        const [media] = await sql<{ kind: string; bytes: number }[]>`
          SELECT kind,byte_length AS bytes FROM factory.review_media
          WHERE id=${z.uuid().parse(id)} AND change_id=${changeID} AND state='complete'`;
        return media;
      });
      if (!media) return new Response(null, { status: 404 });
      const file = Bun.file(path(id));
      if (!(await file.exists())) return new Response(null, { status: 404 });
      const headers = new Headers({
        "content-type": media.kind === "still" ? "image/jpeg" : "video/webm",
        "cache-control": "private, no-store",
        "x-content-type-options": "nosniff",
        "accept-ranges": "bytes",
      });
      if (range) {
        const match = /^bytes=(\d+)-(\d*)$/.exec(range);
        const start = Number(match?.[1]);
        const end = match?.[2] ? Number(match[2]) : media.bytes - 1;
        if (
          !match ||
          !Number.isSafeInteger(start) ||
          start < 0 ||
          end < start ||
          end >= media.bytes
        )
          return new Response(null, {
            status: 416,
            headers: { "content-range": `bytes */${media.bytes}` },
          });
        headers.set("content-range", `bytes ${start}-${end}/${media.bytes}`);
        headers.set("content-length", String(end - start + 1));
        return new Response(file.slice(start, end + 1), { status: 206, headers });
      }
      headers.set("content-length", String(media.bytes));
      return new Response(file, { headers });
    },
    async bytes(id: string) {
      return readFile(path(id));
    },
    async sweep() {
      // Mark first, unlink second. A crash repeats deletion, never resurrects
      // expired media or removes annotation stills.
      await database.client`UPDATE factory.review_media media SET state='deleted',deleted_at=now()
        WHERE kind='recording' AND state='complete' AND (
          EXISTS(SELECT 1 FROM factory.review_media newer WHERE newer.change_id=media.change_id
            AND newer.kind='recording' AND newer.state='complete'
            AND (newer.created_at,newer.id)>(media.created_at,media.id))
          OR EXISTS(SELECT 1 FROM factory.change change WHERE change.id=media.change_id
            AND change.state IN ('delivered','cancelled')
            AND COALESCE(change.cancelled_at,change.cancel_requested_at)<now()-interval '30 days'))`;
      const unattached = await database.client<
        { id: string; changeID: string }[]
      >`SELECT id,change_id AS "changeID"
        FROM factory.review_media media
        WHERE kind='still' AND created_at<now()-interval '1 day' AND state IN ('intended','complete')
          AND NOT EXISTS(SELECT 1 FROM factory.review_feedback WHERE media_id=media.id)`;
      for (const item of unattached)
        await database.client.begin(async (sql) => {
          // The same Change lock serializes attaching a frame and expiring an
          // unused upload. Recheck after the lock wait, not in its old snapshot.
          await sql`SELECT id FROM factory.change WHERE id=${item.changeID} FOR UPDATE`;
          await sql`UPDATE factory.review_media media SET state='deleted',deleted_at=now()
          WHERE id=${item.id} AND state IN ('intended','complete')
            AND NOT EXISTS(SELECT 1 FROM factory.review_feedback WHERE media_id=media.id)`;
        });
      // Interrupted publications are recovered as unavailable, never replayed.
      await database.client`UPDATE factory.review_media media SET state='unavailable',
        reason='Recording interrupted. Review results are separate.'
        WHERE kind='recording' AND state IN ('intended','recording')
          AND NOT EXISTS(SELECT 1 FROM factory.build_browser_session browser JOIN factory.agent_turn turn ON turn.id=browser.turn_id
            WHERE browser.id=media.browser_session_id AND browser.state IN ('intended','active')
              AND turn.state IN ('dispatching','running') AND turn.owner_expires_at>now())`;
      const deleted = await database.client<
        { id: string }[]
      >`SELECT id FROM factory.review_media WHERE state IN ('deleted','unavailable')`;
      for (const item of deleted) await rm(path(item.id), { force: true });
      const tombstones = new Set(deleted.map((item) => item.id));
      const files = await readdir(root).catch((cause: NodeJS.ErrnoException) => {
        if (cause.code === "ENOENT") return [];
        throw cause;
      });
      for (const file of files) {
        const id = /^([a-f0-9-]{36})\.[a-f0-9-]{36}\.part$/.exec(file)?.[1];
        if (id && tombstones.has(id)) await rm(resolve(root, file), { force: true });
      }
    },
  };
}
