import {
  attachmentIDs,
  attachmentMarkdown,
  attachmentSummary,
  attachmentURL,
} from "#conversation-domain/attachments";
import { apiUpload } from "../api-client";
import { plainErrorMessage } from "../command-error";
import {
  beginAttachment,
  getAttachmentMetadata,
  getAttachmentUsage,
} from "../server-functions/attachments";
import { serverCall } from "../server-functions/result";
import {
  type AttachmentLimits,
  BUSY_UPLOAD_MESSAGE,
  detectAttachmentFileType,
  endSentence,
  type FileTransfer,
  type FileTransferState,
  formatFileSize,
  type UploadDraftRegistry,
} from "./upload-state";

export async function executeAttachmentUpload(input: {
  files: File[];
  retry: boolean;
  projectId: string;
  draftId: string | undefined;
  key: string;
  isMessage: boolean;
  content: string;
  drafts: UploadDraftRegistry;
  beginScopeUpload?: (() => () => void) | undefined;
  prepare(): (markdown: string) => void;
  isActive(): boolean;
  onLimits(limits: AttachmentLimits): void;
  onFinished(): void;
}): Promise<void> {
  const { files, retry, projectId, draftId, key, isMessage, drafts } = input;
  const referenceIDs = attachmentIDs(input.content);
  const insert = input.prepare();
  const finish = input.beginScopeUpload?.();
  const attempts = retry ? new Map(drafts.get(key).attempts) : new Map<string, string>();
  const transfers: FileTransfer[] = files.map((file) => ({
    key: crypto.randomUUID(),
    name: file.name,
    state: { kind: "queued" },
  }));
  function setTransfer(index: number, state: FileTransferState) {
    const current = transfers[index];
    if (!current) return;
    transfers[index] = { ...current, state };
    drafts.update(key, { transfers: [...transfers] });
  }
  function setStatus(status: string) {
    drafts.patchPhase(key, (phase) =>
      phase.kind === "uploading" ? { ...phase, status } : { kind: "uploading", status },
    );
  }
  let currentFile = 0;
  const rejected: string[] = [];
  drafts.update(key, {
    phase: { kind: "uploading", status: "" },
    attempts,
    transfers,
  });
  try {
    const usage = await serverCall(getAttachmentUsage({ data: [projectId] }));
    if (input.isActive()) input.onLimits(usage.limits);
    if (!usage.configured)
      throw new Error(
        "Factory file storage is unavailable. Ask your administrator to check the installation's storage service.",
      );
    const existing = isMessage
      ? await Promise.all(
          referenceIDs.map(
            (id) =>
              drafts.get(key).files.find((item) => item.id === id) ??
              serverCall(getAttachmentMetadata({ data: [id] })),
          ),
        )
      : [];
    let messageBytes = existing.reduce((total, item) => total + item.bytes, 0);
    for (const [index, file] of files.entries()) {
      currentFile = index;
      setTransfer(index, { kind: "preparing" });
      const reject = (reason: string) => {
        setTransfer(index, { kind: "failed" });
        rejected.push(`${file.name} was not attached. ${reason}`);
        drafts.setError(
          key,
          `${rejected.join(" ")} Your text and earlier attachments are unchanged.`,
        );
      };
      if (file.size === 0) {
        reject("The file is empty.");
        continue;
      }
      if (file.size > usage.limits.fileBytes) {
        reject(`Each file must be at most ${formatFileSize(usage.limits.fileBytes)}.`);
        continue;
      }
      const mediaType = detectAttachmentFileType(file);
      if (!mediaType) {
        reject("Use PNG, JPEG, WebP, PDF, DOCX, TXT or Markdown.");
        continue;
      }
      if (isMessage && messageBytes + file.size > usage.limits.messageBytes) {
        reject(
          `Attachments must total at most ${formatFileSize(usage.limits.messageBytes)} per message.`,
        );
        continue;
      }
      setStatus(`Preparing upload for ${file.name}…`);
      const bytes = await file.arrayBuffer();
      const sha256 = [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))]
        .map((value) => value.toString(16).padStart(2, "0"))
        .join("");
      const attemptKey = `${projectId}:${file.name}:${sha256}`;
      const id = attempts.get(attemptKey) ?? crypto.randomUUID();
      attempts.set(attemptKey, id);
      const initial = await serverCall(
        beginAttachment({
          data: [
            {
              id,
              projectId,
              name: file.name,
              mediaType,
              bytes: file.size,
              sha256,
              ...(draftId ? { draftId } : {}),
            },
          ],
        }),
      );
      setTransfer(index, { kind: "uploading" });
      setStatus(`Uploading ${file.name}…`);
      const ready =
        initial.state === "ready"
          ? initial
          : await apiUpload(attachmentSummary, attachmentURL(id), {
              body: bytes,
              mediaType,
              onProgress: (loaded, total) =>
                setTransfer(index, { kind: "uploading", loaded, total }),
              onTransferred: () => {
                setTransfer(index, { kind: "processing" });
                setStatus(`Preparing ${file.name} for agent context…`);
              },
            });
      if (ready.state !== "ready")
        throw new Error(
          ready.failure ?? "File processing is not confirmed. Retry the same file request.",
        );
      messageBytes += ready.bytes;
      const current = drafts.get(key);
      const active = input.isActive();
      if (active) insert(attachmentMarkdown(ready));
      attempts.delete(attemptKey);
      setTransfer(index, { kind: "ready" });
      drafts.update(key, {
        files: [...current.files.filter((item) => item.id !== ready.id), ready],
        queued: active ? current.queued : [...current.queued, ready],
        phase:
          current.phase.kind === "uploading"
            ? { ...current.phase, status: `${file.name} is ready.` }
            : { kind: "uploading", status: `${file.name} is ready.` },
      });
    }
  } catch (cause) {
    for (let index = currentFile; index < transfers.length; index++)
      setTransfer(index, index === currentFile ? { kind: "failed" } : { kind: "waiting" });
    const message = `${files[currentFile]?.name ?? "File"} was not attached. ${endSentence(
      cause instanceof Error
        ? plainErrorMessage(cause.message)
        : "Upload failed. Choose the file again to retry.",
    )} Your text and earlier attachments are unchanged.`;
    drafts.update(key, {
      phase: attempts.size
        ? { kind: "retryable", error: message, retryFiles: files.slice(currentFile) }
        : { kind: "idle", error: message },
    });
  } finally {
    finish?.();
    insert("");
    drafts.patchPhase(key, (phase) => {
      const cleanedError = phase.error === BUSY_UPLOAD_MESSAGE ? "" : phase.error;
      if (phase.kind === "uploading")
        return { kind: "idle", status: phase.status, error: cleanedError };
      return cleanedError !== phase.error ? { ...phase, error: cleanedError ?? "" } : phase;
    });
    input.onFinished();
  }
}

