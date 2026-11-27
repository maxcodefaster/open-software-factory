import { and, eq, inArray, ne, sql as query } from "drizzle-orm";
import { buildBrowserSession } from "#db/schema";
import { interruptRecordings } from "./browser-controller-media";
import { type BrowserSessionContext, readBrowserSession } from "./browser-controller-session";
import {
  type BrowserControllerDatabase,
  classifyBrowserSession,
  LIVE_BROWSER_STATES,
  reopenableBrowserFailure,
  safeBrowserFailureMessage,
} from "./browser-controller-types";

export async function confirmBrowserSessionActive(
  database: BrowserControllerDatabase,
  sessionID: string,
  inspection: Record<string, unknown>,
) {
  await database.db
    .update(buildBrowserSession)
    .set({
      state: "active",
      createConfirmedAt: query`COALESCE(${buildBrowserSession.createConfirmedAt}, now())`,
      inspectionContext: inspection,
    })
    .where(
      and(
        eq(buildBrowserSession.id, sessionID),
        inArray(buildBrowserSession.state, LIVE_BROWSER_STATES),
      ),
    );
}

export function createBrowserSessionCloser(
  ctx: BrowserSessionContext,
  onClearObservation: (sessionID: string) => void,
) {
  const closing = new Map<string, Promise<void>>();

  async function closeSession(id: string, cause?: unknown) {
    const previous = closing.get(id);
    if (previous) return previous;
    const safeReason = safeBrowserFailureMessage(cause);
    const summary = safeReason ? `Inspection ended: ${safeReason}` : null;
    const reopenAllowed = reopenableBrowserFailure(cause);
    const work = (async () => {
      await ctx.database.db
        .update(buildBrowserSession)
        .set({
          state: "closing",
          reopenAllowed,
          cleanupIntendedAt: query`COALESCE(${buildBrowserSession.cleanupIntendedAt}, now())`,
          outcomeSummary: query`COALESCE(${summary}, ${buildBrowserSession.outcomeSummary})`,
        })
        .where(
          and(
            eq(buildBrowserSession.id, id),
            inArray(buildBrowserSession.state, LIVE_BROWSER_STATES),
          ),
        );
      const session = await readBrowserSession(ctx.database, id);
      if (!session || classifyBrowserSession(session).state === "closed") return;
      await interruptRecordings(
        ctx.database,
        { kind: "session", sessionID: id },
        "Recording interrupted. App observations and QA results are retained separately.",
      );
      onClearObservation(id);
      try {
        await ctx.native.close(session);
        await ctx.database.db
          .update(buildBrowserSession)
          .set({
            state: "closed",
            cleanupConfirmedAt: query`now()`,
            outcomeSummary: query`CASE WHEN ${buildBrowserSession.outcomeSummary} LIKE 'Inspection ended: %'
            THEN ${buildBrowserSession.outcomeSummary} ELSE 'Original native Browser Actor and template deletion confirmed' END`,
          })
          .where(and(eq(buildBrowserSession.id, id), eq(buildBrowserSession.state, "closing")));
      } catch {
        // Parent teardown or a disconnected control socket is not native absence.
        await ctx.database.db
          .update(buildBrowserSession)
          .set({
            outcomeSummary: query`CASE WHEN ${buildBrowserSession.outcomeSummary} LIKE 'Inspection ended: %'
            THEN ${buildBrowserSession.outcomeSummary}
            ELSE 'Native Browser cleanup is unconfirmed; retain its original identity for cleanup' END`,
          })
          .where(and(eq(buildBrowserSession.id, id), eq(buildBrowserSession.state, "closing")));
      }
    })();
    closing.set(id, work);
    try {
      await work;
    } finally {
      closing.delete(id);
    }
  }

  return {
    closeSession,
    async closeChange(changeID: string) {
      const sessions = await ctx.database.db
        .select({ id: buildBrowserSession.id })
        .from(buildBrowserSession)
        .where(
          and(eq(buildBrowserSession.changeId, changeID), ne(buildBrowserSession.state, "closed")),
        );
      await Promise.all(sessions.map(({ id }) => closeSession(id)));
    },
    async reconcileCleanup() {
      const sessions = await ctx.database.db
        .select({ id: buildBrowserSession.id })
        .from(buildBrowserSession)
        .where(eq(buildBrowserSession.state, "closing"));
      await Promise.all(sessions.map(({ id }) => closeSession(id)));
    },
    async recover(attemptID?: string) {
      const sessions = await ctx.database.db
        .select({ id: buildBrowserSession.id })
        .from(buildBrowserSession)
        .where(
          and(
            ne(buildBrowserSession.state, "closed"),
            attemptID === undefined
              ? undefined
              : and(
                  eq(buildBrowserSession.runtimeAttemptId, attemptID),
                  eq(buildBrowserSession.state, "closing"),
                ),
          ),
        );
      await Promise.all(sessions.map(({ id }) => closeSession(id)));
    },
  };
}
