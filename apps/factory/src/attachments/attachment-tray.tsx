import { For, Show, untrack } from "solid-js";
import { type AttachmentSummary, attachmentURL } from "#conversation-domain/attachments";
import { Icon } from "../icon";
import { Feedback } from "../ui/feedback";
import { AttachmentFiles } from "./controls";
import { type FileTransfer, type FileTransferState, formatFileSize } from "./upload-state";

function AttachmentPreviewCard(props: {
  file: AttachmentSummary;
  queued: boolean;
  horizontal: boolean;
  blocked: boolean;
  canRemove: boolean;
  onAttach(): void;
  onRemove(): void;
}) {
  const isImage = () => props.file.mediaType.startsWith("image/");
  return (
    <li class="attachment-file">
      <a
        class="attachment-file-open"
        href={attachmentURL(props.file.id)}
        target="_blank"
        rel="noopener noreferrer"
        download={!isImage()}
        aria-label={`${isImage() ? "Open image" : "Download"} ${props.file.name}`}
        title={props.file.name}
      >
        <span class="attachment-file-preview">
          <Show when={isImage()} fallback={<Icon name="file" />}>
            <img src={attachmentURL(props.file.id, 0)} alt="" width={48} height={48} />
          </Show>
        </span>
        <span class="attachment-file-details">
          <span class="attachment-file-name">{props.file.name}</span>
          <small>
            <span class="attachment-file-meta">
              {formatFileSize(props.file.bytes)} ·{" "}
              {isImage() ? "Image" : props.file.name.split(".").at(-1)?.toUpperCase()}
            </span>
            <Show when={props.file.state === "ready"}>
              <span class="attachment-file-ready" data-feedback="success">
                <Icon name="check" />
                <span class="sr-only">Ready</span>
              </span>
            </Show>
          </small>
        </span>
      </a>
      <Show when={props.queued}>
        <button
          type="button"
          class="quiet-button attachment-file-attach"
          disabled={props.blocked}
          aria-label={`Attach prepared file ${props.file.name}`}
          onClick={props.onAttach}
        >
          {props.horizontal ? "Attach" : "Attach to this draft"}
        </button>
      </Show>
      <Show when={props.canRemove}>
        <button
          type="button"
          class="quiet-button attachment-file-remove"
          disabled={props.blocked}
          aria-label={`Remove attachment ${props.file.name}`}
          onClick={props.onRemove}
        >
          <Icon name="close" />
        </button>
      </Show>
    </li>
  );
}

export function AttachmentFileTray(props: {
  files: AttachmentSummary[];
  queued: AttachmentSummary[];
  horizontal: boolean;
  scope: string;
  blocked: boolean;
  hasRemoveHandler: boolean;
  onAttach(file: AttachmentSummary): void;
  onRemove(file: AttachmentSummary): void;
}) {
  return (
    <Show when={props.files.length}>
      <AttachmentFiles horizontal={props.horizontal} count={props.files.length} scope={props.scope}>
        <For each={props.files}>
          {(file) => {
            const isQueued = () => props.queued.some((item) => item.id === file.id);
            return (
              <AttachmentPreviewCard
                file={file}
                queued={isQueued()}
                horizontal={props.horizontal}
                blocked={props.blocked}
                canRemove={props.hasRemoveHandler || isQueued()}
                onAttach={() => props.onAttach(file)}
                onRemove={() => props.onRemove(file)}
              />
            );
          }}
        </For>
      </AttachmentFiles>
    </Show>
  );
}

