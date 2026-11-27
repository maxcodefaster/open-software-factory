import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { BuildBrowserCall } from "#conversation-domain/browser-tools";
import type { createDatabase, DatabaseTransaction } from "#db/client";
import type { createReviewMedia } from "../review/api";
import type { createSubstrateBrowsers } from "../runtime/browser-api";
import { RuntimeParentOperationError } from "../runtime/transport-api";
import type { createAgentTurnStore } from "./turn-store";

export type BrowserControllerDatabase = ReturnType<typeof createDatabase>;
export type BrowserNativeClient = Pick<
  ReturnType<typeof createSubstrateBrowsers>,
  "prepare" | "operation" | "close"
>;
export type BrowserTurnStore = ReturnType<typeof createAgentTurnStore>;
export type BrowserMediaStore = ReturnType<typeof createReviewMedia>;

export type BrowserSessionState = "intended" | "active" | "closing" | "closed";

export type BrowserSession = {
  id: string;
  ordinal: number;
  turnID: string;
  changeID: string;
  attemptID: string;
  generation: number;
  agentSessionID: string;
  ownerID: string;
  state: BrowserSessionState;
};

export type BrowserSessionPhase =
  | { state: "intended"; session: BrowserSession; isReopened: boolean }
  | { state: "active"; session: BrowserSession }
  | { state: "closing"; session: BrowserSession }
  | { state: "closed"; session: BrowserSession };

export type BrowserAuthorizationPurpose = "active" | "reopen" | "facade";

export type BrowserAction =
  | "browser-call"
  | "browser-renew"
  | "browser-recording-start"
  | "browser-recording-finish"
  | "browser-recording-chunk";

export type BrowserOperationCall =
  | BuildBrowserCall
  | { name: "recording_chunk"; arguments: { offset: number } };

export type BrowserDispatchFn = (
  session: BrowserSession,
  ownerToken: string,
  action: BrowserAction,
  call?: BrowserOperationCall,
  signal?: AbortSignal,
) => ReturnType<BrowserNativeClient["operation"]>;

export type ValidateBrowserCurrentIn = (
  sql: DatabaseTransaction,
  session: BrowserSession,
  ownerToken: string,
  purpose?: BrowserAuthorizationPurpose,
) => Promise<string>;

export const LIVE_BROWSER_STATES: BrowserSessionState[] = ["intended", "active"];
export const LIVE_RECORDING_STATES: Array<"intended" | "recording"> = ["intended", "recording"];

export const READ_ONLY_OBSERVATION_CALLS = new Set<BuildBrowserCall["name"]>([
  "browser_snapshot",
  "browser_console",
  "browser_screenshot",
  "browser_wait",
  "browser_http_observations",
]);

export function classifyBrowserSession(session: BrowserSession): BrowserSessionPhase {
  switch (session.state) {
    case "intended":
      return { state: "intended", session, isReopened: session.ordinal > 1 };
    case "active":
      return { state: "active", session };
    case "closing":
      return { state: "closing", session };
    case "closed":
      return { state: "closed", session };
  }
}

export function isLiveBrowserPhase(phase: BrowserSessionPhase): boolean {
  return phase.state === "intended" || phase.state === "active";
}

export function isSessionUsableForPurpose(
  phase: BrowserSessionPhase,
  purpose: BrowserAuthorizationPurpose,
): boolean {
  if (purpose === "facade") return true;
  if (isLiveBrowserPhase(phase)) return true;
  return purpose === "reopen" && phase.state === "closed";
}

