import type { WriterView } from "../agent/contracts";
import { plainErrorMessage } from "../command-error";
import { writerStatusText } from "../writer-status-label";

export type AvailableWorkspace = {
  workspaceID: string;
  ownerID: string | null;
  name: string;
  kind: string;
  collaborative: boolean;
};

export type SharingMember = {
  userID: string;
  name: string;
  permission: "observe" | "collaborate" | null;
  version: number;
};

export type SharingSnapshot = {
  workspaceID: string;
  members: SharingMember[];
};

export type CollaborationState = {
  ownerID: string | null;
  kind: string;
  collaborative: boolean;
  participants: { participantID: string; name: string; kind: string }[];
};

export type WorkspaceAccessSnapshot =
  | { kind: "loading" }
  | {
      kind: "personal";
      collaboration: CollaborationState;
    }
  | {
      kind: "ticket";
      collaboration: CollaborationState;
      source?: { state: string; failure: string | null } | undefined;
      writer?: WriterView | undefined;
      computeState?: string | undefined;
      accessError: string;
    }
  | {
      kind: "error";
      collaboration?: CollaborationState | undefined;
      accessError: string;
    };

export type PendingWorkspaceSubmission = {
  requestID: string;
  workspaceID: string;
  expectedHead: string;
  expectedRemoteHead: string;
  message: string;
};

export type SharingDialogState =
  | {
      kind: "closed";
      phase: "idle" | "opening" | "enabling" | "submitting";
      error: string;
      submitted: string;
    }
  | {
      kind: "open";
      phase: "idle" | "deciding";
      sharing: SharingSnapshot;
      error: string;
      submitted: string;
    };

export const INITIAL_SHARING_DIALOG_STATE: SharingDialogState = {
  kind: "closed",
  phase: "idle",
  error: "",
  submitted: "",
};

export function isSharingBusy(state: SharingDialogState): boolean {
  return state.phase !== "idle";
}

export function isSharingOpen(state: SharingDialogState): boolean {
  return state.kind === "open";
}

export function sharingMembers(state: SharingDialogState): SharingMember[] {
  return state.kind === "open" ? state.sharing.members : [];
}

export function beginClosedDialogAction(
  state: SharingDialogState,
  phase: "opening" | "enabling" | "submitting",
): SharingDialogState {
  return { kind: "closed", phase, error: "", submitted: state.submitted };
}

export function openSharingDialog(
  state: SharingDialogState,
  sharing: SharingSnapshot,
): SharingDialogState {
  return { kind: "open", phase: "idle", sharing, error: "", submitted: state.submitted };
}

export function beginMemberDecision(state: SharingDialogState): SharingDialogState {
  if (state.kind !== "open") return state;
  return { ...state, phase: "deciding", error: "" };
}

export function finishMemberDecision(
  state: SharingDialogState,
  sharing: SharingSnapshot,
): SharingDialogState {
  return { kind: "open", phase: "idle", sharing, error: "", submitted: state.submitted };
}

export function settleDialogIdle(
  state: SharingDialogState,
  patch?: { error?: string; submitted?: string },
): SharingDialogState {
  return {
    ...state,
    phase: "idle",
    ...(patch?.error !== undefined ? { error: patch.error } : {}),
    ...(patch?.submitted !== undefined ? { submitted: patch.submitted } : {}),
  };
}

export function closeSharingDialog(state: SharingDialogState): SharingDialogState {
  return {
    kind: "closed",
    phase: "idle",
    error: state.error,
    submitted: state.submitted,
  };
}

export function collaborationFromAccess(
  access: WorkspaceAccessSnapshot,
): CollaborationState | undefined {
  return access.kind === "loading" ? undefined : access.collaboration;
}

export function accessErrorFromAccess(access: WorkspaceAccessSnapshot): string {
  return access.kind === "ticket" || access.kind === "error" ? access.accessError : "";
}

export function actionUnavailableReason(
  workspaceID: string | undefined,
  snap: WorkspaceAccessSnapshot,
): string {
  if (!workspaceID) return "Choose a Workspace to check file access.";
  if (snap.kind === "loading")
    return "Workspace access is not confirmed. Writing authority has not changed.";
  if (snap.kind === "error") {
    if (!snap.collaboration)
      return "Workspace access is not confirmed. Writing authority has not changed.";
    if (snap.collaboration.kind !== "ticket") return "";
    return "Editing status unavailable. Writing authority has not changed.";
  }
  if (snap.kind === "personal") return "";
  const current = snap.writer;
  if (!current) return "Editing status unavailable. Writing authority has not changed.";
  if (current.stopPending) return "Agent Stop is unconfirmed. Check Stop in this Ticket.";
  if (current.state === "agent" || current.state === "agent-preparing")
    return `${writerStatusText(current)}. Shared editing and submission need a confirmed human writer.`;
  if (current.state === "handoff")
    return "Editing handoff is not confirmed. Writing authority has not changed.";
  if (current.state !== "human" || !current.canWrite)
    return "Take over editing in this Ticket before enabling shared editing or submitting saved source.";
  if (!snap.source)
    return "File access is unavailable. Keep your editor buffer and retry the file access check.";
  if (snap.source.state === "paused")
    return "Source is retained in paused compute. Open current files to resume it before shared editing or submission. Your editor buffers are kept.";
  if (snap.source.state !== "ready" || snap.source.failure)
    return snap.computeState === "starting" || snap.computeState === "resuming"
      ? "Compute is starting or resuming. File access is not ready; keep your editor buffer."
      : "File access is not ready. The current Source may still be starting or unreachable; keep your editor buffer.";
  return "";
}