export function AttachmentPickerToolbar(props: {
  helpID: string;
  showButton: boolean;
  horizontal: boolean;
  busy: boolean;
  blocked: boolean;
  dragging: boolean;
  status: string;
  sizeRestrictions: string;
  privacy: string;
  selectionSummary: string;
  hasSelectedOrQueued: boolean;
  hasUploadedOrQueued: boolean;
  error: string;
  retryCount: number;
  onChoose(): void;
  onRetry(): void;
}) {
  return (
    <>
      <div class="attachment-toolbar">
        <Show when={props.showButton}>
          <button
            type="button"
            class="quiet-button attachment-add"
            onClick={props.onChoose}
            disabled={props.blocked}
            aria-label="Add image or file"
            aria-describedby={props.horizontal ? props.helpID : undefined}
            title={`Add image or file. PNG, JPG, WebP, PDF, DOCX, TXT and Markdown${props.sizeRestrictions}. ${props.privacy}`}
          >
            <Icon name="attachment" />
            <span class={props.horizontal ? "sr-only" : undefined}>
              {props.busy ? "Preparing file…" : "Add file"}
            </span>
          </button>
        </Show>
        <Show when={props.dragging}>
          <small class="attachment-drop-hint" role="status">
            Drop files to attach
          </small>
        </Show>
        <Show when={props.status}>
          <small role="status" class="sr-only">
            {props.status}
          </small>
        </Show>
        <Show when={props.horizontal}>
          <Show when={props.hasSelectedOrQueued}>
            <small class="attachment-count" title={props.selectionSummary}>
              {props.selectionSummary}
            </small>
          </Show>
          <span class="sr-only" id={props.helpID}>
            PNG, JPG, WebP, PDF, DOCX, TXT and Markdown{props.sizeRestrictions}. {props.privacy}
          </span>
        </Show>
        <Show when={props.showButton && !props.horizontal}>
          <small class="attachment-restrictions">
            PNG, JPG, WebP, PDF, DOCX, TXT, MD
            {props.sizeRestrictions}
          </small>
        </Show>
        <Show when={!props.horizontal && props.hasUploadedOrQueued}>
          <small class="attachment-privacy" title={props.privacy}>
            {props.privacy}
          </small>
        </Show>
      </div>
      <Show when={props.error}>
        <p class="inline-error" role="alert">
          {props.error}
        </p>
      </Show>
      <Show when={props.retryCount > 0}>
        <button type="button" class="quiet-button" disabled={props.blocked} onClick={props.onRetry}>
          Retry file upload
        </button>
      </Show>
    </>
  );
}

const transferMessages: Record<FileTransferState["kind"], string> = {
  queued: "Queued",
  preparing: "Preparing upload…",
  uploading: "Uploading…",
  processing: "Preparing file…",
  ready: "Ready",
  failed: "Not attached",
  waiting: "Waiting for retry",
};

function transferFeedbackState(kind: FileTransferState["kind"]): "error" | "idle" | "pending" {
  if (kind === "failed") return "error";
  if (kind === "waiting" || kind === "queued") return "idle";
  return "pending";
}

export function AttachmentTransferList(props: { transfers: FileTransfer[] }) {
  const activeKeys = () =>
    props.transfers.filter((file) => file.state.kind !== "ready").map((file) => file.key);
  return (
    <Show when={activeKeys().length > 0}>
      <ul class="attachment-transfer-list" aria-label="File uploads">
        <For each={activeKeys()}>
          {(key) => {
            const initial = untrack(() => props.transfers.find((file) => file.key === key));
            if (!initial) return null;
            const file = () => props.transfers.find((entry) => entry.key === key) ?? initial;
            const uploadingProgress = () => {
              const state = file().state;
              return state.kind === "uploading" && state.total ? state : undefined;
            };
            return (
              <li>
                <span class="attachment-transfer-name">{file().name}</span>
                <Feedback
                  announce={false}
                  state={transferFeedbackState(file().state.kind)}
                  message={transferMessages[file().state.kind]}
                />
                <Show when={uploadingProgress()}>
                  {(progress) => (
                    <progress
                      aria-label={`Upload progress for ${file().name}`}
                      max={progress().total}
                      value={progress().loaded ?? 0}
                    />
                  )}
                </Show>
              </li>
            );
          }}
        </For>
      </ul>
    </Show>
  );
}
