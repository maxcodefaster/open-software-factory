import { createEffect, createSignal, For, onSettled, Show } from "solid-js";
import {
  type DocumentEditor,
  documentSlash,
  editorCommandHeight,
  editorPopoverPosition,
  filterDocumentBlocks,
  supportsDocumentMarkdown,
} from "../editor/client";
import { DocumentLinkEditor } from "../editor/document-link-editor";
import { RichDocumentSurface } from "../editor/rich-document-surface";
import {
  type SelectionToolbar,
  type SlashBlock,
  type SlashMenu,
  slashBlocks,
  type TextSurfaceProps,
} from "./ticket-workspace-types";

export function RichTextSurface(props: TextSurfaceProps) {
  const [editor, setEditor] = createSignal<HTMLElement>();
  const sourceMode = () => !props.plain && !supportsDocumentMarkdown(props.value);

  function writeValue(element: HTMLElement, value: string) {
    element.textContent = value;
  }

  function readValue(element: HTMLElement) {
    return element.textContent ?? "";
  }

  createEffect(
    () => ({ element: editor(), value: props.value }),
    ({ element, value }) => {
      if (element && document.activeElement !== element) writeValue(element, value);
    },
  );
  createEffect(
    () => ({ element: editor(), onElement: props.onElement }),
    ({ element, onElement }) => {
      if (element) onElement?.(element);
    },
  );

  return (
    <Show
      when={sourceMode()}
      fallback={
        <Show
          when={props.plain}
          fallback={
            <RichDocumentSurface {...props} onFocus={(element) => props.onFocus?.(element)} />
          }
        >
          {/* biome-ignore lint/a11y: Inline title editing retains its document typography. Solid's lowercase tabindex makes this textbox keyboard focusable. */}
          <div
            ref={setEditor}
            class={`${props.class}${props.editable ? " inline-editor-surface" : ""}`}
            contenteditable={props.editable ? (props.plain ? "plaintext-only" : "true") : "false"}
            role="textbox"
            tabindex="0"
            aria-label={props.label}
            aria-readonly={props.editable ? "false" : "true"}
            aria-multiline={props.plain ? "false" : "true"}
            data-field={props.field}
            data-placeholder={props.placeholder}
            spellcheck="true"
            onFocus={(event) => props.onFocus?.(event.currentTarget)}
            onInput={(event) => props.onInput(readValue(event.currentTarget), event.currentTarget)}
            onKeyDown={(event) => props.onKeyDown(event, event.currentTarget)}
            onKeyUp={(event) => {
              if (!["ArrowDown", "ArrowUp", "Enter", "Escape"].includes(event.key)) {
                props.onSelection(event.currentTarget);
              }
            }}
            onMouseUp={(event) => props.onSelection(event.currentTarget)}
          />
        </Show>
      }
    >
      <div class="inline-source-field">
        <p class="inline-source-notice">Advanced Markdown stays in source format.</p>
        <textarea
          class="inline-markdown-source"
          aria-label={props.label}
          data-field={props.field}
          rows={Math.min(12, Math.max(4, props.value.split("\n").length))}
          value={props.value}
          readonly={!props.editable}
          onFocus={(event) => props.editable && props.onFocus?.(event.currentTarget)}
          onInput={(event) => props.onInput(event.currentTarget.value, event.currentTarget)}
          onKeyDown={(event) => props.onKeyDown(event, event.currentTarget)}
        />
      </div>
    </Show>
  );
}

export type EditorPopoverState =
  | { kind: "closed" }
  | { kind: "toolbar"; toolbar: SelectionToolbar; linkEditing: boolean }
  | { kind: "slash"; menu: SlashMenu; index: number };

