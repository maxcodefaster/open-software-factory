import { setTimeout as delay } from "node:timers/promises";
import { and, eq, inArray, isNull, sql as query } from "drizzle-orm";
import { z } from "zod";
import { drizzleTransaction } from "#db/client";
import { buildBrowserSession, candidateReview, reviewMedia } from "#db/schema";
import { maximumRecordingBytes } from "../review/api";
import {
  type BrowserControllerDatabase,
  type BrowserDispatchFn,
  type BrowserMediaStore,
  type BrowserSession,
  type BrowserTurnStore,
  LIVE_RECORDING_STATES,
  type ValidateBrowserCurrentIn,
} from "./browser-controller-types";

export type RecordingInterruptTarget =
  | { kind: "recording"; id: string }
  | { kind: "session"; sessionID: string }
  | { kind: "turn"; turnID: string };

export type BrowserMediaContext = {
  database: BrowserControllerDatabase;
  turns: BrowserTurnStore;
  media: BrowserMediaStore;
  validateCurrentIn: ValidateBrowserCurrentIn;
  dispatch: BrowserDispatchFn;
};

const recordingManifestInput = z.object({
  bytes: z.number().int().positive().max(maximumRecordingBytes),
  durationMs: z.number().int().nonnegative(),
  note: z.literal("Unchanged frames shortened.").optional(),
});

const recordingPendingInput = z.strictObject({ state: z.literal("pending") });
const recordingChunkInput = z.object({
  offset: z.number().int(),
  data: z.string().max(65_536),
});

export async function interruptRecordings(
  database: BrowserControllerDatabase,
  target: RecordingInterruptTarget,
  reason: string,
) {
  const scopeFilter =
    target.kind === "recording"
      ? eq(reviewMedia.id, target.id)
      : target.kind === "session"
        ? eq(reviewMedia.browserSessionId, target.sessionID)
        : inArray(
            reviewMedia.browserSessionId,
            database.db
              .select({ id: buildBrowserSession.id })
              .from(buildBrowserSession)
              .where(eq(buildBrowserSession.turnId, target.turnID)),
          );
  await database.db
    .update(reviewMedia)
    .set({ state: "unavailable", reason })
    .where(and(scopeFilter, inArray(reviewMedia.state, LIVE_RECORDING_STATES)))
    .catch(() => {});
}

export async function beginBrowserRecording(
  ctx: BrowserMediaContext,
  session: BrowserSession,
  ownerToken: string,
) {
  // Persist the fixed recording identity before asking upstream to create it.
  // Only independent review sessions record; implementation never does.
  let id: string | undefined;
  try {
    const allowed = await ctx.turns.validateExecution(session.turnID, ownerToken, async (sql) => {
      await ctx.validateCurrentIn(sql, session, ownerToken);
      const db = drizzleTransaction(sql);
      const [intent] = await db
        .insert(reviewMedia)
        .select(
          db
            .select({
              id: query<string>`${session.id}::uuid`.as("id"),
              changeId: candidateReview.changeId,
              reviewId: candidateReview.id,
              browserSessionId: query<string>`${session.id}::uuid`.as("browser_session_id"),
              createdBy: query<null>`NULL::uuid`.as("created_by"),
              kind: query<string>`'recording'::text`.as("kind"),
              commitSha: candidateReview.commitSha,
              runtimeAttemptId: query<string>`${session.attemptID}::uuid`.as("runtime_attempt_id"),
              sourceContext: query<null>`NULL::jsonb`.as("source_context"),
              state: query<string>`'intended'::text`.as("state"),
              byteLength: query<null>`NULL::integer`.as("byte_length"),
              sha256: query<null>`NULL::text`.as("sha256"),
              durationMs: query<null>`NULL::integer`.as("duration_ms"),
              reason: query<null>`NULL::text`.as("reason"),
              createdAt: query<Date>`clock_timestamp()`.as("created_at"),
              completedAt: query<null>`NULL::timestamptz`.as("completed_at"),
              deletedAt: query<null>`NULL::timestamptz`.as("deleted_at"),
            })
            .from(candidateReview)
            .where(
              and(
                eq(candidateReview.turnId, session.turnID),
                isNull(candidateReview.findingSourceId),
              ),
            ),
        )
        .onConflictDoNothing()
        .returning({ id: reviewMedia.id, state: reviewMedia.state });
      if (intent?.state === "intended") id = intent.id;
    });
    if (!allowed || !id) return;
    const output = await ctx.dispatch(session, ownerToken, "browser-recording-start");
    const started = z.object({ startedAt: z.iso.datetime() }).parse(JSON.parse(output.data ?? ""));
    await ctx.database.db
      .update(reviewMedia)
      .set({
        state: "recording",
        createdAt: query`${started.startedAt}::timestamptz`,
      })
      .where(and(eq(reviewMedia.id, id), eq(reviewMedia.state, "intended")));
  } catch {
    if (id) {
      await interruptRecordings(
        ctx.database,
        { kind: "recording", id },
        "QA recording unavailable. App observations and review results are separate.",
      );
    }
    // Never turn a successful browser action into a retriable failure just
    // because recording was unavailable.
  }
}

export async function finishBrowserRecording(
  ctx: BrowserMediaContext,
  session: BrowserSession,
  ownerToken: string,
  signal?: AbortSignal,
) {
  const [recording] = await ctx.database.db
    .select({ id: reviewMedia.id })
    .from(reviewMedia)
    .where(
      and(
        eq(reviewMedia.browserSessionId, session.id),
        eq(reviewMedia.kind, "recording"),
        eq(reviewMedia.state, "recording"),
      ),
    );
  if (!recording) return;
  try {
    let manifest: z.infer<typeof recordingManifestInput>;
    for (;;) {
      const output = await ctx.dispatch(
        session,
        ownerToken,
        "browser-recording-finish",
        undefined,
        signal,
      );
      const value: unknown = JSON.parse(output.data ?? "");
      if (recordingPendingInput.safeParse(value).success) {
        await delay(500, undefined, { signal });
        continue;
      }
      manifest = recordingManifestInput.parse(value);
      break;
    }
    const chunks: Buffer[] = [];
    for (let offset = 0; offset < manifest.bytes; offset += 49_152) {
      const output = await ctx.dispatch(
        session,
        ownerToken,
        "browser-recording-chunk",
        { name: "recording_chunk", arguments: { offset } },
        signal,
      );
      const chunk = recordingChunkInput.parse(JSON.parse(output.data ?? ""));
      const bytes = Buffer.from(chunk.data, "base64");
      if (
        chunk.offset !== offset ||
        bytes.byteLength !== Math.min(49_152, manifest.bytes - offset)
      ) {
        throw new Error("Recording chunk did not match its manifest");
      }
      chunks.push(bytes);
    }
    const bytes = Buffer.concat(chunks);
    if (bytes.readUInt32BE(0) !== 0x1a45dfa3) throw new Error("Recording is not WebM");
    // Slow state-volume I/O must not hold the turn lock and starve its
    // ownership heartbeat. Publication is a separate, short fenced commit.
    const proof = await ctx.media.stage(recording.id, bytes);
    signal?.throwIfAborted();
    await ctx.turns.validateExecution(session.turnID, ownerToken, async (sql) => {
      await ctx.validateCurrentIn(sql, session, ownerToken);
      await ctx.media.complete(proof, manifest.durationMs, sql, manifest.note);
      await ctx.validateCurrentIn(sql, session, ownerToken);
    });
  } catch {
    await interruptRecordings(
      ctx.database,
      { kind: "recording", id: recording.id },
      "QA recording unavailable. App observations and review results are separate.",
    );
  }
}
