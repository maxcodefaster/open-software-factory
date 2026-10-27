import { Portal } from "@solidjs/web";
import { createEffect, createSignal, For, Show } from "solid-js";
import { mentionText } from "../../../../packages/ticket-domain/src/attention";
import { getAttentionPeople } from "../server-functions/inbox";
import { serverCall } from "../server-functions/result";
import type { AttentionPerson } from "./contracts";
import "./inbox.css";

// Delegated input support keeps native textarea refs, attachment serialization,
// retained drafts, and each existing composer's submit behavior intact.
export function MentionSupport(props: {
  projectID: string | undefined;
  sharedTicket: boolean;
  loadPeople?: (id: string) => Promise<AttentionPerson[]>;
}) {
  const [options, setOptions] = createSignal<AttentionPerson[]>([]);
  const [selected, setSelected] = createSignal(0);
  const [open, setOpen] = createSignal(false);
  const [loading, setLoading] = createSignal(false);
  const [error, setError] = createSignal("");
  const [position, setPosition] = createSignal({ left: 8, top: 8, width: 280 });
  let input: HTMLTextAreaElement | undefined;
  let start = 0,
    end = 0,
    generation = 0;
  let people: AttentionPerson[] = [];
  let popup: HTMLDivElement | undefined;
  const listID = `mention-options-${crypto.randomUUID()}`;
  function close() {
    generation++;
    setOpen(false);
    setOptions([]);
    setLoading(false);
    input?.removeAttribute("aria-controls");
    input?.removeAttribute("aria-activedescendant");
    input?.removeAttribute("aria-autocomplete");
    input = undefined;
  }
  function positionPopup() {
    if (!input?.isConnected) return close();
    const bounds = input.getBoundingClientRect();
    const width = Math.min(320, innerWidth - 16);
    const top =
      bounds.bottom + 240 > innerHeight ? Math.max(8, bounds.top - 240) : bounds.bottom + 4;
    setPosition({ left: Math.max(8, Math.min(bounds.left, innerWidth - width - 8)), top, width });
  }
  function choose(person: AttentionPerson) {
    const target = input;
    if (!target || target.disabled) return;
    target.setRangeText(`${mentionText(person)} `, start, end, "end");
    close();
    target.dispatchEvent(new Event("input", { bubbles: true }));
    target.focus();
  }
  async function update(target: HTMLTextAreaElement) {
    const projectID = props.projectID;
    if (
      !projectID ||
      target.disabled ||
      !(
        target.closest(".review-composer, .review-reply-composer") ||
        (props.sharedTicket && target.name === "message")
      )
    )
      return close();
    const cursor = target.selectionStart;
    const token = /(?:^|\s)@([^\s@[\]]{0,40})$/.exec(target.value.slice(0, cursor));
    const query = token?.[1];
    if (query === undefined) return close();
    input = target;
    start = cursor - query.length - 1;
    end = cursor;
    const read = ++generation;
    setOpen(true);
    setSelected(0);
    setError("");
    positionPopup();
    target.setAttribute("aria-controls", listID);
    target.setAttribute("aria-autocomplete", "list");
    if (!people.length) {
      setLoading(true);
      try {
        const result = await (
          props.loadPeople ?? ((id) => serverCall(getAttentionPeople({ data: [id] })))
        )(projectID);
        if (read !== generation || props.projectID !== projectID) return;
        people = result;
      } catch {
        if (read === generation)
          setError("Project members could not be loaded. Type @ again to retry.");
      } finally {
        if (read === generation) setLoading(false);
      }
    }
    if (read !== generation) return;
    setOptions(
      people.filter((person) =>
        person.name.toLocaleLowerCase().includes(query.toLocaleLowerCase()),
      ),
    );
    if (options().length) target.setAttribute("aria-activedescendant", `${listID}-0`);
  }
  createEffect(
    () => props.projectID,
    () => {
      people = [];
      close();
      setLoading(false);
    },
  );
  createEffect(
    () => true,
    () => {
      const onInput = (event: Event) => {
        if (event.target instanceof HTMLTextAreaElement) void update(event.target);
      };
      const onKey = (event: KeyboardEvent) => {
        if (!open() || event.target !== input) return;
        if (event.key === "Tab" && event.shiftKey) {
          close();
          return;
        }
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopImmediatePropagation();
          close();
        } else if ((event.key === "ArrowDown" || event.key === "ArrowUp") && options().length) {
          event.preventDefault();
          event.stopImmediatePropagation();
          const next =
            (selected() + (event.key === "ArrowDown" ? 1 : -1) + options().length) %
            options().length;
          setSelected(next);
          input?.setAttribute("aria-activedescendant", `${listID}-${next}`);
        } else if ((event.key === "Enter" || event.key === "Tab") && options()[selected()]) {
          event.preventDefault();
          event.stopImmediatePropagation();
          const person = options()[selected()];
          if (person) choose(person);
        }
      };
      const outside = (event: PointerEvent) => {
        if (event.target !== input && !popup?.contains(event.target as Node)) close();
      };
      document.addEventListener("input", onInput);
      document.addEventListener("keydown", onKey, true);
      document.addEventListener("pointerdown", outside);
      window.addEventListener("scroll", positionPopup, true);
      window.addEventListener("resize", positionPopup);
      return () => {
        close();
        document.removeEventListener("input", onInput);
        document.removeEventListener("keydown", onKey, true);
        document.removeEventListener("pointerdown", outside);
        window.removeEventListener("scroll", positionPopup, true);
        window.removeEventListener("resize", positionPopup);
      };
    },
  );
  return (
    <Show when={open()}>
      <Portal>
        <div
          class="mention-picker"
          ref={popup}
          style={{
            left: `${position().left}px`,
            top: `${position().top}px`,
            width: `${position().width}px`,
          }}
        >
          <Show when={loading()}>
            <p role="status">Loading Project members…</p>
          </Show>
          <Show when={error()}>
            <p role="alert">{error()}</p>
          </Show>
          <div role="listbox" aria-label="Mention a Project member" id={listID}>
            <For each={options()}>
              {(person, index) => (
                <button
                  type="button"
                  role="option"
                  aria-selected={selected() === index() ? "true" : "false"}
                  id={`${listID}-${index()}`}
                  onPointerDown={(event) => event.preventDefault()}
                  onClick={() => choose(person)}
                >
                  <span>{person.name}</span>
                  <small>{person.develop ? "Developer" : "Product Contributor"}</small>
                </button>
              )}
            </For>
          </div>
          <Show when={!loading() && !error() && !options().length}>
            <p>No matching Project members.</p>
          </Show>
        </div>
      </Portal>
    </Show>
  );
}