export function createTicketEditorPopovers(options: {
  documentElement: () => HTMLElement | undefined;
  specificationVisible: () => boolean;
  hasChanges: () => boolean;
  onSaveChanges: () => void;
  onCancelEditing: () => void;
  onAppendAcceptance: () => void;
  onAppendNonGoal: () => void;
}) {
  const [popover, setPopover] = createSignal<EditorPopoverState>({ kind: "closed" });
  const [formattingElement, setFormattingElement] = createSignal<HTMLDivElement>();
  const [commandElement, setCommandElement] = createSignal<HTMLDivElement>();
  const editors = new WeakMap<HTMLElement, DocumentEditor>();

  const selectionToolbar = () => {
    const current = popover();
    return current.kind === "toolbar" ? current.toolbar : undefined;
  };
  const slashMenu = () => {
    const current = popover();
    return current.kind === "slash" ? current.menu : undefined;
  };
  const slashIndex = () => {
    const current = popover();
    return current.kind === "slash" ? current.index : 0;
  };
  const linkEditing = () => {
    const current = popover();
    return current.kind === "toolbar" && current.linkEditing;
  };

  const filteredSlashBlocks = () =>
    filterDocumentBlocks(
      options.specificationVisible()
        ? slashBlocks
        : slashBlocks.filter((block) => block.id !== "acceptance" && block.id !== "non-goal"),
      slashMenu()?.query ?? "",
    );

  function placePopover(element: HTMLElement | undefined, anchor: Range, preferBelow: boolean) {
    const documentRoot = options.documentElement();
    const root = documentRoot?.closest(".ticket-editor-frame")?.getBoundingClientRect();
    const viewport = documentRoot?.closest(".ticket-workspace")?.getBoundingClientRect();
    if (!element?.isConnected || !documentRoot || !root || !viewport) return;
    const gap = Number.parseFloat(getComputedStyle(element).getPropertyValue("--space-2"));
    const anchorBounds = anchor.getBoundingClientRect();
    const bounds = {
      left: Math.max(viewport.left, 0) + gap,
      right: Math.min(viewport.right, innerWidth) - gap,
      top: Math.max(viewport.top, 0) + gap,
      bottom: Math.min(viewport.bottom, innerHeight) - gap,
    };
    if (preferBelow)
      element.style.maxHeight = `${editorCommandHeight(anchorBounds, bounds, gap, Number.parseFloat(getComputedStyle(element).getPropertyValue("--space-12")) * 2)}px`;
    const size = element.getBoundingClientRect();
    const position = editorPopoverPosition({
      anchor: anchorBounds,
      bounds,
      width: size.width,
      height: size.height,
      gap,
      preferBelow,
      align: preferBelow || element.classList.contains("is-link-editing") ? "start" : "center",
    });
    element.style.left = `${position.left - root.left}px`;
    element.style.top = `${position.top - root.top}px`;
    element.setAttribute("data-placement", "floating");
    element.setAttribute("data-positioned", "true");
  }

  createEffect(
    () => ({
      popover: popover(),
      formatting: formattingElement(),
      command: commandElement(),
    }),
    (state) => {
      if (state.popover.kind === "closed") return;
      const active = state.popover;
      let disposed = false;
      const position = () => {
        if (disposed) return;
        if (active.kind === "toolbar") placePopover(state.formatting, active.toolbar.range, false);
        else placePopover(state.command, active.menu.range, true);
      };
      const viewport = options.documentElement()?.closest(".ticket-workspace");
      const dismiss = (event: PointerEvent) => {
        if (
          active.kind === "toolbar" &&
          event.target instanceof Node &&
          !state.formatting?.contains(event.target)
        ) {
          setPopover({ kind: "closed" });
        }
      };
      const observer = new ResizeObserver(position);
      if (active.kind === "toolbar" && state.formatting) observer.observe(state.formatting);
      if (active.kind === "slash" && state.command) observer.observe(state.command);
      if (viewport) observer.observe(viewport);
      viewport?.addEventListener("scroll", position);
      window.addEventListener("resize", position);
      document.addEventListener("pointerdown", dismiss);
      onSettled(position);
      return () => {
        disposed = true;
        observer.disconnect();
        viewport?.removeEventListener("scroll", position);
        window.removeEventListener("resize", position);
        document.removeEventListener("pointerdown", dismiss);
      };
    },
  );

  function updateSelectionToolbar(element: HTMLElement) {
    if (element.getAttribute("contenteditable") !== "true") {
      setPopover((current) => (current.kind === "toolbar" ? { kind: "closed" } : current));
      return;
    }
    const selection = window.getSelection();
    if (
      !selection ||
      selection.rangeCount === 0 ||
      selection.isCollapsed ||
      !element.contains(selection.anchorNode)
    ) {
      setPopover((current) =>
        current.kind === "toolbar" && !current.linkEditing ? { kind: "closed" } : current,
      );
      return;
    }
    const range = selection.getRangeAt(0).cloneRange();
    setPopover({ kind: "toolbar", toolbar: { element, range }, linkEditing: false });
  }

  function restoreSelection(range: Range) {
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
  }

  function syncSurface(element: HTMLElement) {
    element.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "formatBackColor" }));
  }

  function applyFormat(command: "bold" | "italic") {
    const current = popover();
    if (current.kind !== "toolbar") return;
    editors.get(current.toolbar.element)?.format(command, current.toolbar.range);
    setPopover({ kind: "closed" });
  }

  function startLinkEditing() {
    setPopover((current) =>
      current.kind === "toolbar" ? { ...current, linkEditing: true } : current,
    );
  }

  function closeFormatting() {
    const current = popover();
    setPopover({ kind: "closed" });
    if (current.kind === "toolbar") {
      current.toolbar.element.focus({ preventScroll: true });
      restoreSelection(current.toolbar.range);
    }
  }

  function applyLink(href: string) {
    const current = popover();
    if (current.kind !== "toolbar") return;
    editors.get(current.toolbar.element)?.link(href, current.toolbar.range);
    setPopover({ kind: "closed" });
  }

  function slashRange(element: HTMLElement) {
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0 || !selection.isCollapsed) return;
    const range = selection.getRangeAt(0);
    const container = range.startContainer;
    if (
      container.nodeType !== Node.TEXT_NODE ||
      !element.contains(container) ||
      range.startOffset < 1
    ) {
      return;
    }
    const token = documentSlash((container.textContent ?? "").slice(0, range.startOffset));
    if (token) return { range: range.cloneRange(), ...token };
  }

  function updateSlashMenu(element: HTMLElement) {
    const command = slashRange(element);
    if (!command) {
      setPopover((current) => (current.kind === "slash" ? { kind: "closed" } : current));
      return;
    }
    setPopover({ kind: "slash", menu: { element, ...command }, index: 0 });
  }

  function removeSlash(menu: SlashMenu) {
    const handle = editors.get(menu.element);
    if (handle) {
      handle.removeSlash();
      return;
    }
    const container = menu.range.startContainer;
    if (container.nodeType !== Node.TEXT_NODE || menu.range.startOffset < 1) return;
    const text = container as Text;
    const nextOffset = menu.range.startOffset - menu.length;
    if (text.data.at(nextOffset) !== "/") return;
    text.deleteData(nextOffset, menu.length);
    menu.range.setStart(text, nextOffset);
    menu.range.collapse(true);
    restoreSelection(menu.range);
    syncSurface(menu.element);
  }

  function insertSpecificationBlock(block: SlashBlock) {
    const current = popover();
    if (current.kind !== "slash") return;
    removeSlash(current.menu);
    setPopover({ kind: "closed" });
    if (block !== "acceptance" && block !== "non-goal") {
      editors.get(current.menu.element)?.format(block);
      return;
    }
    if (block === "acceptance") options.onAppendAcceptance();
    else options.onAppendNonGoal();
  }

  function editorKeyDown(event: KeyboardEvent, element: HTMLElement) {
    const current = popover();
    if (current.kind === "slash" && current.menu.element === element) {
      const optionsList = filteredSlashBlocks();
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        if (!optionsList.length) return;
        setPopover((prev) =>
          prev.kind === "slash"
            ? {
                ...prev,
                index:
                  event.key === "ArrowDown"
                    ? (prev.index + 1) % optionsList.length
                    : (prev.index - 1 + optionsList.length) % optionsList.length,
              }
            : prev,
        );
        return;
      }
      if (event.key === "Enter") {
        event.preventDefault();
        const block = optionsList[current.index];
        if (block) insertSpecificationBlock(block.id);
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        setPopover({ kind: "closed" });
        return;
      }
    }
    if (element.getAttribute("data-field") === "title" && event.key === "Enter") {
      event.preventDefault();
      return;
    }
    if ((event.metaKey || event.ctrlKey) && event.key === "Enter" && options.hasChanges()) {
      event.preventDefault();
      options.onSaveChanges();
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      options.onCancelEditing();
    }
  }

  function clearPopovers() {
    setPopover({ kind: "closed" });
  }

  function resetTicketPopovers() {
    setPopover({ kind: "closed" });
  }

  function registerEditor(element: HTMLElement, handle: DocumentEditor) {
    editors.set(element, handle);
  }

  return {
    popover,
    selectionToolbar,
    slashMenu,
    slashIndex,
    linkEditing,
    filteredSlashBlocks,
    setFormattingElement,
    setCommandElement,
    applyFormat,
    startLinkEditing,
    closeFormatting,
    applyLink,
    insertSpecificationBlock,
    updateSelectionToolbar,
    updateSlashMenu,
    editorKeyDown,
    clearPopovers,
    resetTicketPopovers,
    registerEditor,
  };
}

