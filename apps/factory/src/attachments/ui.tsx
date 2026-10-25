import type { JSX } from "@solidjs/web";
import {
  createContext,
  createEffect,
  createSignal,
  For,
  onCleanup,
  Show,
  untrack,
  useContext,
} from "solid-js";
import {
  type AttachmentSummary,
  type AttachmentInput,
  attachmentIDs,
  attachmentMarkdown,
  attachmentSummary,
  attachmentURL,
} from "../../../../packages/conversation-domain/src/attachments";
import { apiUpload } from "../api-client";
import {
  beginAttachment,
  getAttachmentMetadata,
  getAttachmentUsage,
} from "../server-functions/attachments";
import { serverCall, type ServerValue } from "../server-functions/result";
import { Icon } from "../icon";
import { Feedback } from "../ui/feedback";
import {
  readAttachmentContent,
  restoreAttachmentContent,
  splitAttachmentContent,
} from "./composer";
import { AttachmentFiles, AttachmentHelp } from "./controls";
import "./attachments.css";

type FileTransfer = {
  key: string;
  name: string;
  state: "queued" | "preparing" | "uploading" | "processing" | "ready" | "failed" | "waiting";
  loaded?: number;
  total?: number;
};
type UploadDraft = {
  busy: boolean;
  status: string;
  error: string;
  files: AttachmentSummary[];
  queued: AttachmentSummary[];
  retryFiles: File[];
  attempts: Map<string, string>;
  transfers: FileTransfer[];
};
function emptyUploadDraft(): UploadDraft {
  return {
    busy: false,
    status: "",
    error: "",
    files: [],
    queued: [],
    retryFiles: [],
    attempts: new Map(),
    transfers: [],
  };
}
function uploadDrafts() {
  const [drafts, setDrafts] = createSignal<Record<string, UploadDraft>>({});
  return {
    get: (key: string) => drafts()[key] ?? emptyUploadDraft(),
    update(key: string, patch: Partial<UploadDraft>) {
      setDrafts((current) => ({
        ...current,
        [key]: { ...(current[key] ?? emptyUploadDraft()), ...patch },
      }));
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
type Scope = {
  projectId(): string | undefined;
  identity(): string;
  pending(): boolean;
  begin(): () => void;
  drafts: ReturnType<typeof uploadDrafts>;
};
const AttachmentScope = createContext<Scope>();
export function AttachmentProvider(props: {
  projectId: string | undefined;
  scopeKey?: string;
  children: JSX.Element;
}) {
  const [uploads, setUploads] = createSignal(0);
  const drafts = uploadDrafts();
  let alive = true;
  onCleanup(() => {
    alive = false;
  });
  return (
    <AttachmentScope
      value={{
        projectId: () => props.projectId,
        identity: () => props.scopeKey ?? props.projectId ?? "",
        pending: () => uploads() > 0,
        drafts,
        begin: () => {
          setUploads((value) => value + 1);
          return () => {
            if (alive) setUploads((value) => value - 1);
          };
        },
      }}
    >
      {props.children}
    </AttachmentScope>
  );
}
export function useAttachmentPending() {
  try {
    return useContext(AttachmentScope).pending;
  } catch {
    return () => false;
  }
}
export function useAttachmentProject() {
  // Standalone read-only renderers and isolated editor fixtures need no upload scope.
  try {
    return useContext(AttachmentScope).projectId;
  } catch {
    return () => undefined;
  }
}
const accepted = ".png,.jpg,.jpeg,.webp,.pdf,.docx,.txt,.md,.markdown";
type Privacy = "save" | "autosave" | "send" | "personal" | "create" | "feedback";
function fileSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  return bytes >= 1024 * 1024
    ? `${+(bytes / 1024 / 1024).toFixed(1)} MiB`
    : `${Math.max(1, Math.ceil(bytes / 1024))} KiB`;
}
function fileUsage(bytes: number, maximum: number) {
  const mib = 1024 * 1024;
  if (maximum < mib) return `${fileSize(bytes)} / ${fileSize(maximum)}`;
  const used = bytes > 0 && bytes < mib / 10 ? "<0.1" : `${+(bytes / mib).toFixed(1)}`;
  return `${used} / ${fileSize(maximum)}`;
}
export function attachmentFileType(file: File) {
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
export type AttachmentPickerHandle = {
  choose(imagesOnly?: boolean): void;
  upload(files: File[]): void;
};
export function AttachmentPicker(props: {
  target?(): HTMLElement | undefined;
  prepare(): (markdown: string) => void;
  draftId?: string | undefined;
  scopeKey?: string | undefined;
  fieldKey?: string | undefined;
  content?: string | undefined;
  privacy?: Privacy;
  disabled?: boolean | undefined;
  compact?: boolean;
  horizontal?: boolean;
  textEntry?: JSX.Element;
  showButton?: boolean;
  remove?(id: string): void;
  ref?(handle: AttachmentPickerHandle): void;
}) {
  const project = useAttachmentProject();
  let scope: Scope | undefined;
  try {
    scope = useContext(AttachmentScope);
  } catch {
    /* Upload reports a missing Project explicitly. */
  }
  const drafts = scope?.drafts ?? uploadDrafts();
  const identity = () =>
    JSON.stringify([
      project(),
      props.scopeKey ?? scope?.identity(),
      props.draftId ?? null,
      props.fieldKey ?? null,
    ]);
  const draft = () => drafts.get(identity());
  const busy = () => draft().busy;
  const ids = () => attachmentIDs(props.content ?? "");
  const uploaded = () => draft().files.filter((file) => ids().includes(file.id));
  const [limits, setLimits] =
    createSignal<ServerValue<ReturnType<typeof getAttachmentUsage>>["limits"]>();
  const [limitsFailed, setLimitsFailed] = createSignal(false);
  const [dragging, setDragging] = createSignal(false);
  const isMessage = () => ["send", "personal", "feedback"].includes(props.privacy ?? "save");
  const sizeRestrictions = () => {
    const value = limits();
    return value
      ? ` · ${fileSize(value.fileBytes)} per file${isMessage() ? ` · ${fileSize(value.messageBytes)} total` : ""}`
      : limitsFailed()
        ? " · Size limits unavailable"
        : " · Loading size limits…";
  };
  const privacy = () => {
    const boundary = props.privacy ?? (props.draftId ? "create" : "save");
    return {
      save: "Saving this document shares its files with the Project.",
      autosave: "Changes save automatically and share files with the Project.",
      send: "New files stay private until this message is sent.",
      personal: "Only you can access these files, including after sending.",
      create: "New files stay private until this Ticket is created.",
      feedback: "New files stay private until this feedback is saved.",
    }[boundary];
  };
  const selectionSummary = () => {
    const count = ids().length;
    const queued = draft().queued.length;
    if (!count)
      return queued ? `${queued} ready to attach` : sizeRestrictions().replace(/^ · /, "");
    const bytes = uploaded().reduce((sum, file) => sum + file.bytes, 0);
    const maximum = limits();
    const details =
      uploaded().length < count
        ? "Loading details…"
        : maximum
          ? fileUsage(bytes, maximum.messageBytes)
          : fileSize(bytes);
    return `${count} ${count === 1 ? "file" : "files"} · ${details}${queued ? ` · ${queued} ready to attach` : ""}`;
  };
  const prepared = () => (props.compact ? draft().queued : [...uploaded(), ...draft().queued]);
  const status = () => (busy() || uploaded().length || draft().queued.length ? draft().status : "");
  const error = () => draft().error;
  const retryFiles = () => draft().retryFiles;
  let input: HTMLInputElement | undefined;
  let root: HTMLDivElement | undefined;
  let disposed = false;
  let pickerIdentity: string | undefined;
  let submittedIdentity: string | undefined;
  let bound: HTMLElement | undefined;
  const blocked = () => props.disabled || busy();
  createEffect(
    () => project(),
    (id) => {
      setLimits(undefined);
      setLimitsFailed(false);
      let active = true;
      if (id)
        void serverCall(getAttachmentUsage(id))
          .then((usage) => {
            if (active) setLimits(usage.limits);
          })
          .catch(() => {
            if (active) setLimitsFailed(true);
          });
      return () => {
        active = false;
      };
    },
  );
  async function upload(files: File[], retry = false) {
    if (disposed || !files.length || blocked()) return;
    const projectId = project();
    const draftId = props.draftId;
    const key = identity();
    const message = isMessage();
    const referenceIDs = attachmentIDs(props.content ?? "");
    if (!projectId) {
      drafts.update(key, { error: "Select a Project before adding a file." });
      return;
    }
    const insert = props.prepare();
    const finish = scope?.begin();
    const attempts = retry ? new Map(draft().attempts) : new Map<string, string>();
    const transfers: FileTransfer[] = files.map((file) => ({
      key: crypto.randomUUID(),
      name: file.name,
      state: "queued",
    }));
    function transfer(index: number, patch: Partial<FileTransfer>) {
      const current = transfers[index];
      if (!current) return;
      transfers[index] = { ...current, ...patch };
      drafts.update(key, { transfers: [...transfers] });
    }
    let currentFile = 0;
    const rejected: string[] = [];
    drafts.update(key, { busy: true, status: "", error: "", retryFiles: [], attempts, transfers });
    try {
      const usage = await serverCall(getAttachmentUsage(projectId));
      if (!disposed && identity() === key) setLimits(usage.limits);
      if (!usage.configured)
        throw new Error(
          "File storage is not configured. Ask your Factory administrator to configure the private attachment bucket.",
        );
      const existing = message
        ? await Promise.all(
            referenceIDs.map(
              (id) =>
                drafts.get(key).files.find((item) => item.id === id) ??
                serverCall(getAttachmentMetadata(id)),
            ),
          )
        : [];
      let messageBytes = existing.reduce((total, item) => total + item.bytes, 0);
      for (const [index, file] of files.entries()) {
        currentFile = index;
        transfer(index, { state: "preparing" });
        const reject = (reason: string) => {
          transfer(index, { state: "failed" });
          rejected.push(`${file.name} was not attached. ${reason}`);
          drafts.update(key, {
            error: `${rejected.join(" ")} Your text and earlier attachments are unchanged.`,
          });
        };
        if (file.size > usage.limits.fileBytes) {
          reject(`Each file must be at most ${fileSize(usage.limits.fileBytes)}.`);
          continue;
        }
        const mediaType = attachmentFileType(file);
        if (!mediaType) {
          reject("Use PNG, JPEG, WebP, PDF, DOCX, TXT or Markdown.");
          continue;
        }
        if (message) {
          if (messageBytes + file.size > usage.limits.messageBytes) {
            reject(
              `Attachments must total at most ${fileSize(usage.limits.messageBytes)} per message.`,
            );
            continue;
          }
        }
        drafts.update(key, { status: `Preparing upload for ${file.name}…` });
        const bytes = await file.arrayBuffer();
        const sha256 = [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))]
          .map((value) => value.toString(16).padStart(2, "0"))
          .join("");
        const attemptKey = `${projectId}:${file.name}:${sha256}`;
        const id = attempts.get(attemptKey) ?? crypto.randomUUID();
        attempts.set(attemptKey, id);
        const initial = await serverCall(
          beginAttachment({
            id,
            projectId,
            name: file.name,
            mediaType,
            bytes: file.size,
            sha256,
            ...(draftId ? { draftId } : {}),
          }),
        );
        transfer(index, { state: "uploading" });
        drafts.update(key, { status: `Uploading ${file.name}…` });
        const ready =
          initial.state === "ready"
            ? initial
            : await apiUpload(attachmentSummary, attachmentURL(id), {
                body: bytes,
                mediaType,
                onProgress: (loaded, total) => transfer(index, { loaded, total }),
                onTransferred: () => {
                  transfer(index, { state: "processing" });
                  drafts.update(key, { status: `Preparing ${file.name} for agent context…` });
                },
              });
        if (ready.state !== "ready")
          throw new Error(
            ready.failure ?? "File processing is not confirmed. Retry the same file request.",
          );
        messageBytes += ready.bytes;
        const current = drafts.get(key);
        const active = !disposed && identity() === key;
        if (active) insert(attachmentMarkdown(ready));
        attempts.delete(attemptKey);
        transfer(index, { state: "ready" });
        drafts.update(key, {
          files: [...current.files.filter((file) => file.id !== ready.id), ready],
          queued: active ? current.queued : [...current.queued, ready],
          status: `${file.name} is ready.`,
        });
      }
    } catch (cause) {
      for (let index = currentFile; index < transfers.length; index++)
        transfer(index, { state: index === currentFile ? "failed" : "waiting" });
      drafts.update(key, {
        status: "",
        error: `${files[currentFile]?.name ?? "File"} was not attached. ${
          cause instanceof Error ? cause.message : "Upload failed. Choose the file again to retry."
        } Your text and earlier attachments are unchanged.`,
        retryFiles: attempts.size ? files.slice(currentFile) : [],
      });
    } finally {
      finish?.();
      insert("");
      drafts.update(key, { busy: false });
      if (input) input.value = "";
    }
  }
  function choose(imagesOnly = false) {
    if (blocked()) return;
    pickerIdentity = identity();
    if (input) {
      input.accept = imagesOnly ? ".png,.jpg,.jpeg,.webp" : accepted;
      input.click();
    }
  }
  props.ref?.({ choose, upload: (files) => void upload(files) });
  function drop(event: DragEvent) {
    const files = [...(event.dataTransfer?.files ?? [])];
    if (!files.length) return;
    event.preventDefault();
    event.stopPropagation();
    setDragging(false);
    void upload(files);
  }
  function paste(event: ClipboardEvent) {
    const files = [...(event.clipboardData?.files ?? [])];
    if (!files.length) return;
    event.preventDefault();
    void upload(files);
  }
  function drag(event: DragEvent) {
    if (event.dataTransfer?.types.includes("Files")) {
      event.preventDefault();
      setDragging(true);
    }
  }
  function leave(event: DragEvent) {
    if (!(event.relatedTarget instanceof Node) || !bound?.contains(event.relatedTarget))
      setDragging(false);
  }
  function submit(event: Event) {
    if (busy()) {
      event.preventDefault();
      event.stopImmediatePropagation();
      drafts.update(identity(), { error: "Wait for the file upload to finish before sending." });
    } else {
      submittedIdentity = identity();
    }
  }
  function reset() {
    drafts.clear(submittedIdentity ?? identity());
    submittedIdentity = undefined;
  }
  const requestedMetadata = new Set<string>();
  createEffect(
    () => [identity(), ids()] as const,
    ([key, ids]) => {
      if (props.compact) return;
      for (const id of ids) {
        const request = `${key}:${id}`;
        if (
          untrack(() => drafts.get(key).files.some((file) => file.id === id)) ||
          requestedMetadata.has(request)
        )
          continue;
        requestedMetadata.add(request);
        void serverCall(getAttachmentMetadata(id))
          .then((file) => {
            const current = drafts.get(key);
            if (!current.files.some((item) => item.id === id))
              drafts.update(key, { files: [...current.files, file] });
          })
          .catch(() => {
            drafts.update(key, {
              error: "File details are unavailable. The original reference is retained.",
            });
          });
      }
    },
  );
  const fileList = () => (
    <Show when={prepared().length}>
      <AttachmentFiles
        horizontal={Boolean(props.horizontal)}
        count={prepared().length}
        scope={identity()}
      >
        <For each={prepared()}>
          {(file) => (
            <li class="attachment-file">
              <a
                class="attachment-file-open"
                href={attachmentURL(file.id)}
                target="_blank"
                rel="noopener noreferrer"
                download={!file.mediaType.startsWith("image/")}
                aria-label={`${file.mediaType.startsWith("image/") ? "Open image" : "Download"} ${file.name}`}
                title={file.name}
              >
                <span class="attachment-file-preview">
                  <Show when={file.mediaType.startsWith("image/")} fallback={<Icon name="file" />}>
                    <img src={attachmentURL(file.id, 0)} alt="" width={48} height={48} />
                  </Show>
                </span>
                <span class="attachment-file-details">
                  <span class="attachment-file-name">{file.name}</span>
                  <small>
                    <span class="attachment-file-meta">
                      {fileSize(file.bytes)} ·{" "}
                      {file.mediaType.startsWith("image/")
                        ? "Image"
                        : file.name.split(".").at(-1)?.toUpperCase()}
                    </span>
                    <Show when={file.state === "ready"}>
                      <span class="attachment-file-ready" data-feedback="success">
                        <Icon name="check" />
                        <span class="sr-only">Ready</span>
                      </span>
                    </Show>
                  </small>
                </span>
              </a>
              <Show when={draft().queued.some((item) => item.id === file.id)}>
                <button
                  type="button"
                  class="quiet-button attachment-file-attach"
                  disabled={blocked()}
                  aria-label={`Attach prepared file ${file.name}`}
                  onClick={() => {
                    const insert = props.prepare();
                    if (!ids().includes(file.id)) insert(attachmentMarkdown(file));
                    insert("");
                    drafts.update(identity(), {
                      queued: draft().queued.filter((item) => item.id !== file.id),
                    });
                  }}
                >
                  {props.horizontal ? "Attach" : "Attach to this draft"}
                </button>
              </Show>
              <Show when={props.remove || draft().queued.some((item) => item.id === file.id)}>
                <button
                  type="button"
                  class="quiet-button attachment-file-remove"
                  disabled={blocked()}
                  aria-label={`Remove attachment ${file.name}`}
                  onClick={() => {
                    props.remove?.(file.id);
                    drafts.update(identity(), {
                      queued: draft().queued.filter((item) => item.id !== file.id),
                    });
                  }}
                >
                  <Icon name="close" />
                </button>
              </Show>
            </li>
          )}
        </For>
      </AttachmentFiles>
    </Show>
  );
  onCleanup(() => {
    disposed = true;
    bound?.removeEventListener("drop", drop);
    bound?.removeEventListener("paste", paste);
    bound?.removeEventListener("dragover", drag);
    bound?.removeEventListener("dragleave", leave);
    root?.closest("form")?.removeEventListener("submit", submit, true);
    root?.closest("form")?.removeEventListener("reset", reset);
  });
  return (
    <div
      class={`attachment-insert${props.compact ? " attachment-insert-compact" : ""}${props.horizontal ? " attachment-insert-strip" : ""}${dragging() ? " attachment-insert-drop" : ""}`}
      ref={(element) => {
        root = element;
        queueMicrotask(() => {
          if (disposed) return;
          bound = props.target?.() ?? root?.closest("form")?.querySelector("textarea") ?? undefined;
          bound?.addEventListener("drop", drop);
          bound?.addEventListener("paste", paste);
          bound?.addEventListener("dragover", drag);
          bound?.addEventListener("dragleave", leave);
          root?.closest("form")?.addEventListener("submit", submit, true);
          root?.closest("form")?.addEventListener("reset", reset);
        });
      }}
    >
      <input
        class="sr-only"
        tabindex="-1"
        type="file"
        name="attachments"
        accept={accepted}
        multiple
        ref={input}
        aria-label="Choose attachments"
        onChange={(event) => {
          if (pickerIdentity !== undefined && pickerIdentity !== identity()) {
            pickerIdentity = undefined;
            event.currentTarget.value = "";
            drafts.update(identity(), {
              error:
                "The upload destination changed. Choose the file again in the intended document.",
            });
            return;
          }
          pickerIdentity = undefined;
          void upload([...(event.currentTarget.files ?? [])]);
        }}
        disabled={blocked()}
      />
      {fileList()}
      <span class="attachment-text-entry">{props.textEntry}</span>
      <div class="attachment-toolbar">
        <Show when={props.showButton !== false}>
          <button
            type="button"
            class="quiet-button attachment-add"
            onClick={() => choose()}
            disabled={blocked()}
            aria-label="Add image or file"
            title="Add image or file"
          >
            <Icon name="attachment" />
            <span class={props.horizontal ? "sr-only" : undefined}>
              {busy() ? "Preparing file…" : "Add file"}
            </span>
          </button>
        </Show>
        <Show when={dragging()}>
          <small class="attachment-drop-hint" role="status">
            Drop files to attach
          </small>
        </Show>
        <Show when={status()}>
          <small role="status" class="sr-only">
            {status()}
          </small>
        </Show>
        <Show when={props.horizontal}>
          <Show when={ids().length || draft().queued.length}>
            <small class="attachment-count" title={selectionSummary()}>
              {selectionSummary()}
            </small>
          </Show>
          <AttachmentHelp>
            <strong>Attach images or documents</strong>
            <p class="attachment-restrictions">
              PNG, JPG, WebP, PDF, DOCX, TXT and Markdown{sizeRestrictions()}
            </p>
            <p>{privacy()}</p>
          </AttachmentHelp>
        </Show>
        <Show when={props.showButton !== false && !props.horizontal}>
          <small class="attachment-restrictions">
            PNG, JPG, WebP, PDF, DOCX, TXT, MD
            {sizeRestrictions()}
          </small>
        </Show>
        <Show when={!props.horizontal && (uploaded().length || draft().queued.length)}>
          <small class="attachment-privacy" title={privacy()}>
            {privacy()}
          </small>
        </Show>
      </div>
      <Show when={error()}>
        <p class="inline-error" role="alert">
          {error()}
        </p>
      </Show>
      <Show when={retryFiles().length}>
        <button
          type="button"
          class="quiet-button"
          disabled={blocked()}
          onClick={() => void upload(retryFiles(), true)}
        >
          Retry file upload
        </button>
      </Show>
      <Show when={draft().transfers.some((file) => file.state !== "ready")}>
        <ul class="attachment-transfer-list" aria-label="File uploads">
          <For
            each={draft()
              .transfers.filter((file) => file.state !== "ready")
              .map((file) => file.key)}
          >
            {(key) => {
              const initial = untrack(() => draft().transfers.find((file) => file.key === key));
              if (!initial) return null;
              const file = () => draft().transfers.find((file) => file.key === key) ?? initial;
              return (
                <li>
                  <span class="attachment-transfer-name">{file().name}</span>
                  <Feedback
                    announce={false}
                    state={
                      file().state === "failed"
                        ? "error"
                        : file().state === "waiting" || file().state === "queued"
                          ? "idle"
                          : "pending"
                    }
                    message={
                      {
                        queued: "Queued",
                        preparing: "Preparing upload…",
                        uploading: "Uploading…",
                        processing: "Preparing file…",
                        ready: "Ready",
                        failed: "Not attached",
                        waiting: "Waiting for retry",
                      }[file().state]
                    }
                  />
                  <Show when={file().state === "uploading" && file().total}>
                    <progress
                      aria-label={`Upload progress for ${file().name}`}
                      max={file().total}
                      value={file().loaded ?? 0}
                    />
                  </Show>
                </li>
              );
            }}
          </For>
        </ul>
      </Show>
    </div>
  );
}

export function TextareaAttachments(props: {
  children?: JSX.Element;
  disabled?: boolean | undefined;
  draftId?: string | undefined;
  scopeKey?: string | undefined;
  privacy?: Privacy;
  content?: string;
}) {
  let root: HTMLSpanElement | undefined;
  const [content, setContent] = createSignal("");
  let textarea: HTMLTextAreaElement | undefined;
  const sync = () => setContent(textarea ? readAttachmentContent(textarea) : "");
  const reset = () => {
    if (textarea) restoreAttachmentContent(textarea, "");
    queueMicrotask(sync);
  };
  createEffect(
    () => [props.scopeKey, props.content] as const,
    () =>
      queueMicrotask(() => {
        if (textarea && props.content !== undefined)
          restoreAttachmentContent(textarea, props.content);
        sync();
      }),
  );
  onCleanup(() => {
    textarea?.removeEventListener("input", sync);
    textarea?.removeEventListener("factory-attachment-content", sync);
    textarea?.form?.removeEventListener("reset", reset);
  });
  return (
    <span
      class="attachment-composer"
      ref={(element) => {
        root = element;
        queueMicrotask(() => {
          if (!root?.isConnected) return;
          textarea = root?.closest("form")?.querySelector("textarea") ?? undefined;
          textarea?.addEventListener("input", sync);
          textarea?.addEventListener("factory-attachment-content", sync);
          textarea?.form?.addEventListener("reset", reset);
          if (textarea)
            restoreAttachmentContent(textarea, props.content ?? readAttachmentContent(textarea));
          sync();
        });
      }}
    >
      <AttachmentPicker
        horizontal
        textEntry={props.children}
        target={() => root?.closest("form") ?? undefined}
        disabled={props.disabled}
        draftId={props.draftId}
        scopeKey={props.scopeKey}
        content={content()}
        privacy={props.privacy ?? "send"}
        remove={(id) => {
          const textarea = root?.closest("form")?.querySelector("textarea");
          if (!textarea) return;
          const draft = splitAttachmentContent(readAttachmentContent(textarea));
          restoreAttachmentContent(
            textarea,
            [draft.text, ...draft.files.filter((file) => !attachmentIDs(file).includes(id))]
              .filter(Boolean)
              .join("\n\n"),
          );
          textarea.dispatchEvent(new Event("input", { bubbles: true }));
          textarea.focus({ preventScroll: true });
        }}
        prepare={() => {
          const textarea = root?.closest("form")?.querySelector("textarea");
          return (markdown) => {
            if (!markdown || !textarea?.isConnected) return;
            const current = readAttachmentContent(textarea);
            restoreAttachmentContent(textarea, `${current ? `${current}\n\n` : ""}${markdown}`);
            textarea.dispatchEvent(new Event("input", { bubbles: true }));
          };
        }}
      />
    </span>
  );
}
