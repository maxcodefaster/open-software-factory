import type { RepositoryMirror, RepositoryMirrorProject } from "#project-domain/repository-mirror";

export type ProjectsLoadState =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "loaded"; projects: RepositoryMirrorProject[]; selectedID: string };

export type MirrorActionState =
  | { kind: "idle"; notice?: string | undefined; error?: string | undefined }
  | { kind: "loading" }
  | { kind: "syncing" }
  | { kind: "acknowledging" }
  | { kind: "adding" }
  | {
      kind: "confirming-remove";
      remoteName: string;
      notice?: string | undefined;
      error?: string | undefined;
    }
  | { kind: "removing"; remoteName: string };

export type MirrorDraftState = {
  open: boolean;
  target: string;
  username: string;
  token: string;
  confirmed: boolean;
};

export function emptyMirrorDraft(open = false): MirrorDraftState {
  return { open, target: "", username: "", token: "", confirmed: false };
}

export function clearMirrorToken(draft: MirrorDraftState): MirrorDraftState {
  return draft.token ? { ...draft, token: "" } : draft;
}

export function isMirrorBusy(action: MirrorActionState): boolean {
  return (
    action.kind === "loading" ||
    action.kind === "syncing" ||
    action.kind === "acknowledging" ||
    action.kind === "adding" ||
    action.kind === "removing"
  );
}

export function mirrorActionError(action: MirrorActionState): string {
  return action.kind === "idle" || action.kind === "confirming-remove" ? (action.error ?? "") : "";
}

export function mirrorActionNotice(action: MirrorActionState): string {
  return action.kind === "idle" || action.kind === "confirming-remove" ? (action.notice ?? "") : "";
}

export function confirmingRemoteName(action: MirrorActionState): string | undefined {
  return action.kind === "confirming-remove" || action.kind === "removing"
    ? action.remoteName
    : undefined;
}

export function formatMirrorTimestamp(value: string | null): string {
  return value ? new Date(value).toLocaleString() : "No attempt observed";
}

export function describeMirrorStatus(mirror: RepositoryMirror): string {
  if (!mirror.lastAttempt) return "No successful synchronization confirmed yet.";
  return mirror.failed
    ? "Last attempt failed. Check the target's access and protection rules."
    : "Last observed attempt succeeded.";
}
