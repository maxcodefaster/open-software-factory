import { createEffect, createSignal, onCleanup } from "solid-js";
import {
  createDocumentEditor,
  type DocumentEditor,
  type DocumentBlockState,
} from "./document-editor";
import { DocumentBlockControls } from "./document-block-controls";

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
};

export function RichDocumentSurface(props: RichDocumentSurfaceProps) {
  let editor: DocumentEditor | undefined;
  let root: HTMLDivElement | undefined;
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
    <div class="rich-editor-host" ref={root}>
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
    </div>
  );
}
