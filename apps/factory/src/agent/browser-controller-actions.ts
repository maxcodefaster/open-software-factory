import { and, eq, inArray, isNotNull } from "drizzle-orm";
import {
  type BuildBrowserResult,
  buildBrowserCallInput,
  buildBrowserResultInput,
} from "#conversation-domain/browser-tools";
import { buildBrowserSession, candidateReview } from "#db/schema";
import { CommandError } from "../command-error";
import type { BrowserExecutionAuthority } from "../runtime/browser-api";
import { confirmBrowserSessionActive } from "./browser-controller-cleanup";
import { beginBrowserRecording } from "./browser-controller-media";
import {
  type BrowserSessionContext,
  readBrowserSession,
  reopenBrowserSession,
  validateBrowserAuthorityIn,
} from "./browser-controller-session";
import {
  type BrowserAction,
  type BrowserMediaStore,
  type BrowserOperationCall,
  type BrowserSession,
  buildBrowserOperationPayload,
  classifyBrowserSession,
  isTransientRenewalFailure,
  LIVE_BROWSER_STATES,
  ownerIdentity,
  READ_ONLY_OBSERVATION_CALLS,
  reopenableBrowserFailure,
  safeBrowserFailureMessage,
} from "./browser-controller-types";

export function createBrowserCallGuard() {
  const dispatchedCalls = new Map<string, Set<string>>();
  // Browser recovery closes old sessions on process restart. Losing this
  // ephemeral observation barrier never permits reusing an old browser.
  const needsObservation = new Set<string>();

  return {
    claimCallSlot(session: BrowserSession, requestID: string | number) {
      const callKey = `${session.turnID}:${session.ownerID}`;
      const calls = dispatchedCalls.get(callKey) ?? new Set<string>();
      dispatchedCalls.set(callKey, calls);
      const identity = `${typeof requestID}:${requestID}`;
      if (calls.has(identity)) {
        throw new CommandError(
          "conflict",
          "This browser request was already dispatched. Check the App before issuing a new UI mutation.",
        );
      }
      if (calls.size >= 128) {
        throw new CommandError(
          "conflict",
          "This turn reached its 128 browser-call limit. Continue in a new authorized turn.",
        );
      }
      return {
        record() {
          calls.add(identity);
        },
      };
    },
    requiresObservation(sessionID: string) {
      return needsObservation.has(sessionID);
    },
    markNeedsObservation(sessionID: string) {
      needsObservation.add(sessionID);
    },
    clearObservation(sessionID: string) {
      needsObservation.delete(sessionID);
    },
    clearTurnOwner(turnID: string, ownerID: string) {
      dispatchedCalls.delete(`${turnID}:${ownerID}`);
    },
  };
}

export type BrowserCallGuard = ReturnType<typeof createBrowserCallGuard>;

function executionAuthority(
  ctx: BrowserSessionContext,
  session: BrowserSession,
  ownerToken: string,
): BrowserExecutionAuthority {
  return async (send) => {
    let dispatched = false;
    const allowed = await ctx.turns.validateExecution(session.turnID, ownerToken, async (sql) => {
      const expiresAt = await validateBrowserAuthorityIn(sql, session, ownerToken);
      send(expiresAt);
      dispatched = true;
    });
    if (!allowed || !dispatched) {
      throw new CommandError("conflict", "Browser Build authority changed before dispatch");
    }
  };
}

export async function dispatchBrowserOperation(
  ctx: BrowserSessionContext,
  session: BrowserSession,
  ownerToken: string,
  action: BrowserAction,
  call?: BrowserOperationCall,
  signal?: AbortSignal,
) {
  signal?.throwIfAborted();
  let expiresAt: string | undefined;
  const admitted = await ctx.turns.validateExecution(session.turnID, ownerToken, async (sql) => {
    expiresAt = await validateBrowserAuthorityIn(sql, session, ownerToken);
  });
  if (!admitted || !expiresAt) {
    throw new CommandError("conflict", "Browser requires live Build authority");
  }
  if (action === "browser-call" && call?.name === "browser_open") {
    await ctx.native.prepare(session, executionAuthority(ctx, session, ownerToken), signal);
    // Cold native allocation/image pulls are not part of a tool's short lease.
    // Obtain that lease only after the original Actor/control connection is ready.
    const ready = await ctx.turns.validateExecution(session.turnID, ownerToken, async (sql) => {
      expiresAt = await validateBrowserAuthorityIn(sql, session, ownerToken);
    });
    if (!ready) throw new CommandError("conflict", "Browser requires live Build authority");
  }
  const payload = buildBrowserOperationPayload(session, action, expiresAt, call);
  return ctx.native.operation(session, payload, async (send) => {
    const allowed = await ctx.turns.validateExecution(session.turnID, ownerToken, async (sql) => {
      await validateBrowserAuthorityIn(sql, session, ownerToken);
      if (Date.parse(expiresAt ?? "") - Date.now() < 1_000) {
        throw new CommandError(
          "conflict",
          "Browser dispatch lease expired while awaiting authority",
        );
      }
      signal?.throwIfAborted();
      // Recheck Stop/current scope at the actual frame send, then release the
      // transaction before awaiting the browser. The lease cannot be extended
      // by a delayed frame or an unconfirmed outcome.
      send();
    });
    if (!allowed) {
      throw new CommandError("conflict", "Browser Build authority changed before dispatch");
    }
  });
}

export type BrowserActionContext = BrowserSessionContext & {
  media: BrowserMediaStore;
  guard: BrowserCallGuard;
  closeSession: (id: string, cause?: unknown) => Promise<void>;
};

