import type { JSX } from "@solidjs/web";
import { createEffect, createSignal, onCleanup } from "solid-js";
import { attachmentIDs } from "#conversation-domain/attachments";
import { AttachmentPicker, type AttachmentPickerHandle } from "./attachment-picker";
import { AttachmentProvider, useAttachmentPending, useAttachmentProject } from "./attachment-scope";
import {
  readAttachmentContent,
  restoreAttachmentContent,
  splitAttachmentContent,
} from "./composer";
import { type AttachmentPrivacy, detectAttachmentFileType } from "./upload-state";
import "./attachments.css";

export type { AttachmentPickerHandle };
export { AttachmentPicker, AttachmentProvider, useAttachmentPending, useAttachmentProject };

export function attachmentFileType(file: File) {
  return detectAttachmentFileType(file);
}

export function TextareaAttachments(props: {
  children?: JSX.Element;
  disabled?: boolean | undefined;
  draftId?: string | undefined;
  scopeKey?: string | undefined;
  privacy?: AttachmentPrivacy;
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
          const target = root?.closest("form")?.querySelector("textarea");
          if (!target) return;
          const current = splitAttachmentContent(readAttachmentContent(target));
          restoreAttachmentContent(
            target,
            [current.text, ...current.files.filter((file) => !attachmentIDs(file).includes(id))]
              .filter(Boolean)
              .join("\n\n"),
          );
          target.dispatchEvent(new Event("input", { bubbles: true }));
          target.focus({ preventScroll: true });
        }}
        prepare={() => {
          const target = root?.closest("form")?.querySelector("textarea");
          return (markdown) => {
            if (!markdown || !target?.isConnected) return;
            const current = readAttachmentContent(target);
            restoreAttachmentContent(target, `${current ? `${current}\n\n` : ""}${markdown}`);
            target.dispatchEvent(new Event("input", { bubbles: true }));
          };
        }}
      />
    </span>
  );
}
