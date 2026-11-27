import { createSignal } from "solid-js";
import type { AttachmentInput, AttachmentSummary } from "#conversation-domain/attachments";
import type { getAttachmentUsage } from "../server-functions/attachments";
import type { ServerValue } from "../server-functions/result";

export const ACCEPTED_ATTACHMENTS = ".png,.jpg,.jpeg,.webp,.pdf,.docx,.txt,.md,.markdown";
export const ACCEPTED_IMAGES = ".png,.jpg,.jpeg,.webp";
export const BUSY_UPLOAD_MESSAGE = "A file is still uploading. Add the next file when it finishes.";

export type AttachmentPrivacy = "save" | "autosave" | "send" | "personal" | "create" | "feedback";
export type AttachmentLimits = ServerValue<ReturnType<typeof getAttachmentUsage>>["limits"];

export type LimitsState =
  | { kind: "loading" }
  | { kind: "ready"; limits: AttachmentLimits }
  | { kind: "unavailable" };

export type FileTransferState =
  | { kind: "queued" }
  | { kind: "preparing" }
  | { kind: "uploading"; loaded?: number | undefined; total?: number | undefined }
  | { kind: "processing" }
  | { kind: "ready" }
  | { kind: "failed" }
  | { kind: "waiting" };

export type FileTransfer = {
  key: string;
  name: string;
  state: FileTransferState;
};

export type UploadPhase =
  | { kind: "idle"; status?: string | undefined; error?: string | undefined }
  | { kind: "uploading"; status: string; error?: string | undefined }
  | { kind: "retryable"; error: string; retryFiles: File[] };

export type UploadDraft = {
  phase: UploadPhase;
  files: AttachmentSummary[];
  queued: AttachmentSummary[];
  attempts: Map<string, string>;
  transfers: FileTransfer[];
};

export function emptyUploadDraft(): UploadDraft {
  return {
    phase: { kind: "idle" },
    files: [],
    queued: [],
    attempts: new Map(),
    transfers: [],
  };
}

export function isDraftBusy(draft: UploadDraft): boolean {
  return draft.phase.kind === "uploading";
}

export function draftStatus(draft: UploadDraft, hasPreparedFiles: boolean): string {
  if (!isDraftBusy(draft) && !hasPreparedFiles) return "";
  if (draft.phase.kind === "uploading") return draft.phase.status;
  if (draft.phase.kind === "idle") return draft.phase.status ?? "";
  return "";
}

export function draftError(draft: UploadDraft): string {
  return draft.phase.error ?? "";
}

export function draftRetryFiles(draft: UploadDraft): File[] {
  return draft.phase.kind === "retryable" ? draft.phase.retryFiles : [];
}

export type UploadDraftRegistry = ReturnType<typeof createUploadDraftRegistry>;

export function createUploadDraftRegistry() {
  const [drafts, setDrafts] = createSignal<Record<string, UploadDraft>>({});
  return {
    get: (key: string) => drafts()[key] ?? emptyUploadDraft(),
    update(key: string, patch: Partial<UploadDraft>) {
      setDrafts((current) => ({
        ...current,
        [key]: { ...(current[key] ?? emptyUploadDraft()), ...patch },
      }));
    },
    patchPhase(key: string, updater: (phase: UploadPhase) => UploadPhase) {
      setDrafts((current) => {
        const draft = current[key] ?? emptyUploadDraft();
        return { ...current, [key]: { ...draft, phase: updater(draft.phase) } };
      });
    },
    setError(key: string, error: string) {
      this.patchPhase(key, (phase) => ({ ...phase, error }));
    },
    clear(key: string) {
      setDrafts((current) => {
        const next = { ...current };
        delete next[key];
        return next;
      });
    },
  };
}

export function endSentence(text: string): string {
  return /[.!?]$/.test(text.trim()) ? text.trim() : `${text.trim()}.`;
}

export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  return bytes >= 1024 * 1024
    ? `${+(bytes / 1024 / 1024).toFixed(1)} MiB`
    : `${Math.max(1, Math.ceil(bytes / 1024))} KiB`;
}

function formatFileUsage(bytes: number, maximum: number): string {
  const mib = 1024 * 1024;
  if (maximum < mib) return `${formatFileSize(bytes)} / ${formatFileSize(maximum)}`;
  const used = bytes > 0 && bytes < mib / 10 ? "<0.1" : `${+(bytes / mib).toFixed(1)}`;
  return `${used} / ${formatFileSize(maximum)}`;
}

export function detectAttachmentFileType(file: File): AttachmentInput["mediaType"] | undefined {
  const extension = file.name.split(".").at(-1)?.toLowerCase();
  return (
    {
      png: "image/png",
      jpg: "image/jpeg",
      jpeg: "image/jpeg",
      webp: "image/webp",
      pdf: "application/pdf",
      docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      txt: "text/plain",
      md: "text/markdown",
      markdown: "text/markdown",
    } as Record<string, AttachmentInput["mediaType"]>
  )[extension ?? ""];
}

export function formatSizeRestrictions(state: LimitsState, isMessage: boolean): string {
  if (state.kind === "ready")
    return ` · ${formatFileSize(state.limits.fileBytes)} per file${isMessage ? ` · ${formatFileSize(state.limits.messageBytes)} total` : ""}`;
  return state.kind === "unavailable" ? " · Size limits unavailable" : " · Loading size limits…";
}

export function formatPrivacyNotice(
  privacy: AttachmentPrivacy | undefined,
  draftId: string | undefined,
): string {
  const boundary = privacy ?? (draftId ? "create" : "save");
  return {
    save: "Saving this document shares its files with the Project.",
    autosave: "Changes save automatically and share files with the Project.",
    send: "New files stay private until this message is sent.",
    personal: "Only you can access these files, including after sending.",
    create: "New files stay private until this Ticket is created.",
    feedback: "New files stay private until this feedback is saved.",
  }[boundary];
}

export function formatSelectionSummary(input: {
  count: number;
  queuedCount: number;
  uploaded: AttachmentSummary[];
  limitsState: LimitsState;
  sizeRestrictions: string;
}): string {
  if (!input.count)
    return input.queuedCount
      ? `${input.queuedCount} ready to attach`
      : input.sizeRestrictions.replace(/^ · /, "");
  const bytes = input.uploaded.reduce((sum, file) => sum + file.bytes, 0);
  const maximum = input.limitsState.kind === "ready" ? input.limitsState.limits : undefined;
  const details =
    input.uploaded.length < input.count
      ? "Loading details…"
      : maximum
        ? formatFileUsage(bytes, maximum.messageBytes)
        : formatFileSize(bytes);
  return `${input.count} ${input.count === 1 ? "file" : "files"} · ${details}${input.queuedCount ? ` · ${input.queuedCount} ready to attach` : ""}`;
}
