import { createEffect, createSignal, For, Show } from "solid-js";
import { z } from "zod";
import { RichDocumentSurface } from "./rich-document-surface";
import { documentBlocks, type DocumentEditor, type DocumentFormat } from "./document-editor";
import { documentSlash, filterDocumentBlocks } from "./document-slash";
import { editorPopoverPosition } from "./editor-popover-position";

export const personalTicketDraftSchema = z.object({
  id: z.uuid(),
  title: z.string().max(200),
  description: z.string().max(10_000),
});
export type PersonalTicketDraft = z.infer<typeof personalTicketDraftSchema>;

export function readPersonalTicketDraft(key: string): PersonalTicketDraft {
  try {
    const parsed = personalTicketDraftSchema.safeParse(
      JSON.parse(localStorage.getItem(key) ?? "null"),
    );
    if (parsed.success) return parsed.data;
  } catch {
    /* A new local draft remains usable without browser storage. */
  }
  return { id: crypto.randomUUID(), title: "", description: "" };
}

export function TicketDraftWorkspace(props: {
  storageKey: string;
  initial: PersonalTicketDraft;
  pending: boolean;
  onChange(draft: PersonalTicketDraft): void;
  onCreate(draft: PersonalTicketDraft, stage: "inbox" | "ready"): Promise<boolean>;
}) {
  const [draft, setDraft] = createSignal(props.initial);
  const [error, setError] = createSignal("");
  const [menu, setMenu] = createSignal<{ query: string; range: Range; length: number }>();
  const [index, setIndex] = createSignal(0);
  const [selection, setSelection] = createSignal<{ range: Range }>();
  createEffect(
    () => props.storageKey,
    () => {
      setDraft(props.initial);
      setError("");
      setMenu(undefined);
      setSelection(undefined);
    },
  );
  let editor: DocumentEditor | undefined;
  let frame: HTMLDivElement | undefined;
  let popover: HTMLDivElement | undefined;
  let formatting: HTMLDivElement | undefined;
  const choices = () => filterDocumentBlocks(documentBlocks, menu()?.query ?? "");
  function position(element: HTMLDivElement | undefined, range: Range | undefined, below: boolean) {
    const anchor = range?.getBoundingClientRect();
    const bounds = frame?.getBoundingClientRect();
    if (!element || !anchor || !bounds) return;
    const size = element.getBoundingClientRect();
    const location = editorPopoverPosition({
      anchor,
      bounds,
      width: size.width,
      height: size.height,
      gap: Number.parseFloat(getComputedStyle(element).getPropertyValue("--space-2")),
      preferBelow: below,
    });
    if (!location) return;
    element.style.left = `${location.left - bounds.left}px`;
    element.style.top = `${location.top - bounds.top}px`;
    element.setAttribute("data-positioned", "true");
  }
  function select(element: HTMLElement) {
    const value = window.getSelection();
    const range =
      value &&
      !value.isCollapsed &&
      value.rangeCount &&
      element.contains(value.anchorNode) &&
      element.contains(value.focusNode)
        ? value.getRangeAt(0).cloneRange()
        : undefined;
    setSelection(range ? { range } : undefined);
    if (range) setMenu(undefined);
    queueMicrotask(() => position(formatting, range, false));
  }
  function format(command: DocumentFormat) {
    editor?.format(command, selection()?.range);
    setSelection(undefined);
  }
  function retain(update: Partial<PersonalTicketDraft>) {
    const value = { ...draft(), ...update };
    setDraft(value);
    props.onChange(value);
    try {
      localStorage.setItem(props.storageKey, JSON.stringify(value));
    } catch {
      /* Memory retains this draft. */
    }
  }
  function updateMenu(element: HTMLElement) {
    const selection = window.getSelection();
    const range = selection?.rangeCount ? selection.getRangeAt(0).cloneRange() : undefined;
    const before = range?.cloneRange();
    before?.selectNodeContents(element);
    if (before && range) before.setEnd(range.startContainer, range.startOffset);
    const slash = before ? documentSlash(before.toString()) : undefined;
    setMenu(slash && range ? { ...slash, range } : undefined);
    setIndex(0);
    queueMicrotask(() => position(popover, menu()?.range, true));
  }
  function insert(id: (typeof documentBlocks)[number]["id"]) {
    const current = menu();
    if (current) {
      editor?.removeSlash();
      editor?.format(id);
    }
    setMenu(undefined);
  }
  async function create(stage: "inbox" | "ready") {
    if (!draft().title.trim()) {
      setError("Give this ticket a title.");
      return;
    }
    setError("");
    if (!(await props.onCreate({ ...draft(), title: draft().title.trim() }, stage)))
      setError("Could not create the ticket. Your draft is retained.");
  }
  return (
    <section class="ticket-workspace ticket-draft-workspace" aria-label="New ticket draft">
      <div class="ticket-editor-frame" ref={frame}>
        <div class="ticket-document">
          <small class="ticket-draft-status">Personal draft · not shared yet</small>
          <input
            class="ticket-draft-title"
            aria-label="Ticket title"
            placeholder="What should change?"
            maxlength={200}
            value={draft().title}
            onInput={(event) => retain({ title: event.currentTarget.value })}
          />
          <RichDocumentSurface
            value={draft().description}
            label="Ticket description"
            field="description"
            editable={!props.pending}
            class="ticket-inline-description ticket-description markdown-body"
            placeholder="Describe the problem or intended outcome…"
            onFocus={() => {}}
            onSelection={select}
            onEditor={(_element, handle) => {
              editor = handle;
            }}
            onInput={(value, element) => {
              retain({ description: value });
              updateMenu(element);
            }}
            onKeyDown={(event) => {
              if (!menu()) return;
              if (event.key === "Escape") {
                event.preventDefault();
                setMenu(undefined);
              }
              if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                event.preventDefault();
                if (!choices().length) return;
                setIndex(
                  (value) =>
                    (value + (event.key === "ArrowDown" ? 1 : -1) + choices().length) %
                    choices().length,
                );
              }
              if (event.key === "Enter") {
                event.preventDefault();
                const choice = choices()[index()];
                if (choice) insert(choice.id);
              }
            }}
          />
          <div class="ticket-draft-actions">
            <button
              type="button"
              class="quiet-button"
              disabled={props.pending || !draft().title.trim()}
              onClick={() => void create("inbox")}
            >
              Create as idea
            </button>
            <button
              type="button"
              class="primary-button"
              disabled={props.pending || !draft().title.trim()}
              onClick={() => void create("ready")}
            >
              Write requirements
            </button>
          </div>
          <Show when={error()}>
            <p role="alert">{error()}</p>
          </Show>
        </div>
        <Show when={selection()}>
          <div
            class="selection-toolbar"
            role="toolbar"
            aria-label="Text formatting"
            ref={formatting}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.preventDefault();
                editor?.element.focus({ preventScroll: true });
                setSelection(undefined);
              }
            }}
          >
            <For
              each={
                [
                  { id: "bold", label: "Bold", text: "B" },
                  { id: "italic", label: "Italic", text: "I" },
                  { id: "code", label: "Inline code", text: "<>" },
                ] as const
              }
            >
              {(item) => (
                <button
                  type="button"
                  aria-label={item.label}
                  onPointerDown={(event) => event.preventDefault()}
                  onClick={() => format(item.id)}
                >
                  {item.text}
                </button>
              )}
            </For>
          </div>
        </Show>
        <Show when={menu()}>
          <div
            class="specification-command-menu caret-command-menu"
            role="menu"
            aria-label="Specification blocks"
            ref={popover}
          >
            <For each={choices()}>
              {(choice, choiceIndex) => (
                <button
                  type="button"
                  role="menuitem"
                  class={index() === choiceIndex() ? "active" : undefined}
                  onPointerDown={(event) => event.preventDefault()}
                  onClick={() => insert(choice.id)}
                >
                  {choice.label}
                </button>
              )}
            </For>
            <Show when={!choices().length}>
              <small>No matching blocks</small>
            </Show>
          </div>
        </Show>
      </div>
    </section>
  );
}
