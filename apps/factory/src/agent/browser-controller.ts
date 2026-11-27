import { and, desc, eq } from "drizzle-orm";
import type { BuildBrowserResult } from "#conversation-domain/browser-tools";
import { buildBrowserSession } from "#db/schema";
import { createReviewMedia } from "../review/api";
import {
  createBrowserCallGuard,
  dispatchBrowserOperation,
  executeBrowserCall,
  renewTurnBrowser,
} from "./browser-controller-actions";
import { createBrowserSessionCloser } from "./browser-controller-cleanup";
import {
  type BrowserMediaContext,
  finishBrowserRecording,
  interruptRecordings,
} from "./browser-controller-media";
import {
  authorizeBrowserSession,
  authorizeRuntimeBrowser,
  prepareBrowserSession,
  readBrowserSession,
  validateBrowserAuthorityIn,
} from "./browser-controller-session";
import {
  type BrowserControllerDatabase,
  type BrowserNativeClient,
  type BrowserSession,
  ownerIdentity,
} from "./browser-controller-types";
import { createAgentTurnStore } from "./turn-store";

export function createBuildBrowserController(
  database: BrowserControllerDatabase,
  secret: string,
  native: BrowserNativeClient,
  media = createReviewMedia(database),
) {
  const turns = createAgentTurnStore(database);
  const renewing = new Set<string>();
  const guard = createBrowserCallGuard();
  const sessionCtx = { database, secret, turns, native };
  const cleanup = createBrowserSessionCloser(sessionCtx, (id) => guard.clearObservation(id));
  const actionCtx = { ...sessionCtx, media, guard, closeSession: cleanup.closeSession };
  const mediaCtx: BrowserMediaContext = {
    database,
    turns,
    media,
    validateCurrentIn: validateBrowserAuthorityIn,
    dispatch: (session, ownerToken, action, call, signal) =>
      dispatchBrowserOperation(sessionCtx, session, ownerToken, action, call, signal),
  };

  return {
    prepare(turnID: string, ownerToken: string) {
      return prepareBrowserSession(sessionCtx, turnID, ownerToken);
    },

    authorize(id: string, authorization: string | null, purpose: "browser" | "facade" = "browser") {
      return authorizeBrowserSession(
        sessionCtx,
        id,
        authorization,
        purpose === "facade" ? "facade" : "active",
      );
    },

    authorizeRuntime(
      attemptID: string,
      turnID: string,
      authorization: string | null,
      purpose: "browser" | "facade" = "browser",
    ) {
      return authorizeRuntimeBrowser(sessionCtx, attemptID, turnID, authorization, purpose);
    },

    call(
      session: BrowserSession,
      ownerToken: string,
      input: unknown,
      requestID: string | number,
      signal?: AbortSignal,
    ): Promise<BuildBrowserResult> {
      return executeBrowserCall(actionCtx, session, ownerToken, input, requestID, signal);
    },

    finishRecording(session: BrowserSession, ownerToken: string, signal?: AbortSignal) {
      return finishBrowserRecording(mediaCtx, session, ownerToken, signal);
    },

    async finishTurnRecording(turnID: string, ownerToken: string, signal?: AbortSignal) {
      try {
        const [latest] = await database.db
          .select({ id: buildBrowserSession.id })
          .from(buildBrowserSession)
          .where(
            and(
              eq(buildBrowserSession.turnId, turnID),
              eq(buildBrowserSession.ownerId, ownerIdentity(ownerToken)),
              eq(buildBrowserSession.state, "active"),
            ),
          )
          .orderBy(desc(buildBrowserSession.ordinal))
          .limit(1);
        const session = latest ? await readBrowserSession(database, latest.id) : undefined;
        if (session) await this.finishRecording(session, ownerToken, signal);
      } catch {
        // Media failure must not change the QA verdict or block exact cleanup.
      }
    },

    renewTurn(turnID: string, ownerToken: string) {
      return renewTurnBrowser(actionCtx, renewing, turnID, ownerToken);
    },

    async closeTurn(turnID: string) {
      await interruptRecordings(
        database,
        { kind: "turn", turnID },
        "Recording interrupted. No App actions were repeated.",
      );
      const sessions = await database.db
        .select({ id: buildBrowserSession.id, ownerID: buildBrowserSession.ownerId })
        .from(buildBrowserSession)
        .where(eq(buildBrowserSession.turnId, turnID));
      await Promise.all(sessions.map(({ id }) => cleanup.closeSession(id)));
      for (const session of sessions) guard.clearTurnOwner(turnID, session.ownerID);
    },

    closeChange: cleanup.closeChange,
    reconcileCleanup: cleanup.reconcileCleanup,
    recover: cleanup.recover,
  };
}
