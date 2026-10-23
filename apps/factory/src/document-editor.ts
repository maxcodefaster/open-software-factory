import { Editor } from "@tiptap/core";
import { StarterKit } from "@tiptap/starter-kit";
import { Markdown } from "@tiptap/markdown";
import { TableKit } from "@tiptap/extension-table";
import { TaskList } from "@tiptap/extension-task-list";
import { TaskItem } from "@tiptap/extension-task-item";
import { documentSlash } from "./document-slash";
import { CodeBlockLowlight } from "@tiptap/extension-code-block-lowlight";
import { codeHighlighter } from "./code-highlighting";
import { TextSelection } from "@tiptap/pm/state";
import { preserveDocumentSelection } from "./document-selection";
import { Image } from "@tiptap/extension-image";
import type { SelectionBookmark } from "@tiptap/pm/state";

export const documentBlocks = [
  { id: "paragraph", label: "Text" },
  { id: "heading", label: "Heading" },
  { id: "bullet-list", label: "Bullet list" },
  { id: "numbered-list", label: "Numbered list" },
  { id: "checklist", label: "Checklist" },
  { id: "quote", label: "Quote" },
  { id: "code-block", label: "Code block" },
  { id: "table", label: "Table" },
  { id: "divider", label: "Divider" },
  { id: "image", label: "Image" },
  { id: "file", label: "File" },
] as const;
export type DocumentBlock = (typeof documentBlocks)[number]["id"];
export type DocumentFormat = DocumentBlock | "bold" | "italic" | "code";

export function documentExtensions() {
  return [
    StarterKit.configure({ link: { openOnClick: false }, codeBlock: false }),
    CodeBlockLowlight.configure({ lowlight: codeHighlighter, defaultLanguage: "plaintext" }),
    Markdown,
    Image.extend({
      addNodeView() {
        return ({ node }) => {
          const dom = document.createElement("figure");
          dom.className = "document-attachment";
          const image = document.createElement("img");
          image.className = "document-attachment-image";
          image.loading = "lazy";
          const open = document.createElement("a");
          open.className = "attachment-image-action";
          open.target = "_blank";
          open.rel = "noopener noreferrer";
          open.textContent = "Open image";
          const update = (attributes: Record<string, unknown>) => {
            const src = String(attributes["src"] ?? "");
            if (!/^\/api\/attachments\/[a-f0-9-]{36}$/i.test(src)) return false;
            image.src = `${src}/previews/0`;
            image.alt = String(attributes["alt"] ?? "");
            open.href = src;
            open.setAttribute("aria-label", `Open image ${image.alt} in new tab`);
            return true;
          };
          update(node.attrs);
          dom.append(image, open);
          return {
            dom,
            update: (next) => next.type === node.type && update(next.attrs),
            stopEvent: (event) => event.target instanceof Node && open.contains(event.target),
          };
        };
      },
      parseHTML: () => [
        {
          tag: "img[src]",
          getAttrs: (node) =>
            /^\/api\/attachments\/[a-f0-9-]{36}$/.test(node.getAttribute("src") ?? "")
              ? null
              : false,
        },
      ],
    }).configure({
      allowBase64: false,
      HTMLAttributes: { class: "document-attachment-image", loading: "lazy" },
    }),
    TableKit.configure({ table: { resizable: false } }),
    TaskList,
    TaskItem.configure({ nested: true }),
  ];
}

// Unsupported authored constructs remain available in source rather than being dropped on save.
export function supportsDocumentMarkdown(value: string) {
  return !/(!\[|^\s*\[[^\]]+\]:|<\/?[a-z][^>]*>|^---\s*\n[\s\S]+?\n---\s*$)/im.test(
    value
      .replace(/<br\s*\/?>/gi, "")
      .replace(/!\[[^\]]*\]\(\/api\/attachments\/[a-f0-9-]{36}\)/gi, ""),
  );
}

export type DocumentEditor = {
  element: HTMLElement;
  focused(): boolean;
  value(value: string): void;
  editable(value: boolean): void;
  format(command: DocumentFormat, selection?: Range): void;
  link(url: string, selection?: Range): void;
  removeSlash(): void;
  prepareAttachment(): (markdown: string) => void;
  table(command: TableCommand): void;
  language(value: string): void;
  destroy(): void;
};
export type TableCommand =
  | "addColumnBefore"
  | "addColumnAfter"
  | "deleteColumn"
  | "addRowBefore"
  | "addRowAfter"
  | "deleteRow"
  | "toggleHeaderRow"
  | "deleteTable";