export function submissionUnavailableReason(
  workspaceID: string | undefined,
  snap: WorkspaceAccessSnapshot,
): string {
  const unavailable = actionUnavailableReason(workspaceID, snap);
  if (unavailable) return unavailable;
  return snap.kind === "ticket" && snap.computeState !== "ready"
    ? "The Ticket Workspace must be running before submitting saved source. Starting compute is a separate action."
    : "";
}

export function workspaceStatusText(snap: WorkspaceAccessSnapshot): string {
  if (snap.kind === "loading" || (snap.kind === "error" && !snap.collaboration))
    return "Checking Workspace access…";
  if (
    (snap.kind === "ticket" && !snap.writer) ||
    (snap.kind === "error" && snap.collaboration?.kind === "ticket")
  )
    return "Editing status unavailable";
  const current = snap.collaboration;
  return current?.collaborative
    ? current.participants.map((peer) => peer.name).join(", ") || "Shared editing enabled"
    : "Private editing";
}

export type WorkspaceAccessReaders = {
  readAvailable(projectID: string, signal: AbortSignal): Promise<AvailableWorkspace[]>;
  readCollaboration(
    workspaceID: string,
    signal: AbortSignal,
  ): Promise<CollaborationState & { workspaceID: string }>;
  readSource(
    workspaceID: string,
    signal: AbortSignal,
  ): Promise<{ workspaceID: string; state: string; failure: string | null }>;
  readAttempts(
    projectID: string,
    signal: AbortSignal,
  ): Promise<{
    attempts: {
      workspaceId?: string | null | undefined;
      projectId: string;
      changeId?: string | null | undefined;
      state: string;
    }[];
  }>;
  readWriter(changeID: string, signal: AbortSignal): Promise<WriterView>;
};

export async function refreshWorkspaceAccess(options: {
  projectID: string | undefined;
  workspaceID: string | undefined;
  isCurrent(): boolean;
  readers: WorkspaceAccessReaders;
  onAvailable(value: AvailableWorkspace[]): void;
  onListingError(message: string): void;
  onAccess(update: (prev: WorkspaceAccessSnapshot) => WorkspaceAccessSnapshot): void;
}) {
  const { projectID, workspaceID, isCurrent, readers } = options;
  const signal = AbortSignal.timeout(4_000);
  const availableRead = projectID
    ? readers
        .readAvailable(projectID, signal)
        .then((value) => {
          if (isCurrent()) {
            options.onAvailable(value);
            options.onListingError("");
          }
        })
        .catch((cause) => {
          if (isCurrent())
            options.onListingError(
              cause instanceof Error
                ? plainErrorMessage(cause.message)
                : "Workspace listing is unavailable.",
            );
        })
    : Promise.resolve();
  if (workspaceID) {
    let observedCollaboration: CollaborationState | undefined;
    try {
      const value = await readers.readCollaboration(workspaceID, signal);
      if (value.workspaceID !== workspaceID)
        throw new Error("Workspace access changed. Check the selected Workspace again.");
      observedCollaboration = value;
      if (value.kind === "ticket") {
        if (isCurrent()) {
          options.onAccess((prev) =>
            prev.kind === "ticket"
              ? { ...prev, collaboration: value }
              : { kind: "ticket", collaboration: value, accessError: "" },
          );
        }
        if (!projectID) throw new Error("Select the Ticket Project to check writing authority.");
        let sourceError = "";
        const [files, attempts] = await Promise.all([
          readers.readSource(workspaceID, signal).catch((cause) => {
            sourceError =
              cause instanceof Error
                ? plainErrorMessage(cause.message)
                : "File access is unavailable.";
            return undefined;
          }),
          readers.readAttempts(projectID, signal),
        ]);
        const attempt = attempts.attempts.find(
          (row) => row.workspaceId === workspaceID && row.projectId === projectID,
        );
        if (!attempt?.changeId) throw new Error("Ticket writing authority is unavailable.");
        const editing = await readers.readWriter(attempt.changeId, signal);
        if (isCurrent()) {
          options.onAccess(() => ({
            kind: "ticket",
            collaboration: value,
            source: files?.workspaceID === workspaceID ? files : undefined,
            writer: editing,
            computeState: attempt.state,
            accessError: files
              ? files.workspaceID === workspaceID
                ? ""
                : "File access returned a different Workspace."
              : sourceError,
          }));
        }
      } else if (isCurrent()) {
        options.onAccess(() => ({ kind: "personal", collaboration: value }));
      }
    } catch (cause) {
      if (isCurrent()) {
        options.onAccess(() => ({
          kind: "error",
          collaboration: observedCollaboration,
          accessError:
            cause instanceof Error
              ? plainErrorMessage(cause.message)
              : "Workspace access is unavailable.",
        }));
      }
    }
  }
  await availableRead;
}