export async function executeBrowserCall(
  ctx: BrowserActionContext,
  initialSession: BrowserSession,
  ownerToken: string,
  input: unknown,
  requestID: string | number,
  signal?: AbortSignal,
): Promise<BuildBrowserResult> {
  const call = buildBrowserCallInput.parse(input);
  const [reported] = await ctx.database.db
    .select({ id: candidateReview.id })
    .from(candidateReview)
    .where(
      and(eq(candidateReview.turnId, initialSession.turnID), isNotNull(candidateReview.result)),
    );
  if (reported) {
    throw new CommandError(
      "conflict",
      "Review report is already recorded. Finish this review without further App actions.",
    );
  }
  const slot = ctx.guard.claimCallSlot(initialSession, requestID);
  let session = initialSession;
  let phase = classifyBrowserSession(session);
  if (phase.state === "closed") {
    if (call.name !== "browser_open") {
      throw new CommandError(
        "conflict",
        "The previous browser ended. Use browser_open to start a fresh inspection, then inspect browser_snapshot. Never replay an unconfirmed App action.",
      );
    }
    slot.record();
    session = await reopenBrowserSession(ctx, session, ownerToken);
    phase = classifyBrowserSession(session);
  }
  const freshInspection =
    phase.state === "intended" && phase.isReopened && call.name === "browser_open";
  if (ctx.guard.requiresObservation(session.id) && !READ_ONLY_OBSERVATION_CALLS.has(call.name)) {
    throw new CommandError(
      "conflict",
      "Inspect a fresh browser_snapshot after the failed interaction before issuing another UI action. Do not replay an unconfirmed mutation.",
    );
  }
  slot.record();
  try {
    const output = await dispatchBrowserOperation(
      ctx,
      session,
      ownerToken,
      "browser-call",
      call,
      signal,
    );
    signal?.throwIfAborted();
    if (!output.data) throw new Error("Browser result unavailable");
    const parsed = buildBrowserResultInput.safeParse(JSON.parse(output.data));
    if (!parsed.success) throw new Error("Browser returned an invalid observation schema");
    const result = parsed.data;
    if (result.isError) {
      ctx.guard.markNeedsObservation(session.id);
      return {
        isError: true,
        content: [
          ...result.content.filter((item) => item.type === "text").slice(0, 15),
          {
            type: "text",
            text: "Inspect a fresh browser_snapshot before issuing another UI action. The existing browser remains available for observation, but no successful inspection is claimed by this error. Do not repeat navigation or replay an unconfirmed mutation.",
          },
        ],
      };
    }
    const context = result.structuredContent;
    if (
      !context ||
      context.sessionId !== session.id ||
      context.turnId !== session.turnID ||
      context.runtimeAttemptId !== session.attemptID ||
      context.generation !== session.generation
    ) {
      throw new Error("Browser observation does not match this execution scope");
    }
    const inspection = { ...context, changeId: session.changeID };
    if (call.name === "browser_snapshot") ctx.guard.clearObservation(session.id);
    if (freshInspection) ctx.guard.markNeedsObservation(session.id);
    await confirmBrowserSessionActive(ctx.database, session.id, inspection);
    if (call.name === "browser_open" || phase.state === "intended") {
      await beginBrowserRecording(
        {
          database: ctx.database,
          turns: ctx.turns,
          media: ctx.media,
          validateCurrentIn: validateBrowserAuthorityIn,
          dispatch: (target, token, action, opCall, opSignal) =>
            dispatchBrowserOperation(ctx, target, token, action, opCall, opSignal),
        },
        session,
        ownerToken,
      );
    }
    return {
      ...result,
      structuredContent: inspection,
      ...(freshInspection
        ? {
            content: [
              ...result.content,
              {
                type: "text" as const,
                text: "Factory opened a fresh browser after confirmed cleanup. Previous cookies and UI state were not restored. Inspect browser_snapshot before another action; do not replay any unconfirmed mutation.",
              },
            ],
          }
        : {}),
    };
  } catch (cause) {
    await ctx.closeSession(session.id, cause);
    const safeReason = safeBrowserFailureMessage(cause);
    const reason = safeReason ? `: ${safeReason}` : "";
    throw new CommandError(
      "conflict",
      `Browser inspection was not confirmed${reason}. Do not replay a UI mutation without checking the App; ${
        reopenableBrowserFailure(cause)
          ? "after exact cleanup is confirmed, use browser_open for a fresh browser and inspect browser_snapshot before another action."
          : "start a new authorized turn if its browser has ended."
      }`,
    );
  }
}

export async function renewTurnBrowser(
  ctx: BrowserActionContext,
  renewing: Set<string>,
  turnID: string,
  ownerToken: string,
) {
  if (renewing.has(turnID)) return;
  renewing.add(turnID);
  try {
    const [session] = await ctx.database.db
      .select({ id: buildBrowserSession.id })
      .from(buildBrowserSession)
      .where(
        and(
          eq(buildBrowserSession.turnId, turnID),
          eq(buildBrowserSession.ownerId, ownerIdentity(ownerToken)),
          inArray(buildBrowserSession.state, LIVE_BROWSER_STATES),
        ),
      );
    if (!session) return;
    const current = await readBrowserSession(ctx.database, session.id);
    if (!current) return;
    try {
      await dispatchBrowserOperation(ctx, current, ownerToken, "browser-renew");
    } catch (cause) {
      if (isTransientRenewalFailure(cause)) return;
      await ctx.closeSession(current.id, cause);
    }
  } finally {
    renewing.delete(turnID);
  }
}