export type TicketEditorPopoversController = ReturnType<typeof createTicketEditorPopovers>;

export function TicketEditorPopovers(props: { controller: TicketEditorPopoversController }) {
  return (
    <>
      <Show when={props.controller.selectionToolbar()}>
        {(_toolbar) => (
          <div
            ref={props.controller.setFormattingElement}
            class={`selection-toolbar${props.controller.linkEditing() ? " is-link-editing" : ""}`}
            role="toolbar"
            aria-label="Text formatting"
            onKeyDown={(event) => {
              if (event.key !== "Escape") return;
              event.preventDefault();
              event.stopPropagation();
              props.controller.closeFormatting();
            }}
          >
            <Show
              when={props.controller.linkEditing()}
              fallback={
                <>
                  <button
                    type="button"
                    aria-label="Bold"
                    onPointerDown={(event) => event.preventDefault()}
                    onClick={() => props.controller.applyFormat("bold")}
                  >
                    B
                  </button>
                  <button
                    type="button"
                    class="italic"
                    aria-label="Italic"
                    onPointerDown={(event) => event.preventDefault()}
                    onClick={() => props.controller.applyFormat("italic")}
                  >
                    I
                  </button>
                  <button type="button" onClick={props.controller.startLinkEditing}>
                    Link
                  </button>
                </>
              }
            >
              <DocumentLinkEditor
                inputLabel="Link URL"
                onInsert={props.controller.applyLink}
                onCancel={props.controller.closeFormatting}
              />
            </Show>
          </div>
        )}
      </Show>

      <Show when={props.controller.slashMenu()}>
        {(_menu) => (
          <div
            ref={props.controller.setCommandElement}
            class="specification-command-menu caret-command-menu"
            role="menu"
            aria-label="Specification blocks"
          >
            <For each={props.controller.filteredSlashBlocks()}>
              {(block, index) => (
                <button
                  type="button"
                  role="menuitem"
                  class={props.controller.slashIndex() === index() ? "active" : undefined}
                  onPointerDown={(event) => event.preventDefault()}
                  onClick={() => props.controller.insertSpecificationBlock(block.id)}
                >
                  <span>{block.label}</span>
                </button>
              )}
            </For>
            <Show when={!props.controller.filteredSlashBlocks().length}>
              <small>No matching blocks</small>
            </Show>
          </div>
        )}
      </Show>
    </>
  );
}
