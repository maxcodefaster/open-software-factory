import type { DeveloperIDEState } from "#workspace-domain/developer-ide";
import { isUnreachable } from "../command-error";

export type EditorAttachment = { epoch: number; url: string };

export type EditorPhase =
  | {
      kind: "preparing";
      attachment?: EditorAttachment | undefined;
      state?: DeveloperIDEState | undefined;
      reconnecting: boolean;
    }
  | {
      kind: "loading-frame";
      attachment: EditorAttachment;
      state?: DeveloperIDEState | undefined;
      slow: boolean;
      reconnecting: boolean;
    }
  | {
      kind: "ready";
      attachment: EditorAttachment;
      selectedWorkspaceID?: string | undefined;
      state?: DeveloperIDEState | undefined;
    }
  | {
      kind: "restarting";
      attachment?: EditorAttachment | undefined;
      state?: DeveloperIDEState | undefined;
    }
  | {
      kind: "failed";
      attachment?: EditorAttachment | undefined;
      state?: DeveloperIDEState | undefined;
      message: string;
      wasReady?: boolean | undefined;
      selectedWorkspaceID?: string | undefined;
    };

export const TERMINAL_STATES = new Set(["failed", "stopped", "stop-intended"]);

export function initialEditorPhase(): EditorPhase {
  return { kind: "preparing", reconnecting: false };
}

export function resetEditorForScopeChange(prev: EditorPhase): EditorPhase {
  if (prev.kind === "restarting")
    return { kind: "preparing", attachment: prev.attachment, reconnecting: false };
  if (prev.kind === "loading-frame" || prev.kind === "preparing")
    return { ...prev, state: undefined, reconnecting: false };
  return { ...prev, state: undefined };
}

export function resumeEditorFromFailure(prev: EditorPhase): EditorPhase {
  if (prev.kind !== "failed") return prev;
  if (prev.wasReady && prev.attachment)
    return {
      kind: "ready",
      attachment: prev.attachment,
      selectedWorkspaceID: prev.selectedWorkspaceID,
      state: prev.state,
    };
  return prev.attachment
    ? {
        kind: "loading-frame",
        attachment: prev.attachment,
        state: prev.state,
        slow: false,
        reconnecting: false,
      }
    : { kind: "preparing", state: prev.state, reconnecting: false };
}

export function markEditorFailed(prev: EditorPhase, message: string): EditorPhase {
  return {
    kind: "failed",
    attachment: prev.attachment,
    state: prev.state,
    message,
    wasReady: prev.kind === "ready" || (prev.kind === "failed" && prev.wasReady),
    selectedWorkspaceID:
      prev.kind === "ready" || prev.kind === "failed" ? prev.selectedWorkspaceID : undefined,
  };
}

export function markEditorReadyMessage(prev: EditorPhase): EditorPhase {
  return prev.attachment
    ? {
        kind: "ready",
        attachment: prev.attachment,
        state: prev.state,
        selectedWorkspaceID: prev.kind === "ready" ? prev.selectedWorkspaceID : undefined,
      }
    : prev;
}

export function markEditorWorkspaceSelected(
  prev: EditorPhase,
  workspaceID: string | undefined,
): EditorPhase {
  return prev.kind === "ready" ? { ...prev, selectedWorkspaceID: workspaceID } : prev;
}

export function markEditorRestarting(prev: EditorPhase): EditorPhase {
  return { kind: "restarting", attachment: prev.attachment, state: prev.state };
}

export function finishEditorRestarting(prev: EditorPhase): EditorPhase {
  return prev.kind === "restarting"
    ? { kind: "preparing", attachment: prev.attachment, state: prev.state, reconnecting: false }
    : prev;
}

export function markEditorRestartFailed(prev: EditorPhase, message: string): EditorPhase {
  return { kind: "failed", attachment: prev.attachment, state: prev.state, message };
}

export function setEditorReconnectingPhase(prev: EditorPhase, reconnecting: boolean): EditorPhase {
  return prev.kind === "preparing" || prev.kind === "loading-frame"
    ? { ...prev, reconnecting }
    : prev;
}

export function setEditorFrameReconnecting(prev: EditorPhase, reconnecting: boolean): EditorPhase {
  return prev.kind === "loading-frame" ? { ...prev, reconnecting } : prev;
}

export function setEditorSlowPhase(prev: EditorPhase, slow: boolean): EditorPhase {
  return prev.kind === "loading-frame" && prev.slow !== slow ? { ...prev, slow } : prev;
}

export function applyEditorObservedReady(
  prev: EditorPhase,
  epoch: number,
  state: DeveloperIDEState,
): { phase: EditorPhase; changedEpoch: boolean } {
  if (prev.attachment?.epoch === epoch) {
    return {
      changedEpoch: false,
      phase:
        prev.kind === "preparing"
          ? {
              kind: "loading-frame",
              attachment: prev.attachment,
              state,
              slow: false,
              reconnecting: false,
            }
          : { ...prev, state },
    };
  }
  return {
    changedEpoch: true,
    phase: {
      kind: "loading-frame",
      attachment: {
        epoch,
        url: `/api/developer-ide/access?embed=1&epoch=${epoch}`,
      },
      state,
      slow: false,
      reconnecting: false,
    },
  };
}

export function applyEditorObservedState(prev: EditorPhase, state: DeveloperIDEState): EditorPhase {
  return { ...prev, state };
}

export function editorSelectedWorkspace(phase: EditorPhase): string | undefined {
  return phase.kind === "ready" ? phase.selectedWorkspaceID : undefined;
}

export function editorErrorMessage(phase: EditorPhase): string {
  return phase.kind === "failed" ? phase.message : "";
}

export function editorIsSlow(phase: EditorPhase): boolean {
  return phase.kind === "loading-frame" && phase.slow;
}

export function editorPlaceholderMessage(phase: EditorPhase): string {
  if (phase.kind === "restarting") return "Restarting your editor…";
  if (phase.kind === "failed") return phase.message;
  if ((phase.kind === "preparing" || phase.kind === "loading-frame") && phase.reconnecting)
    return "Reconnecting…";
  return "Preparing your editor…";
}

export function editorFrameOverlayMessage(phase: EditorPhase): string {
  if (phase.kind === "restarting") return "Restarting your editor…";
  if (phase.kind === "failed") return phase.message;
  if ((phase.kind === "preparing" || phase.kind === "loading-frame") && phase.reconnecting)
    return "Reconnecting…";
  if (phase.kind === "loading-frame" && phase.slow)
    return "Your editor is still opening. You can wait or retry the connection.";
  return "Opening your editor…";
}

export async function tolerant<T>(
  signal: AbortSignal,
  call: () => Promise<T>,
  onReconnecting: (value: boolean) => void,
  wait: (signal: AbortSignal) => Promise<void>,
): Promise<T> {
  const started = performance.now();
  for (;;) {
    try {
      const value = await call();
      onReconnecting(false);
      return value;
    } catch (cause) {
      if (!isUnreachable(cause) || signal.aborted || performance.now() - started > 60_000) {
        onReconnecting(false);
        throw cause;
      }
      onReconnecting(true);
      await wait(signal);
    }
  }
}
