import { createEffect, createSignal, For, onSettled, Show } from "solid-js";
import {
  documentBlocks,
  supportsDocumentMarkdown,
  type DocumentEditor,
  type DocumentFormat,
} from "./document-model";
import { RichDocumentSurface } from "./rich-document-surface";
import { editorCommandHeight, editorPopoverPosition } from "./editor-popover-position";
import { documentSlash, filterDocumentBlocks } from "./document-slash";
import { DocumentLinkEditor } from "./document-link-editor";

export function MarkdownEditor(props: {
  value: string;
  onChange(value: string): void;
  label?: string;
  attachmentScopeKey?: string | undefined;
}) {
  let editor: DocumentEditor | undefined;
  let root: HTMLDivElement | undefined;
  const [menu, setMenu] = createSignal<{ range: Range; slash: boolean; query: string }>();
  const [control, setControl] = createSignal<HTMLDivElement>();
  const [index, setIndex] = createSignal(0);
  const [linkEditing, setLinkEditing] = createSignal(false);
  const blocks = () => filterDocumentBlocks(documentBlocks, menu()?.query ?? "");

  function selection(element: HTMLElement) {
    const value = window.getSelection();
    if (
      !value?.rangeCount ||
      !element.contains(value.anchorNode) ||
      !element.contains(value.focusNode)
    ) {
      setMenu(undefined);
      return;
    }
    const range = value.getRangeAt(0);
    const token =
      value.isCollapsed &&
      range.startContainer.nodeType === Node.TEXT_NODE &&
      documentSlash((range.startContainer.textContent ?? "").slice(0, range.startOffset));
    if (!value.isCollapsed || token) {
      setLinkEditing(false);
      setMenu({ range: range.cloneRange(), slash: !!token, query: token ? token.query : "" });
      setIndex(0);
    } else setMenu(undefined);
  }
  function format(command: DocumentFormat) {
    const selected = menu()?.slash ? undefined : menu()?.range;
    if (menu()?.slash) editor?.removeSlash();
    setMenu(undefined);
    setLinkEditing(false);
    editor?.format(command, selected);
  }
  function keyDown(event: KeyboardEvent) {
    const current = menu();
    if (event.key === "Escape") {
      setMenu(undefined);
      setLinkEditing(false);
      return;
    }
    if (!current?.slash || event.isComposing) return;
    const options = blocks();
    if (!options.length) return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      setIndex(
        (value) => (value + (event.key === "ArrowDown" ? 1 : -1) + options.length) % options.length,
      );
    } else if (event.key === "Enter") {
      event.preventDefault();
      const block = options[index()];
      if (block) format(block.id);
    }
  }
  function closeFormatting() {
    const range = menu()?.range;
    setMenu(undefined);
    setLinkEditing(false);
    const surface = root?.querySelector<HTMLElement>('[contenteditable="true"]');
    surface?.focus({ preventScroll: true });
    if (range) {
      const selected = window.getSelection();
      selected?.removeAllRanges();
      selected?.addRange(range);
    }
  }
  function applyLink(href: string) {
    editor?.link(href, menu()?.range);
    setMenu(undefined);
    setLinkEditing(false);
  }
  createEffect(
    () => ({ menu: menu(), element: control(), link: linkEditing() }),
    ({ menu: current, element }) => {
      if (!current || !element || !root) return;
      let disposed = false;
      const place = () => {
        if (disposed) return;
        if (!element.isConnected || !root) return;
        const viewport =
          root.closest(".knowledge-content")?.getBoundingClientRect() ??
          root.getBoundingClientRect();
        const gap = parseFloat(getComputedStyle(element).getPropertyValue("--space-2"));
        const anchor = current.range.getBoundingClientRect();
        const bounds = {
          left: Math.max(0, viewport.left) + gap,
          right: Math.min(innerWidth, viewport.right) - gap,
          top: Math.max(0, viewport.top) + gap,
          bottom: Math.min(innerHeight, viewport.bottom) - gap,
        };
        if (current.slash)
          element.style.maxHeight = `${editorCommandHeight(anchor, bounds, gap, parseFloat(getComputedStyle(element).getPropertyValue("--space-12")) * 2)}px`;
        const size = element.getBoundingClientRect();
        const position = editorPopoverPosition({
          anchor,
          bounds,
          width: size.width,
          height: size.height,
          gap,
          preferBelow: current.slash,
          align:
            current.slash || element.classList.contains("is-link-editing") ? "start" : "center",
        });
        if (!position) return;
        const origin = root.getBoundingClientRect();
        element.style.left = `${position.left - origin.left}px`;
        element.style.top = `${position.top - origin.top}px`;
        element.setAttribute("data-positioned", "true");
      };
      const viewport = root.closest(".knowledge-content");
      const dismiss = (event: PointerEvent) => {
        if (event.target instanceof Node && !element.contains(event.target)) {
          setMenu(undefined);
          setLinkEditing(false);
        }
      };
      const observer = new ResizeObserver(place);
      observer.observe(element);
      if (viewport) observer.observe(viewport);
      viewport?.addEventListener("scroll", place);
      window.addEventListener("resize", place);
      document.addEventListener("pointerdown", dismiss);
      onSettled(place);
      return () => {
        disposed = true;
        observer.disconnect();
        viewport?.removeEventListener("scroll", place);
        window.removeEventListener("resize", place);
        document.removeEventListener("pointerdown", dismiss);
      };
    },
  );
  return (
    <div class="markdown-editor" ref={root} onScroll={() => setMenu(undefined)}>
      <Show
        when={supportsDocumentMarkdown(props.value)}
        fallback={
          <div class="inline-source-field">
            <p class="inline-source-notice">Advanced Markdown stays in source format.</p>
            <textarea
              class="source-editor"
              aria-label="Markdown source"
              value={props.value}
              onInput={(event) => props.onChange(event.currentTarget.value)}
            />
          </div>
        }
      >
        <RichDocumentSurface
          attachmentScopeKey={props.attachmentScopeKey}
          value={props.value}
          editable={true}
          field="knowledge"
          label={props.label ?? "Knowledge body"}
          class="visual-editor markdown-body"
          onEditor={(_element, handle) => {
            editor = handle;
          }}
          onFocus={() => {}}
          onInput={(value, element) => {
            props.onChange(value);
            selection(element);
          }}
          onKeyDown={keyDown}
          onSelection={selection}
        />
      </Show>
      <Show when={menu()}>
        {(current) => (
          <Show
            when={current().slash}
            fallback={
              <div
                class={`selection-toolbar document-floating-control${linkEditing() ? " is-link-editing" : ""}`}
                role="toolbar"
                aria-label="Knowledge selection formatting"
                ref={setControl}
                onMouseDown={(event) => {
                  if (!linkEditing()) event.preventDefault();
                }}
                onKeyDown={(event) => {
                  if (event.key !== "Escape") return;
                  event.preventDefault();
                  event.stopPropagation();
                  closeFormatting();
                }}
              >
                <Show
                  when={!linkEditing()}
                  fallback={
                    <DocumentLinkEditor
                      inputLabel="Link address"
                      onInsert={applyLink}
                      onCancel={closeFormatting}
                    />
                  }
                >
                  <button type="button" onClick={() => format("bold")} aria-label="Bold">
                    B
                  </button>
                  <button
                    type="button"
                    class="italic"
                    onClick={() => format("italic")}
                    aria-label="Italic"
                  >
                    I
                  </button>
                  <button type="button" onClick={() => format("code")} aria-label="Code">
                    Code
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setLinkEditing(true);
                    }}
                  >
                    Link
                  </button>
                </Show>
              </div>
            }
          >
            <div
              class="specification-command-menu caret-command-menu document-floating-control"
              role="menu"
              aria-label="Knowledge blocks"
              ref={setControl}
              onMouseDown={(event) => event.preventDefault()}
            >
              <For each={blocks()}>
                {(block, position) => (
                  <button
                    type="button"
                    role="menuitem"
                    class={position() === index() ? "active" : ""}
                    onClick={() => format(block.id)}
                  >
                    {block.label}
                  </button>
                )}
              </For>
              <Show when={!blocks().length}>
                <small>No matching blocks</small>
              </Show>
            </div>
          </Show>
        )}
      </Show>
    </div>
  );
}
