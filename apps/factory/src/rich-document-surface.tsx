import { createEffect, createSignal, onCleanup, Show } from "solid-js";
import {
  createDocumentEditor,
  type DocumentEditor,
  type DocumentBlockState,
} from "./document-editor";
import { DocumentBlockControls } from "./document-block-controls";
import { AttachmentPicker, type AttachmentPickerHandle } from "./attachments/ui";

export type RichDocumentSurfaceProps = {
  value: string;
  label: string;
  field: string;
  editable: boolean;
  placeholder?: string;
  class: string;
  onElement?(element: HTMLElement): void;
  onEditor?(element: HTMLElement, handle: DocumentEditor): void;
  onFocus(element: HTMLElement): void;
  onInput(value: string, element: HTMLElement): void;
  onKeyDown(event: KeyboardEvent, element: HTMLElement): void;
  onSelection(element: HTMLElement): void;
  attachmentDraftId?: string | undefined;
  attachmentScopeKey?: string | undefined;
};

export function RichDocumentSurface(props: RichDocumentSurfaceProps) {
  let editor: DocumentEditor | undefined;
  let root: HTMLDivElement | undefined;
  let attachments: AttachmentPickerHandle | undefined;
  const [block, setBlock] = createSignal<DocumentBlockState>();
  createEffect(
    () => props.value,
    (value) => {
      editor?.value(value);
    },
  );
  createEffect(
    () => props.editable,
    (editable) => editor?.editable(editable),
  );
  onCleanup(() => editor?.destroy());
  return (
    <div
      class="rich-editor-host"
      ref={(element) => {
        root = element;
        const choose = (event: Event) =>
          attachments?.choose((event as CustomEvent).detail === "image");
        element.addEventListener("factory-choose-attachment", choose);
        onCleanup(() => element.removeEventListener("factory-choose-attachment", choose));
      }}
    >
      <div
        ref={(host) => {
          editor = createDocumentEditor({
            host,
            value: props.value,
            editable: props.editable,
            label: props.label,
            className: `${props.class}${props.editable ? " inline-editor-surface" : ""}`,
            field: props.field,
            ...(props.placeholder ? { placeholder: props.placeholder } : {}),
            onFocus: props.onFocus,
            onInput: props.onInput,
            onKeyDown: props.onKeyDown,
            onSelection: props.onSelection,
            onBlock: setBlock,
          });
          props.onElement?.(editor.element);
          props.onEditor?.(editor.element, editor);
        }}
      />
      <DocumentBlockControls
        state={block()}
        editor={editor}
        host={root}
        editable={props.editable}
      />
      <Show when={props.editable}>
        <AttachmentPicker
          compact
          showButton={["knowledge", "description", "summary"].includes(props.field)}
          disabled={!props.editable}
          draftId={props.attachmentDraftId}
          scopeKey={props.attachmentScopeKey}
          fieldKey={props.label}
          content={props.value}
          privacy={
            props.attachmentDraftId ? "create" : props.field === "knowledge" ? "autosave" : "save"
          }
          target={() => editor?.element}
          prepare={() => editor?.prepareAttachment() ?? (() => {})}
          ref={(handle) => {
            attachments = handle;
          }}
        />
      </Show>
    </div>
  );
}
