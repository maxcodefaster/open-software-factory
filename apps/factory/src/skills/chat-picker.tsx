import { createEffect, createSignal, For, onCleanup, Show } from "solid-js";
import {
  type SkillRole,
  skillInvocationViewInput,
} from "../../../../packages/conversation-domain/src/skills";
import { apiRequest } from "../api-client";
import { insertSkillInvocation, skillInvocationQuery } from "./chat-invocation";

export function ChatSkillPicker(props: {
  projectID: string | undefined;
  workType: SkillRole;
  changeID?: string | undefined;
  scope: string;
  disabled?: boolean;
}) {
  const [open, setOpen] = createSignal(false);
  const [view, setView] = createSignal<ReturnType<typeof skillInvocationViewInput.parse>>();
  const [error, setError] = createSignal("");
  const [position, setPosition] = createSignal<Record<string, string>>({});
  const [query, setQuery] = createSignal("");
  const [active, setActive] = createSignal(0);
  let textarea: HTMLTextAreaElement | undefined;
  let popup: HTMLDivElement | undefined;
  let request: AbortController | undefined;
  let disposed = false;
  let focusFrame = 0;
  const id = `chat-skills-${crypto.randomUUID()}`;
  const matches = () =>
    (view()?.skills ?? []).filter((skill) =>
      `${skill.key} ${skill.name}`.toLocaleLowerCase().includes(query().toLocaleLowerCase()),
    );
  const place = () => {
    const rectangle = textarea?.getBoundingClientRect();
    if (!rectangle) return;
    setPosition({
      left: `${Math.max(8, Math.min(rectangle.left, innerWidth - 328))}px`,
      bottom: `${Math.max(8, innerHeight - rectangle.top + 8)}px`,
      width: `${Math.min(320, innerWidth - 16)}px`,
      "max-height": `${Math.max(96, rectangle.top - 16)}px`,
    });
  };
  createEffect(
    () => [props.projectID, props.workType, props.changeID, props.scope, props.disabled] as const,
    () => {
      request?.abort();
      popup?.hidePopover();
      setView(undefined);
      setError("");
    },
  );
  createEffect(open, (visible) => {
    if (!visible) return;
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  });
  createEffect(
    () => [open(), active(), matches().map((skill) => skill.key)] as const,
    ([visible, index, keys]) => {
      if (!textarea) return;
      textarea.setAttribute("aria-expanded", String(visible));
      const key = keys[index];
      if (visible && key) textarea.setAttribute("aria-activedescendant", `${id}-${key}`);
      else textarea.removeAttribute("aria-activedescendant");
    },
  );
  const sync = () => {
    if (!textarea || textarea.disabled || props.disabled || !props.projectID) {
      popup?.hidePopover();
      return;
    }
    const next = skillInvocationQuery(
      textarea.value,
      textarea.selectionStart,
      textarea.selectionEnd,
    );
    if (next === null) {
      popup?.hidePopover();
      return;
    }
    if (next !== query()) {
      setQuery(next);
      setActive(0);
    }
    place();
    if (!popup?.matches(":popover-open")) {
      setView(undefined);
      setError("");
      popup?.showPopover();
    }
  };
  const keydown = (event: KeyboardEvent) => {
    if (!open() || event.isComposing || event.keyCode === 229) return;
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      popup?.hidePopover();
      return;
    }
    const options = matches();
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      if (!options.length) return;
      event.preventDefault();
      event.stopPropagation();
      const direction = event.key === "ArrowDown" ? 1 : -1;
      setActive((value) => (value + direction + options.length) % options.length);
      queueMicrotask(() =>
        popup?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: "nearest" }),
      );
    } else if (event.key === "Enter" || (event.key === "Tab" && !event.shiftKey)) {
      if (event.key === "Tab" && !options.length) {
        popup?.hidePopover();
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      const selected = options[active()];
      if (selected) choose(selected.key);
    }
  };
  const blur = () => {
    cancelAnimationFrame(focusFrame);
    focusFrame = requestAnimationFrame(() => {
      if (
        !disposed &&
        document.activeElement !== textarea &&
        !popup?.contains(document.activeElement)
      )
        popup?.hidePopover();
    });
  };
  onCleanup(() => {
    disposed = true;
    cancelAnimationFrame(focusFrame);
    request?.abort();
    textarea?.removeEventListener("input", sync);
    textarea?.removeEventListener("click", sync);
    textarea?.removeEventListener("select", sync);
    textarea?.removeEventListener("blur", blur);
    textarea?.removeEventListener("keydown", keydown, true);
    if (textarea?.getAttribute("aria-controls") === id) {
      for (const attribute of [
        "aria-controls",
        "aria-expanded",
        "aria-activedescendant",
        "aria-autocomplete",
        "aria-haspopup",
      ])
        textarea.removeAttribute(attribute);
    }
  });
  async function load() {
    const projectID = props.projectID;
    if (!projectID) return;
    request?.abort();
    const current = new AbortController();
    request = current;
    setError("");
    setView(undefined);
    try {
      const query = new URLSearchParams({ role: props.workType });
      if (props.changeID) query.set("change", props.changeID);
      const result = await apiRequest(
        skillInvocationViewInput,
        `/api/projects/${projectID}/skills/invocations?${query}`,
        { signal: current.signal },
      );
      if (!current.signal.aborted) setView(result);
    } catch (cause) {
      if (!current.signal.aborted)
        setError(cause instanceof Error ? cause.message : "Skills could not be loaded.");
    }
  }
  function choose(key: string) {
    if (!textarea || textarea.disabled) return;
    const inserted = insertSkillInvocation(
      textarea.value,
      textarea.selectionStart,
      textarea.selectionEnd,
      key,
    );
    textarea.value = inserted.text;
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
    popup?.hidePopover();
    textarea.focus();
    textarea.setSelectionRange(inserted.cursor, inserted.cursor);
  }
  return (
    <span
      class="chat-skill-invoker"
      ref={(element) =>
        queueMicrotask(() => {
          if (disposed) return;
          textarea = element.closest("form")?.querySelector("textarea") ?? undefined;
          if (!textarea) return;
          textarea.setAttribute("aria-controls", id);
          textarea.setAttribute("aria-autocomplete", "list");
          textarea.setAttribute("aria-haspopup", "listbox");
          textarea.setAttribute("aria-expanded", "false");
          textarea.addEventListener("input", sync);
          textarea.addEventListener("click", sync);
          textarea.addEventListener("select", sync);
          textarea.addEventListener("blur", blur);
          textarea.addEventListener("keydown", keydown, true);
        })
      }
    >
      <div
        ref={popup}
        id={id}
        class="chat-skill-picker"
        role="listbox"
        aria-label="Available Skills"
        popover="auto"
        style={position()}
        onToggle={(event) => {
          const visible = event.newState === "open";
          setOpen(visible);
          if (visible) {
            setActive(0);
            void load();
          } else request?.abort();
        }}
      >
        <p>Skills</p>
        <Show when={error()}>
          <p role="alert">{error()} Type / again to retry.</p>
        </Show>
        <Show when={!view() && !error()}>
          <p role="status">Loading available Skills…</p>
        </Show>
        <Show when={view()}>
          {(current) => (
            <>
              <Show when={!matches().length}>
                <p>
                  {current().skills.length
                    ? "No matching Skills."
                    : "No unambiguous Skills are enabled for this work."}
                </p>
              </Show>
              <ul role="presentation">
                <For each={matches()}>
                  {(skill, index) => (
                    <li role="presentation">
                      <button
                        type="button"
                        role="option"
                        tabindex="-1"
                        id={`${id}-${skill.key}`}
                        aria-selected={active() === index() ? "true" : "false"}
                        onPointerDown={(event) => event.preventDefault()}
                        onPointerMove={() => setActive(index())}
                        onClick={() => choose(skill.key)}
                      >
                        <strong>
                          {skill.name} <span>/{skill.key}</span>
                        </strong>
                        <span>{skill.description}</span>
                      </button>
                    </li>
                  )}
                </For>
              </ul>
              <Show when={current().conflicts.length}>
                <p>
                  Duplicate invocation names must be renamed in Skills settings:{" "}
                  {current()
                    .conflicts.map((key) => `/${key}`)
                    .join(", ")}
                  .
                </p>
              </Show>
              <small>Enter to insert · Escape to close. Nothing is sent or enabled.</small>
            </>
          )}
        </Show>
      </div>
    </span>
  );
}
