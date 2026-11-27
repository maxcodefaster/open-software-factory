import type { JSX } from "@solidjs/web";
import { createEffect, createSignal, onCleanup, untrack } from "solid-js";
import {
  type AttachmentSummary,
  attachmentIDs,
  attachmentMarkdown,
} from "#conversation-domain/attachments";
import { getAttachmentMetadata, getAttachmentUsage } from "../server-functions/attachments";
import { serverCall } from "../server-functions/result";
import { useAttachmentProject, useOptionalAttachmentScope } from "./attachment-scope";
import {
  AttachmentFileTray,
  AttachmentPickerToolbar,
  AttachmentTransferList,
} from "./attachment-tray";
import { bindAttachmentFormEvents, executeAttachmentUpload } from "./upload-runner";
import {
  ACCEPTED_ATTACHMENTS,
  ACCEPTED_IMAGES,
  type AttachmentPrivacy,
  BUSY_UPLOAD_MESSAGE,
  createUploadDraftRegistry,
  draftError,
  draftRetryFiles,
  draftStatus,
  formatPrivacyNotice,
  formatSelectionSummary,
  formatSizeRestrictions,
  isDraftBusy,
  type LimitsState,
} from "./upload-state";

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
  privacy?: AttachmentPrivacy;
  disabled?: boolean | undefined;
  compact?: boolean;
  horizontal?: boolean;
  textEntry?: JSX.Element;
  showButton?: boolean;
  remove?(id: string): void;
  ref?(handle: AttachmentPickerHandle): void;
}) {
  const helpID = `attachment-help-${crypto.randomUUID()}`;
  const project = useAttachmentProject();
  const scope = useOptionalAttachmentScope();
  const drafts = scope?.drafts ?? createUploadDraftRegistry();
  const identity = () =>
    JSON.stringify([
      project(),
      props.scopeKey ?? scope?.identity(),
      props.draftId ?? null,
      props.fieldKey ?? null,
    ]);
  const draft = () => drafts.get(identity());
  const busy = () => isDraftBusy(draft());
  const blocked = () => Boolean(props.disabled || busy());
  const ids = () => attachmentIDs(props.content ?? "");
  const uploaded = () => draft().files.filter((file) => ids().includes(file.id));
  const prepared = () => (props.compact ? draft().queued : [...uploaded(), ...draft().queued]);
  const [limitsState, setLimitsState] = createSignal<LimitsState>({ kind: "loading" });
  const [dragging, setDragging] = createSignal(false);

  const isMessage = () => ["send", "personal", "feedback"].includes(props.privacy ?? "save");
  const sizeRestrictions = () => formatSizeRestrictions(limitsState(), isMessage());
  const privacy = () => formatPrivacyNotice(props.privacy, props.draftId);
  const selectionSummary = () =>
    formatSelectionSummary({
      count: ids().length,
      queuedCount: draft().queued.length,
      uploaded: uploaded(),
      limitsState: limitsState(),
      sizeRestrictions: sizeRestrictions(),
    });

  let input: HTMLInputElement | undefined;
  let disposed = false;
  let pickerIdentity: string | undefined;
  let submittedIdentity: string | undefined;
  let unbindEvents: (() => void) | undefined;

  function declineWhileBusy() {
    if (!props.disabled && busy()) drafts.setError(identity(), BUSY_UPLOAD_MESSAGE);
  }

  createEffect(
    () => project(),
    (id) => {
      setLimitsState({ kind: "loading" });
      let active = true;
      if (id)
        void serverCall(getAttachmentUsage({ data: [id] }))
          .then((usage) => {
            if (active) setLimitsState({ kind: "ready", limits: usage.limits });
          })
          .catch(() => {
            if (active) setLimitsState({ kind: "unavailable" });
          });
      return () => {
        active = false;
      };
    },
  );

  async function upload(files: File[], retry = false) {
    if (disposed || !files.length) return;
    if (blocked()) {
      declineWhileBusy();
      return;
    }
    const projectId = project();
    const key = identity();
    if (!projectId) {
      drafts.setError(key, "Select a Project before adding a file.");
      return;
    }
    await executeAttachmentUpload({
      files,
      retry,
      projectId,
      draftId: props.draftId,
      key,
      isMessage: isMessage(),
      content: props.content ?? "",
      drafts,
      beginScopeUpload: scope?.begin,
      prepare: props.prepare,
      isActive: () => !disposed && identity() === key,
      onLimits: (limits) => setLimitsState({ kind: "ready", limits }),
      onFinished: () => {
        if (input) input.value = "";
      },
    });
  }

  function choose(imagesOnly = false) {
    if (blocked()) {
      declineWhileBusy();
      return;
    }
    pickerIdentity = identity();
    if (input) {
      input.accept = imagesOnly ? ACCEPTED_IMAGES : ACCEPTED_ATTACHMENTS;
      input.click();
    }
  }
  props.ref?.({ choose, upload: (files) => void upload(files) });

  const requestedMetadata = new Set<string>();
  createEffect(
    () => [identity(), ids()] as const,
    ([key, currentIds]) => {
      if (props.compact) return;
      for (const id of currentIds) {
        const request = `${key}:${id}`;
        if (
          untrack(() => drafts.get(key).files.some((file) => file.id === id)) ||
          requestedMetadata.has(request)
        )
          continue;
        requestedMetadata.add(request);
        void serverCall(getAttachmentMetadata({ data: [id] }))
          .then((file) => {
            const current = drafts.get(key);
            if (!current.files.some((item) => item.id === id))
              drafts.update(key, { files: [...current.files, file] });
          })
          .catch(() => {
            drafts.setError(
              key,
              "File details are unavailable. The original reference is retained.",
            );
          });
      }
    },
  );

  function attachQueuedFile(file: AttachmentSummary) {
    const insert = props.prepare();
    if (!ids().includes(file.id)) insert(attachmentMarkdown(file));
    insert("");
    drafts.update(identity(), {
      queued: draft().queued.filter((item) => item.id !== file.id),
    });
  }
  function removeFile(file: AttachmentSummary) {
    props.remove?.(file.id);
    drafts.update(identity(), {
      queued: draft().queued.filter((item) => item.id !== file.id),
    });
  }

  onCleanup(() => {
    disposed = true;
    unbindEvents?.();
  });

  return (
    <div
      class={`attachment-insert${props.compact ? " attachment-insert-compact" : ""}${props.horizontal ? " attachment-insert-strip" : ""}${dragging() ? " attachment-insert-drop" : ""}`}
      ref={(element) => {
        queueMicrotask(() => {
          if (disposed) return;
          unbindEvents?.();
          unbindEvents = bindAttachmentFormEvents({
            root: element,
            target: props.target?.(),
            onDragging: setDragging,
            onFiles: (files) => void upload(files),
            onSubmit: (event) => {
              if (busy()) {
                event.preventDefault();
                event.stopImmediatePropagation();
                drafts.setError(identity(), "Wait for the file upload to finish before sending.");
              } else {
                submittedIdentity = identity();
              }
            },
            onReset: () => {
              drafts.clear(submittedIdentity ?? identity());
              submittedIdentity = undefined;
            },
          });
        });
      }}
    >
      <input
        class="sr-only"
        tabindex="-1"
        type="file"
        name="attachments"
        accept={ACCEPTED_ATTACHMENTS}
        multiple
        ref={input}
        aria-label="Choose attachments"
        onChange={(event) => {
          if (pickerIdentity !== undefined && pickerIdentity !== identity()) {
            pickerIdentity = undefined;
            event.currentTarget.value = "";
            drafts.setError(
              identity(),
              "The upload destination changed. Choose the file again in the intended document.",
            );
            return;
          }
          pickerIdentity = undefined;
          void upload([...(event.currentTarget.files ?? [])]);
        }}
        disabled={blocked()}
      />
      <AttachmentFileTray
        files={prepared()}
        queued={draft().queued}
        horizontal={Boolean(props.horizontal)}
        scope={identity()}
        blocked={blocked()}
        hasRemoveHandler={Boolean(props.remove)}
        onAttach={attachQueuedFile}
        onRemove={removeFile}
      />
      <span class="attachment-text-entry">{props.textEntry}</span>
      <AttachmentPickerToolbar
        helpID={helpID}
        showButton={props.showButton !== false}
        horizontal={Boolean(props.horizontal)}
        busy={busy()}
        blocked={blocked()}
        dragging={dragging()}
        status={draftStatus(draft(), Boolean(uploaded().length || draft().queued.length))}
        sizeRestrictions={sizeRestrictions()}
        privacy={privacy()}
        selectionSummary={selectionSummary()}
        hasSelectedOrQueued={Boolean(ids().length || draft().queued.length)}
        hasUploadedOrQueued={Boolean(uploaded().length || draft().queued.length)}
        error={draftError(draft())}
        retryCount={draftRetryFiles(draft()).length}
        onChoose={() => choose()}
        onRetry={() => void upload(draftRetryFiles(draft()), true)}
      />
      <AttachmentTransferList transfers={draft().transfers} />
    </div>
  );
}
