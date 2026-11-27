import { createHash } from "node:crypto";
import {
  and,
  eq,
  exists,
  sql as expression,
  gt,
  inArray,
  isNotNull,
  isNull,
  lt,
  notExists,
  or,
} from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { z } from "zod";
import { type createDatabase, type DatabaseTransaction, drizzleTransaction } from "#db/client";
import {
  agentTurn,
  buildBrowserSession,
  candidateReview,
  change,
  operation,
  reviewFeedback,
  reviewMedia,
  runtimeAttempt,
} from "#db/schema";
import { CommandError } from "../command-error";
import { createPrivateObjects, type PrivateObjects } from "../storage/objects";
import { reviewChangeIn } from "./controller";

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

export function createReviewMedia(
  database: ReturnType<typeof createDatabase>,
  objects: PrivateObjects = createPrivateObjects(),
) {
  async function key(id: string) {
    const [storage] = await database.db
      .select({ id: operation.id })
      .from(operation)
      .where(
        and(
          eq(operation.kind, "attachment.storage"),
          eq(operation.idempotencyKey, "attachment.storage:singleton"),
        ),
      );
    if (!storage) throw new Error("Installation storage identity is unavailable");
    return `factory-review/${storage.id}/${z.uuid().parse(id).toLowerCase()}`;
  }
  async function stage(id: string, data: Uint8Array) {
    const sha = createHash("sha256").update(data).digest("hex");
    const proof = { id, sha, bytes: data.byteLength };
    const [intent] = await database.db
      .select({ state: reviewMedia.state, sha: reviewMedia.sha256, kind: reviewMedia.kind })
      .from(reviewMedia)
      .where(eq(reviewMedia.id, id));
    if (intent?.sha && intent.sha !== sha)
      throw new CommandError("conflict", "Media identity changed its original content");
    if (intent?.state === "complete" && intent.sha === sha) return proof;
    if (!intent || !["intended", "recording"].includes(intent.state))
      throw new CommandError("conflict", "Media publication is no longer current");
    if (data.byteLength < 1 || data.byteLength > maximumRecordingBytes)
      throw new CommandError("conflict", "Media publication exceeds its size bound");
    const [claimed] = await database.db
      .update(reviewMedia)
      .set({ sha256: sha, byteLength: data.byteLength })
      .where(
        and(
          eq(reviewMedia.id, id),
          inArray(reviewMedia.state, ["intended", "recording"]),
          or(isNull(reviewMedia.sha256), eq(reviewMedia.sha256, sha)),
        ),
      )
      .returning({ id: reviewMedia.id });
    if (!claimed)
      throw new CommandError("conflict", "Media publication changed its original content");
    await objects.put(await key(id), data, intent.kind === "still" ? "image/jpeg" : "video/webm");
    return proof;
  }
  async function complete(
    proof: Awaited<ReturnType<typeof stage>>,
    durationMs: number | undefined,
    sql: DatabaseTransaction,
    note?: "Unchanged frames shortened.",
  ) {
    const db = drizzleTransaction(sql);
    const [intent] = await db
      .select({ state: reviewMedia.state, sha: reviewMedia.sha256 })
      .from(reviewMedia)
      .where(eq(reviewMedia.id, proof.id))
      .for("update");
    if (intent?.sha && intent.sha !== proof.sha)
      throw new CommandError("conflict", "Media identity changed its original content");
    if (intent?.state === "complete" && intent.sha === proof.sha) return;
    if (!intent || !["intended", "recording"].includes(intent.state))
      throw new CommandError("conflict", "Media publication is no longer current");
    await db
      .update(reviewMedia)
      .set({
        state: "complete",
        sha256: proof.sha,
        byteLength: proof.bytes,
        durationMs: durationMs ?? null,
        reason: note ?? null,
        completedAt: expression`now()`,
      })
      .where(eq(reviewMedia.id, proof.id));
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
        const db = drizzleTransaction(sql);
        const [previous] = await db
          .select({
            changeID: reviewMedia.changeId,
            author: reviewMedia.createdBy,
            kind: reviewMedia.kind,
            context: expression<Record<string, unknown>>`${reviewMedia.sourceContext}`,
            sha: reviewMedia.sha256,
            state: reviewMedia.state,
          })
          .from(reviewMedia)
          .where(eq(reviewMedia.id, id));
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
          const media = alias(reviewMedia, "media");
          const [recording] = await db
            .select({
              commitSHA: media.commitSha,
              attemptID: media.runtimeAttemptId,
              duration: expression<number>`${media.durationMs}`,
              session: media.browserSessionId,
              evidence: expression<unknown[]>`${candidateReview.evidence}`,
            })
            .from(media)
            .innerJoin(candidateReview, eq(candidateReview.id, media.reviewId))
            .where(
              and(
                eq(media.id, input.recordingId),
                eq(media.changeId, changeID),
                eq(media.kind, "recording"),
                inArray(media.state, ["complete", "deleted"]),
                isNotNull(media.sha256),
              ),
            )
            .for("share", { of: media });
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
          const [attempt] = await db
            .select({ commitSHA: runtimeAttempt.revision })
            .from(runtimeAttempt)
            .where(
              and(eq(runtimeAttempt.id, input.attemptId), eq(runtimeAttempt.changeId, changeID)),
            );
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
        await db.insert(reviewMedia).values({
          id,
          changeId: changeID,
          createdBy: userID,
          kind: "still",
          commitSha: commitSHA,
          runtimeAttemptId: attemptID,
          sourceContext,
          sha256: sha,
          byteLength: data.byteLength,
          state: "intended",
        });
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
        const [media] = await drizzleTransaction(sql)
          .select({ kind: reviewMedia.kind, bytes: expression<number>`${reviewMedia.byteLength}` })
          .from(reviewMedia)
          .where(
            and(
              eq(reviewMedia.id, z.uuid().parse(id)),
              eq(reviewMedia.changeId, changeID),
              eq(reviewMedia.state, "complete"),
            ),
          );
        return media;
      });
      if (!media) return new Response(null, { status: 404 });
      const headers = new Headers({
        "content-type": media.kind === "still" ? "image/jpeg" : "video/webm",
        "cache-control": "private, no-store",
        "x-content-type-options": "nosniff",
        "accept-ranges": "bytes",
      });
      let requested: { start: number; end: number } | undefined;
      if (range) {
        const match = /^bytes=(\d+)-(\d*)$/.exec(range);
        const start = Number(match?.[1]);
        const end = match?.[2] ? Number(match[2]) : media.bytes - 1;
        if (
          !match ||
          !Number.isSafeInteger(start) ||
          !Number.isSafeInteger(end) ||
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
        requested = { start, end };
      } else {
        headers.set("content-length", String(media.bytes));
      }
      const response = await objects.open(await key(id), requested);
      if (response.status === 404) {
        await response.body?.cancel();
        return new Response(null, { status: 404 });
      }
      if (
        response.status !== (requested ? 206 : 200) ||
        response.headers.get("content-length") !== headers.get("content-length") ||
        (requested && response.headers.get("content-range") !== headers.get("content-range"))
      ) {
        await response.body?.cancel();
        throw new CommandError("unavailable", "Stored review media could not be verified.");
      }
      try {
        await database.client.begin(async (sql) => {
          await reviewChangeIn(sql, changeID, userID);
          const [current] = await drizzleTransaction(sql)
            .select({ id: reviewMedia.id })
            .from(reviewMedia)
            .where(
              and(
                eq(reviewMedia.id, id),
                eq(reviewMedia.changeId, changeID),
                eq(reviewMedia.state, "complete"),
              ),
            );
          if (!current)
            throw new CommandError("unavailable", "Review media is no longer available.");
        });
      } catch (cause) {
        await response.body?.cancel();
        throw cause;
      }
      return new Response(response.body, { status: requested ? 206 : 200, headers });
    },
    async bytes(id: string) {
      const [media] = await database.db
        .select({
          sha: reviewMedia.sha256,
          bytes: reviewMedia.byteLength,
        })
        .from(reviewMedia)
        .where(and(eq(reviewMedia.id, z.uuid().parse(id)), eq(reviewMedia.state, "complete")));
      if (!media) throw new CommandError("unavailable", "Review media is unavailable.");
      const data = await objects.read(await key(id));
      if (
        data.byteLength !== media.bytes ||
        createHash("sha256").update(data).digest("hex") !== media.sha
      )
        throw new CommandError("unavailable", "Stored review media could not be verified.");
      return data;
    },
    async sweep() {
      // Mark first, delete the exact object second. A crash repeats deletion, never resurrects
      // expired media or removes annotation stills.
      const db = database.db;
      const newer = alias(reviewMedia, "newer");
      await db
        .update(reviewMedia)
        .set({ state: "deleted", deletedAt: expression`now()` })
        .where(
          and(
            eq(reviewMedia.kind, "recording"),
            eq(reviewMedia.state, "complete"),
            or(
              exists(
                db
                  .select({ id: newer.id })
                  .from(newer)
                  .where(
                    and(
                      eq(newer.changeId, reviewMedia.changeId),
                      eq(newer.kind, "recording"),
                      eq(newer.state, "complete"),
                      expression`(${newer.createdAt},${newer.id})>(${reviewMedia.createdAt},${reviewMedia.id})`,
                    ),
                  ),
              ),
              exists(
                db
                  .select({ id: change.id })
                  .from(change)
                  .where(
                    and(
                      eq(change.id, reviewMedia.changeId),
                      inArray(change.state, ["delivered", "cancelled"]),
                      expression`COALESCE(${change.cancelledAt},${change.cancelRequestedAt})<now()-interval '30 days'`,
                    ),
                  ),
              ),
            ),
          ),
        );
      const unattached = await db
        .select({ id: reviewMedia.id, changeID: reviewMedia.changeId })
        .from(reviewMedia)
        .where(
          and(
            eq(reviewMedia.kind, "still"),
            lt(reviewMedia.createdAt, expression`now()-interval '1 day'`),
            inArray(reviewMedia.state, ["intended", "complete"]),
            notExists(
              db
                .select({ id: reviewFeedback.id })
                .from(reviewFeedback)
                .where(eq(reviewFeedback.mediaId, reviewMedia.id)),
            ),
          ),
        );
      for (const item of unattached)
        await database.client.begin(async (sql) => {
          // The same Change lock serializes attaching a frame and expiring an
          // unused upload. Recheck after the lock wait, not in its old snapshot.
          const db = drizzleTransaction(sql);
          await db
            .select({ id: change.id })
            .from(change)
            .where(eq(change.id, item.changeID))
            .for("update");
          await db
            .update(reviewMedia)
            .set({ state: "deleted", deletedAt: expression`now()` })
            .where(
              and(
                eq(reviewMedia.id, item.id),
                inArray(reviewMedia.state, ["intended", "complete"]),
                notExists(
                  db
                    .select({ id: reviewFeedback.id })
                    .from(reviewFeedback)
                    .where(eq(reviewFeedback.mediaId, reviewMedia.id)),
                ),
              ),
            );
        });
      // Interrupted publications are recovered as unavailable, never replayed.
      await db
        .update(reviewMedia)
        .set({
          state: "unavailable",
          reason: "Recording interrupted. Review results are separate.",
        })
        .where(
          and(
            eq(reviewMedia.kind, "recording"),
            inArray(reviewMedia.state, ["intended", "recording"]),
            notExists(
              db
                .select({ id: buildBrowserSession.id })
                .from(buildBrowserSession)
                .innerJoin(agentTurn, eq(agentTurn.id, buildBrowserSession.turnId))
                .where(
                  and(
                    eq(buildBrowserSession.id, reviewMedia.browserSessionId),
                    inArray(buildBrowserSession.state, ["intended", "active"]),
                    inArray(agentTurn.state, ["dispatching", "running"]),
                    gt(agentTurn.ownerExpiresAt, expression`now()`),
                  ),
                ),
            ),
          ),
        );
      const deleted = await db
        .select({ id: reviewMedia.id })
        .from(reviewMedia)
        .where(inArray(reviewMedia.state, ["deleted", "unavailable"]));
      for (const item of deleted) await objects.remove(await key(item.id));
    },
  };
}
