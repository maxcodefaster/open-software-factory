import { createEffect, createSignal, For, Show } from "solid-js";
import { z } from "zod";
import { RichDocumentSurface } from "./rich-document-surface";
import { documentBlocks, type DocumentEditor, type DocumentFormat } from "./document-model";
import { filterDocumentBlocks } from "./document-slash";
import { editorPopoverPosition } from "./editor-popover-position";
import { useAttachmentProject } from "./attachments/ui";
import { attachmentIDs } from "../../../packages/conversation-domain/src/attachments";
import { TicketActionBar } from "./ticket-action-bar";
import { invoke } from "@solidjs/web/server-functions";
import { retainAttachmentDraft } from "./server-functions/attachments";
import { serverCall } from "./server-functions/result";

export const personalTicketDraftSchema = z.object({
  id: z.uuid(),
  title: z.string().max(200),
  description: z.string().max(10_000),
  stage: z.enum(["inbox", "ready"]).optional(),
  attachmentSequence: z.number().int().nonnegative().optional(),
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
  const attachmentProject = useAttachmentProject();
  let attachmentKey = attachmentIDs(props.initial.description).join(",");
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
      attachmentKey = "";
      if (attachmentIDs(props.initial.description).length) retain({});
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
    const value = {
      ...draft(),
      ...update,
      attachmentSequence: Math.max((draft().attachmentSequence ?? 0) + 1, Date.now() * 1000),
    };
    setDraft(value);
    props.onChange(value);
    try {
      localStorage.setItem(props.storageKey, JSON.stringify(value));
    } catch {
      /* Memory retains this draft. */
    }
    const ids = attachmentIDs(value.description);
    if (ids.join(",") !== attachmentKey) {
      attachmentKey = ids.join(",");
      const projectID = attachmentProject();
      const storageKey = props.storageKey;
      if (projectID)
        void serverCall(
          invoke(retainAttachmentDraft, { keepalive: true }, projectID, value.id, {
            sequence: value.attachmentSequence,
            ids,
          }),
        ).catch(() => {
          if (props.storageKey !== storageKey || draft().id !== value.id) return;
          setError(
            "Your text is retained locally, but file links could not be saved. Keep this draft open and create the Ticket before leaving.",
          );
        });
    }
  }
  function updateMenu(element: HTMLElement) {
    const selection = window.getSelection();
    const range = selection?.rangeCount ? selection.getRangeAt(0).cloneRange() : undefined;
    const slash = element.contains(range?.startContainer ?? null) ? editor?.slash() : undefined;
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
          <header class="ticket-document-heading workspace-heading">
            <input
              class="ticket-draft-title workspace-heading-title"
              aria-label="Ticket title"
              placeholder="What should change?"
              maxlength={200}
              value={draft().title}
              onInput={(event) => retain({ title: event.currentTarget.value })}
            />
            <TicketActionBar
              actions={[
                {
                  id: "idea",
                  label: "Create as idea",
                  primary: draft().stage === "inbox",
                  disabled: props.pending || !draft().title.trim(),
                  run: () => void create("inbox"),
                },
                {
                  id: "requirements",
                  label: "Write requirements",
                  primary: draft().stage !== "inbox",
                  disabled: props.pending || !draft().title.trim(),
                  run: () => void create("ready"),
                },
              ]}
            />
            <small class="ticket-draft-status workspace-heading-meta">
              Personal draft · not shared yet
            </small>
          </header>
          <RichDocumentSurface
            attachmentDraftId={draft().id}
            attachmentScopeKey={`ticket-draft:${draft().id}`}
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
