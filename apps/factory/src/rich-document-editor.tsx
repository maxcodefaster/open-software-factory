import { createEffect, createSignal, onSettled, Show, untrack } from "solid-js";
import { AttachmentPicker, type AttachmentPickerHandle } from "./attachments/ui";
import { DocumentBlockControls } from "./document-block-controls";
import { createDocumentEditor } from "./document-editor";
import type { DocumentBlockState, DocumentEditor } from "./document-model";

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

export default function RichDocumentEditor(props: RichDocumentSurfaceProps) {
  const [editor, setEditor] = createSignal<DocumentEditor>();
  let root: HTMLDivElement | undefined;
  let host: HTMLDivElement | undefined;
  let attachments: AttachmentPickerHandle | undefined;
  const [block, setBlock] = createSignal<DocumentBlockState>();
  createEffect(
    () => ({ instance: editor(), value: props.value }),
    ({ instance, value }) => instance?.value(value),
  );
  createEffect(
    () => ({ instance: editor(), editable: props.editable }),
    ({ instance, editable }) => instance?.editable(editable),
  );
  createEffect(
    () => ({
      instance: editor(),
      label: props.label,
      field: props.field,
      placeholder: props.placeholder,
      onElement: props.onElement,
      onEditor: props.onEditor,
    }),
    ({ instance, label, field, placeholder, onElement, onEditor }) => {
      if (!instance) return;
      instance.element.setAttribute("aria-label", label);
      instance.element.dataset["field"] = field;
      instance.element.dataset["placeholder"] = placeholder ?? "";
      onElement?.(instance.element);
      onEditor?.(instance.element, instance);
    },
  );
  onSettled(() => {
    if (!host || !root) return;
    // The engine is mounted once. Value, permissions and accessibility metadata
    // above remain reactive; event callbacks read their current handlers.
    const initial = untrack(() => ({
      value: props.value,
      editable: props.editable,
      label: props.label,
      className: `${props.class}${props.editable ? " inline-editor-surface" : ""}`,
      field: props.field,
      ...(props.placeholder ? { placeholder: props.placeholder } : {}),
    }));
    const instance = createDocumentEditor({
      host,
      ...initial,
      onFocus: (element) => props.onFocus(element),
      onInput: (value, element) => props.onInput(value, element),
      onKeyDown: (event, element) => props.onKeyDown(event, element),
      onSelection: (element) => props.onSelection(element),
      onBlock: setBlock,
    });
    const element = root;
    const choose = (event: Event) => attachments?.choose((event as CustomEvent).detail === "image");
    element.addEventListener("factory-choose-attachment", choose);
    setEditor(instance);
    return () => {
      element.removeEventListener("factory-choose-attachment", choose);
      instance.destroy();
    };
  });
  return (
    <div class="rich-editor-host" ref={root}>
      <div ref={host} />
      <DocumentBlockControls
        state={block()}
        editor={editor()}
        host={editor() ? root : undefined}
        editable={props.editable}
      />
      <Show when={props.editable}>
        <AttachmentPicker
          compact
          showButton={false}
          disabled={!props.editable}
          draftId={props.attachmentDraftId}
          scopeKey={props.attachmentScopeKey}
          fieldKey={props.label}
          content={props.value}
          privacy={
            props.attachmentDraftId ? "create" : props.field === "knowledge" ? "autosave" : "save"
          }
          target={() => editor()?.element}
          prepare={() => editor()?.prepareAttachment() ?? (() => {})}
          ref={(handle) => {
            attachments = handle;
          }}
        />
      </Show>
    </div>
  );
}