export function ownerIdentity(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

export function browserIdentity(turnID: string, ownerID: string, ordinal = 1) {
  const key = `factory-browser-v1:${turnID}:${ownerID}${ordinal > 1 ? `:${ordinal}` : ""}`;
  const hex = createHash("sha256").update(key).digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

export function sessionCapability(secret: string, id: string) {
  return createHmac("sha256", secret).update(`factory-build-browser-v1:${id}`).digest("hex");
}

export function matchesBearer(authorization: string | null, token: string): boolean {
  if (!authorization) return false;
  const expected = `Bearer ${token}`;
  return (
    Buffer.byteLength(authorization) === Buffer.byteLength(expected) &&
    timingSafeEqual(Buffer.from(authorization), Buffer.from(expected))
  );
}

export function buildBrowserOperationPayload(
  session: BrowserSession,
  action: string,
  expiresAt: string,
  call?: BrowserOperationCall,
) {
  return {
    operationId: crypto.randomUUID(),
    action,
    runtimeAttemptId: session.attemptID,
    generation: session.generation,
    data: JSON.stringify({
      sessionId: session.id,
      turnId: session.turnID,
      agentSessionId: session.agentSessionID,
      ownerId: session.ownerID,
      expiresAt,
      call: call ?? { name: "", arguments: {} },
    }),
  };
}

// Exact static Connector failures only. Never forward arbitrary runtime,
// registry, parser or tool output as a user-facing diagnostic.
export const safeBrowserFailures = new Set([
  "browser App is not declared in this Workspace",
  "browser operation does not match its admitted execution scope",
  "browser execution lease is expired or exceeds its bound",
  "browser control connection ended",
  "browser session does not belong to the active execution owner",
  "browser session requires owned cleanup after parent restart; do not replay a UI mutation",
  "browser session already ended; open a fresh browser session",
  "browser session is no longer active",
  "browser renewal does not own this execution",
  "Browser no longer owns this Build execution",
  "Browser execution authority is expiring",
  "Browser requires live Build authority",
  "Browser Build authority changed before dispatch",
  "Browser returned an invalid observation schema",
  "browser container operation was not confirmed",
  "browser primary container inspection was not confirmed",
  "browser primary container no longer owns this Workspace generation",
  "browser container did not retain its exact isolation boundary",
  "browser create outcome could not be recovered by its persisted identity",
  "browser socket/configuration directory unavailable",
  "browser socket directory ownership unavailable",
  "browser App proxy startup exceeded its authority",
  "browser App proxy did not become ready within five seconds",
  "browser tool process failed to start",
  "browser tool outcome is unavailable; do not repeat a UI mutation without checking the App",
  "browser tool exceeded its execution authority or deadline",
  "browser execution authority ended",
  "browser MCP did not report the pinned upstream version",
  "browser MCP initialization was not confirmed",
  "browser App page identity unavailable",
  "browser did not retain the declared App page identity",
  "browser observation exceeds its bounds or has unsupported content",
  "browser checkout context is unavailable",
  "browser checkout mount does not match the assigned shared workspace",
  "browser checkout HEAD could not be established",
  "browser checkout modification state is unavailable",
  "browser screenshot publication was not confirmed",
  "Browser tools preparation was stopped",
  "Browser tools could not prepare the approved image: Sandbox storage is exhausted; release unused compute or retired storage before retrying this work",
  "Browser tools could not prepare the approved image; check registry connectivity and CA trust, then restart the Workspace",
  "Browser tools could not prepare the approved image; check Registry availability and approved access before retrying this work",
  "Browser observation does not match this execution scope",
]);

// An unknown renewal acknowledgement does not confirm authority loss. Only the
// existing ownership heartbeat may try again, through fresh dispatch validation.
// Confirmed Connector errors and all App calls keep their fail-closed behavior.
const transientRenewalFailures = new Set([
  "Runtime parent operation timed out",
  "Runtime parent is not ready",
  "Runtime parent connection changed before dispatch",
  "Runtime parent operation could not be sent",
  "Runtime channel disconnected",
]);

const reopenableFailures = new Set([
  "browser execution authority ended",
  "browser session is no longer active",
  "browser control connection ended",
  "browser session already ended; open a fresh browser session",
  "browser session requires owned cleanup after parent restart; do not replay a UI mutation",
  // A bounded tool wait does not revoke the admitted Build. Its UI outcome is
  // unknown, so only confirmed cleanup plus a new browser_open may recover it.
  // The new browser must still observe a snapshot before another App action.
  "browser tool exceeded its execution authority or deadline",
]);

export function reopenableBrowserFailure(cause: unknown): boolean {
  return (
    (cause instanceof RuntimeParentOperationError && reopenableFailures.has(cause.message)) ||
    (cause instanceof Error &&
      !(cause instanceof RuntimeParentOperationError) &&
      cause.message === "Runtime channel disconnected")
  );
}

export function isTransientRenewalFailure(cause: unknown): boolean {
  return (
    cause instanceof Error &&
    !(cause instanceof RuntimeParentOperationError) &&
    transientRenewalFailures.has(cause.message)
  );
}

export function safeBrowserFailureMessage(cause: unknown): string | null {
  return cause instanceof Error && safeBrowserFailures.has(cause.message) ? cause.message : null;
}
