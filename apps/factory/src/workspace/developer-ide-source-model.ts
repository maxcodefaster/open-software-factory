import type { WorkspaceSourceState } from "#workspace-domain/source";
import { plainErrorMessage } from "../command-error";
import type { WorkspaceSourceView } from "./contracts";
import { TERMINAL_STATES } from "./developer-ide-model";

export type SourcePhase =
  | { kind: "idle"; checks: number; checkMessage: string }
  | { kind: "starting-selection"; checks: number; checkMessage: string }
  | {
      kind: "observing";
      workspaceID: string;
      state?: WorkspaceSourceState | undefined;
      reconnecting: boolean;
      checks: number;
      checkMessage: string;
    }
  | {
      kind: "checking";
      workspaceID: string;
      state?: WorkspaceSourceState | undefined;
      checks: number;
      checkMessage: string;
    }
  | {
      kind: "available";
      workspaceID: string;
      state: WorkspaceSourceState;
      checks: number;
      checkMessage: string;
    }
  | {
      kind: "unavailable";
      workspaceID?: string | undefined;
      state?: WorkspaceSourceState | undefined;
      error: string;
      checks: number;
      checkMessage: string;
    };

export function initialSourcePhase(): SourcePhase {
  return { kind: "idle", checks: 0, checkMessage: "" };
}

export function resetSourceToIdle(prev: SourcePhase, resetChecks: boolean): SourcePhase {
  return resetChecks
    ? { kind: "idle", checks: 0, checkMessage: "" }
    : { kind: "idle", checks: prev.checks, checkMessage: prev.checkMessage };
}

export function beginSourceObservation(
  prev: SourcePhase,
  workspaceID: string,
  resetChecks: boolean,
): SourcePhase {
  return {
    kind: "observing",
    workspaceID,
    reconnecting: false,
    checks: resetChecks ? 0 : prev.checks,
    checkMessage: resetChecks ? "" : prev.checkMessage,
  };
}

export function setSourceReconnectingPhase(
  prev: SourcePhase,
  workspaceID: string,
  reconnecting: boolean,
): SourcePhase {
  return prev.kind === "observing" && prev.workspaceID === workspaceID
    ? { ...prev, reconnecting }
    : prev;
}

export function beginSourceCheck(
  prev: SourcePhase,
  workspaceID: string,
  check: number,
): SourcePhase {
  return {
    kind: "checking",
    workspaceID,
    state: "state" in prev ? prev.state : undefined,
    checks: check,
    checkMessage: `File access check ${check}: checking the current Source…`,
  };
}

export function finishSourceCheck(prev: SourcePhase): SourcePhase {
  return prev.kind === "checking"
    ? { kind: "idle", checks: prev.checks, checkMessage: prev.checkMessage }
    : prev;
}

export function applySourceObserved(
  prev: SourcePhase,
  workspaceID: string,
  source: WorkspaceSourceView,
): { phase: SourcePhase; done: boolean } {
  // A paused Source retains this Workspace's files in its original Actor.
  // Select it now; only current-file requests may demand a native wake.
  if ((source.state === "ready" || source.state === "paused") && !source.failure) {
    return {
      done: true,
      phase: {
        kind: "available",
        workspaceID,
        state: source.state,
        checks: prev.checks,
        checkMessage: "",
      },
    };
  }
  if (TERMINAL_STATES.has(source.state)) {
    return {
      done: true,
      phase: {
        kind: "unavailable",
        workspaceID,
        state: source.state,
        error: plainErrorMessage(
          source.failure ?? "Workspace files are stopped. Reopen this Workspace to prepare them.",
        ),
        checks: prev.checks,
        checkMessage: prev.checkMessage,
      },
    };
  }
  // An unavailable owner needs an explicit check, not repeated polling
  // presented as preparation or a silent attempt to change its writer.
  if (source.failure) {
    return {
      done: true,
      phase: {
        kind: "unavailable",
        workspaceID,
        state: source.state,
        error: plainErrorMessage(source.failure),
        checks: prev.checks,
        checkMessage: prev.checkMessage,
      },
    };
  }
  return {
    done: false,
    phase: {
      kind: "observing",
      workspaceID,
      state: source.state,
      reconnecting: false,
      checks: prev.checks,
      checkMessage: prev.checkMessage,
    },
  };
}

export function applySourceChecked(
  workspaceID: string,
  source: WorkspaceSourceView,
  check: number,
): { phase: SourcePhase; retryObservation: boolean } {
  if ((source.state === "ready" || source.state === "paused") && !source.failure) {
    return {
      retryObservation: false,
      phase: {
        kind: "available",
        workspaceID,
        state: source.state,
        checks: check,
        checkMessage: "",
      },
    };
  }
  const checkMessage = `File access check ${check}: still unavailable. No work was restarted.`;
  const error =
    plainErrorMessage(source.failure ?? "") ||
    (TERMINAL_STATES.has(source.state)
      ? "Workspace file access is stopped or failed. Keep your editor buffer."
      : "");
  if (error) {
    return {
      retryObservation: false,
      phase: {
        kind: "unavailable",
        workspaceID,
        state: source.state,
        error,
        checks: check,
        checkMessage,
      },
    };
  }
  return {
    retryObservation: true,
    phase: {
      kind: "observing",
      workspaceID,
      state: source.state,
      reconnecting: false,
      checks: check,
      checkMessage,
    },
  };
}

export function markSourceUnavailable(
  prev: SourcePhase,
  workspaceID: string | undefined,
  error: string,
  options?: { checks?: number; checkMessage?: string; preserveState?: boolean },
): SourcePhase {
  return {
    kind: "unavailable",
    ...(workspaceID !== undefined ? { workspaceID } : {}),
    ...(options?.preserveState ? { state: "state" in prev ? prev.state : undefined } : {}),
    error,
    checks: options?.checks ?? prev.checks,
    checkMessage: options?.checkMessage ?? prev.checkMessage,
  };
}

export function beginStartingSelection(prev: SourcePhase): SourcePhase {
  return { kind: "starting-selection", checks: prev.checks, checkMessage: prev.checkMessage };
}

export function finishStartingSelection(prev: SourcePhase): SourcePhase {
  return prev.kind === "starting-selection"
    ? { kind: "idle", checks: prev.checks, checkMessage: prev.checkMessage }
    : prev;
}

export function sourceAvailableWorkspace(phase: SourcePhase): string | undefined {
  return phase.kind === "available" ? phase.workspaceID : undefined;
}

export function sourceObservedState(phase: SourcePhase): WorkspaceSourceState | undefined {
  return "state" in phase ? phase.state : undefined;
}

export function sourceErrorMessage(phase: SourcePhase): string {
  return phase.kind === "unavailable" ? phase.error : "";
}

export function sourceWaitDetailMessage(state: WorkspaceSourceState | undefined): string {
  if (state === "paused") return "Selecting your Workspace; current file access may resume compute";
  if (state === "ready") return "Selecting Workspace files in the editor";
  if (state === "preparing" || state === "create-intended") return "File access is still preparing";
  return "Checking file access";
}

export function sourceAccessMessage(message: string) {
  const plain = plainErrorMessage(message);
  return plain ===
    "The current Source owner is frozen or unavailable. Compute was not started; keep your editor buffer."
    ? "File access is not ready. The Workspace may still be starting or reconnecting. Keep your unsaved edits."
    : plain;
}