export function bindAttachmentFormEvents(input: {
  root: HTMLDivElement;
  target: HTMLElement | undefined;
  onDragging(dragging: boolean): void;
  onFiles(files: File[]): void;
  onSubmit(event: Event): void;
  onReset(): void;
}): () => void {
  const bound = input.target ?? input.root.closest("form")?.querySelector("textarea") ?? undefined;
  const form = input.root.closest("form");
  function drop(event: DragEvent) {
    const files = [...(event.dataTransfer?.files ?? [])];
    if (!files.length) return;
    event.preventDefault();
    event.stopPropagation();
    input.onDragging(false);
    input.onFiles(files);
  }
  function paste(event: ClipboardEvent) {
    const files = [...(event.clipboardData?.files ?? [])];
    if (!files.length) return;
    event.preventDefault();
    input.onFiles(files);
  }
  function drag(event: DragEvent) {
    if (event.dataTransfer?.types.includes("Files")) {
      event.preventDefault();
      input.onDragging(true);
    }
  }
  function leave(event: DragEvent) {
    if (!(event.relatedTarget instanceof Node) || !bound?.contains(event.relatedTarget))
      input.onDragging(false);
  }
  bound?.addEventListener("drop", drop);
  bound?.addEventListener("paste", paste);
  bound?.addEventListener("dragover", drag);
  bound?.addEventListener("dragleave", leave);
  form?.addEventListener("submit", input.onSubmit, true);
  form?.addEventListener("reset", input.onReset);
  return () => {
    bound?.removeEventListener("drop", drop);
    bound?.removeEventListener("paste", paste);
    bound?.removeEventListener("dragover", drag);
    bound?.removeEventListener("dragleave", leave);
    form?.removeEventListener("submit", input.onSubmit, true);
    form?.removeEventListener("reset", input.onReset);
  };
}