export type DocumentBlockState =
  | { kind: "table"; element: HTMLElement }
  | { kind: "code"; element: HTMLElement; text: string; language: string };

export function createDocumentEditor(input: {
  host: HTMLElement;
  value: string;
  editable: boolean;
  label: string;
  className: string;
  placeholder?: string;
  field: string;
  onFocus(element: HTMLElement): void;
  onInput(value: string, element: HTMLElement): void;
  onSelection(element: HTMLElement): void;
  onKeyDown(event: KeyboardEvent, element: HTMLElement): void;
  onBlock?(state: DocumentBlockState | undefined): void;
}): DocumentEditor {
  let disposed = false;
  let publishedValue = input.value;
  let selectingWithPointer = false;
  const pendingAttachments = new Set<{ bookmark: SelectionBookmark }>();
  const finishPointerSelection = () => {
    selectingWithPointer = false;
    queueMicrotask(() => !disposed && input.onSelection(editor.view.dom));
  };
  const editor = new Editor({
    element: input.host,
    content: input.value,
    contentType: "markdown",
    extensions: documentExtensions(),
    editable: input.editable,
    injectCSS: false,
    editorProps: {
      attributes: {
        class: input.className,
        role: "textbox",
        tabindex: "0",
        "aria-label": input.label,
        "aria-multiline": "true",
        "aria-readonly": input.editable ? "false" : "true",
        "data-field": input.field,
        "data-placeholder": input.placeholder ?? "",
      },
      handleDOMEvents: {
        mousedown: () => {
          selectingWithPointer = true;
          document.addEventListener("mouseup", finishPointerSelection, { once: true });
          return false;
        },
        keydown: (view, event) => {
          // A key can precede the browser's selectionchange after a click/undo. Use the
          // visible selection without replacing node/cell selections or composing text.
          const selection = window.getSelection();
          if (
            !event.isComposing &&
            !view.composing &&
            selection?.anchorNode &&
            selection.focusNode &&
            view.dom.contains(selection.anchorNode) &&
            view.dom.contains(selection.focusNode) &&
            view.state.selection instanceof TextSelection
          ) {
            const anchor = view.posAtDOM(selection.anchorNode, selection.anchorOffset);
            const head = view.posAtDOM(selection.focusNode, selection.focusOffset);
            if (anchor !== view.state.selection.anchor || head !== view.state.selection.head)
              view.dispatch(
                view.state.tr.setSelection(TextSelection.create(view.state.doc, anchor, head)),
              );
          }
          input.onKeyDown(event, editor.view.dom);
          return event.defaultPrevented;
        },
      },
    },
    onFocus: () => input.onFocus(editor.view.dom),
    onUpdate: () => {
      editor.view.dom.setAttribute("data-empty", String(editor.isEmpty));
      publishedValue = editor.getMarkdown();
      input.onInput(publishedValue, editor.view.dom);
      notifyBlock();
    },
    onSelectionUpdate: () => {
      if (!selectingWithPointer) input.onSelection(editor.view.dom);
      notifyBlock();
    },
    onTransaction: ({ transaction }) => {
      for (const pending of pendingAttachments)
        pending.bookmark = pending.bookmark.map(transaction.mapping);
    },
  });
  // Let the upstream trailing-paragraph plugin establish a writable position after a
  // terminal table/code block before the first navigation key, without emitting a save.
  editor.view.dispatch(
    editor.state.tr.setMeta("preventUpdate", true).setMeta("addToHistory", false),
  );
  function notifyBlock() {
    const { $from } = editor.state.selection;
    for (let depth = $from.depth; depth > 0; depth--) {
      const node = $from.node(depth);
      if (node.type.name !== "table" && node.type.name !== "codeBlock") continue;
      const element = editor.view.nodeDOM($from.before(depth));
      if (!(element instanceof HTMLElement)) break;
      input.onBlock?.(
        node.type.name === "table"
          ? { kind: "table", element }
          : {
              kind: "code",
              element,
              text: node.textContent,
              language: node.attrs["language"] ?? "plaintext",
            },
      );
      return;
    }
    input.onBlock?.(undefined);
  }
  editor.view.dom.setAttribute("data-empty", String(editor.isEmpty));
  function selectedChain(range?: Range) {
    const chain = editor.chain();
    if (range) {
      if (
        !editor.view.dom.contains(range.startContainer) ||
        !editor.view.dom.contains(range.endContainer)
      )
        return;
      chain.setTextSelection({
        from: editor.view.posAtDOM(range.startContainer, range.startOffset),
        to: editor.view.posAtDOM(range.endContainer, range.endOffset),
      });
    }
    return chain.focus(undefined, { scrollIntoView: !range });
  }
  function format(command: DocumentFormat, selection?: Range) {
    const chain = selectedChain(selection);
    if (!chain) return;
    switch (command) {
      case "paragraph":
        chain.setParagraph().run();
        break;
      case "heading":
        chain.toggleHeading({ level: 2 }).run();
        break;
      case "bold":
        chain.toggleBold().run();
        break;
      case "italic":
        chain.toggleItalic().run();
        break;
      case "code":
        chain.toggleCode().run();
        break;
      case "bullet-list":
        chain.toggleBulletList().run();
        break;
      case "numbered-list":
        chain.toggleOrderedList().run();
        break;
      case "checklist":
        chain.toggleTaskList().run();
        break;
      case "quote":
        chain.toggleBlockquote().run();
        break;
      case "code-block":
        chain.toggleCodeBlock().run();
        break;
      case "table":
        chain.insertTable({ rows: 3, cols: 2, withHeaderRow: true }).run();
        break;
      case "divider":
        chain.setHorizontalRule().run();
        break;
      case "image":
      case "file":
        editor.view.dom.dispatchEvent(
          new CustomEvent("factory-choose-attachment", { bubbles: true, detail: command }),
        );
        break;
    }
  }
  return {
    element: editor.view.dom,
    focused: () => editor.isFocused,
    value: (value) => {
      if (value === publishedValue) return;
      publishedValue = value;
      if (editor.getMarkdown() !== value) {
        const parsed = editor.storage.markdown.manager.parse(value);
        const next = editor.schema.nodeFromJSON(parsed);
        const current = editor.state.doc.content;
        const start = current.findDiffStart(next.content);
        if (start !== null) {
          const end = current.findDiffEnd(next.content);
          if (end) {
            // Native selectionchange can arrive after the new revision. Preserve the
            // visible browser selection, not the editor's previous internal position.
            let selection = editor.state.selection;
            const visible = editor.view.dom.ownerDocument.getSelection();
            if (
              selection instanceof TextSelection &&
              !editor.view.composing &&
              visible?.anchorNode &&
              visible.focusNode &&
              editor.view.dom.contains(visible.anchorNode) &&
              editor.view.dom.contains(visible.focusNode)
            )
              selection = TextSelection.create(
                editor.state.doc,
                editor.view.posAtDOM(visible.anchorNode, visible.anchorOffset),
                editor.view.posAtDOM(visible.focusNode, visible.focusOffset),
              );
            const overlap = start - Math.min(end.a, end.b);
            const transaction = editor.state.tr.replace(
              start,
              end.a + Math.max(0, overlap),
              next.slice(start, end.b + Math.max(0, overlap)),
            );
            if (selection instanceof TextSelection)
              preserveDocumentSelection(transaction, selection);
            transaction.setMeta("addToHistory", false).setMeta("preventUpdate", true);
            editor.view.dispatch(transaction);
          }
        }
        editor.view.dom.setAttribute("data-empty", String(editor.isEmpty));
      }
    },
    editable: (value) => {
      editor.setEditable(value, false);
      editor.view.dom.setAttribute("aria-readonly", value ? "false" : "true");
      editor.view.dom.classList.toggle("inline-editor-surface", value);
    },
    format,
    prepareAttachment: () => {
      const pending = { bookmark: editor.state.selection.getBookmark() };
      pendingAttachments.add(pending);
      return (markdown) => {
        if (!markdown) {
          pendingAttachments.delete(pending);
          return;
        }
        if (disposed) return;
        const selected = pending.bookmark.resolve(editor.state.doc);
        const content = editor.storage.markdown.manager.parse(markdown);
        editor
          .chain()
          .focus()
          .setTextSelection({ from: selected.to, to: selected.to })
          .insertContent(content.content ?? [])
          .run();
        pending.bookmark = editor.state.selection.getBookmark();
      };
    },
    table: (command) => {
      editor.chain()[command]().run();
      editor.view.focus();
    },
    language: (language) => {
      editor.commands.updateAttributes("codeBlock", { language });
      editor.view.focus();
    },
    link: (href, selection) => {
      selectedChain(selection)?.setLink({ href }).run();
    },
    removeSlash: () => {
      const { from, to } = editor.state.selection;
      const token = documentSlash(editor.state.doc.textBetween(Math.max(0, from - 42), from, "\n"));
      if (from === to && token)
        editor
          .chain()
          .focus()
          .deleteRange({ from: from - token.length, to: from })
          .run();
    },
    destroy: () => {
      disposed = true;
      document.removeEventListener("mouseup", finishPointerSelection);
      editor.destroy();
    },
  };
}
