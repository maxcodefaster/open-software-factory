import {
  createEffect,
  createSignal,
  createUniqueId,
  For,
  onSettled,
  Show,
  untrack,
} from "solid-js";
import type { TechnicalDesignContent } from "#requirement-domain/technical-design";
import type { TechnicalDesignRevision } from "../change/contracts";
import { plainErrorMessage } from "../command-error";
import { TechnicalDesignEditorForm } from "./ticket-planning-editor";
import {
  activeTechnicalDesignState,
  beginTechnicalDesignEdit,
  buildTicketChapters,
  clearTechnicalDesignDraft,
  initialTechnicalDesignEditorState,
  isTechnicalDesignEditing,
  isTechnicalDesignSaving,
  persistTechnicalDesignDraft,
  type TechnicalDesignEditorState,
  technicalDesignError,
  validateTechnicalDesignForSave,
} from "./ticket-planning-state";
import {
  TechnicalArchitectureSection,
  TechnicalDesignReadView,
  TechnicalValidationSection,
} from "./ticket-planning-views";
import { technicalDesignStale } from "./ticket-state-helpers";
import "./ticket-planning.css";

export function TicketChapterNavigation(props: {
  root: HTMLElement | undefined;
  technical: boolean;
  validation: boolean;
  architecture: boolean;
  review: boolean;
}) {
  const [active, setActive] = createSignal("ticket-product");
  const chapters = () =>
    buildTicketChapters({
      review: props.review,
      technical: props.technical,
      architecture: props.architecture,
      validation: props.validation,
    });
  function go(id: string) {
    const target = props.root?.querySelector<HTMLElement>(`#${id}`);
    if (!target) return;
    target.scrollIntoView({
      block: "start",
      behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "instant" : "smooth",
    });
    target.focus({ preventScroll: true });
    setActive(id);
  }
  createEffect(
    () => ({
      root: props.root,
      ids: chapters()
        .map((chapter) => chapter.id)
        .join(","),
    }),
    ({ root, ids }) => {
      const scroller = root?.closest(".ticket-workspace");
      if (!root || !scroller) return;
      const sections = ids.split(",").flatMap((id) => {
        const section = root.querySelector<HTMLElement>(`#${id}`);
        return section ? [section] : [];
      });
      const observe = () => {
        const top = scroller.getBoundingClientRect().top + 80;
        const atEnd =
          scroller.scrollTop > 0 &&
          scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 1;
        const selected = atEnd
          ? sections.at(-1)
          : (sections.findLast((section) => section.getBoundingClientRect().top <= top) ??
            sections[0]);
        if (selected) setActive(selected.id);
      };
      scroller.addEventListener("scroll", observe, { passive: true });
      window.addEventListener("resize", observe);
      observe();
      return () => {
        scroller.removeEventListener("scroll", observe);
        window.removeEventListener("resize", observe);
      };
    },
  );
  return (
    <Show when={chapters().length > 1}>
      <nav class="ticket-chapter-navigation" aria-label="Ticket chapters">
        <div class="ticket-chapter-links">
          <For each={chapters()} keyed={(chapter) => chapter.id}>
            {(chapter) => (
              <button
                type="button"
                class={active() === chapter().id ? "is-current" : ""}
                aria-label={chapter().label}
                aria-current={active() === chapter().id ? "location" : "false"}
                onClick={() => go(chapter().id)}
              >
                <span class="ticket-chapter-mark" aria-hidden="true" />
                <span class="ticket-chapter-label" aria-hidden="true">
                  {chapter().label}
                </span>
              </button>
            )}
          </For>
        </div>
        <label class="ticket-chapter-select">
          <span class="sr-only">Ticket chapter</span>
          <select value={active()} onChange={(event) => go(event.currentTarget.value)}>
            <For each={chapters()} keyed={(chapter) => chapter.id}>
              {(chapter) => <option value={chapter().id}>{chapter().label}</option>}
            </For>
          </select>
        </label>
      </nav>
    </Show>
  );
}

type TechnicalDesignSectionProps = {
  revision: TechnicalDesignRevision;
  productRevisionID: string | undefined;
  editable: boolean;
  storageKey: string;
  busy: boolean;
  onPlan?: (() => void) | undefined;
  onSave?: ((revisionID: string, content: TechnicalDesignContent) => Promise<boolean>) | undefined;
  onEditing?(read: (() => boolean) | undefined): void;
};

export function TechnicalDesignSections(props: TechnicalDesignSectionProps) {
  return (
    <For each={[props.storageKey]}>
      {(storageKey) => <TechnicalDesignDocument {...props} storageKey={storageKey} />}
    </For>
  );
}

function TechnicalDesignDocument(props: TechnicalDesignSectionProps) {
  const formID = createUniqueId();
  const [editorState, setEditorState] = createSignal<TechnicalDesignEditorState>(
    initialTechnicalDesignEditorState(),
  );
  const editing = () => isTechnicalDesignEditing(editorState());
  const saving = () => isTechnicalDesignSaving(editorState());
  const activeState = () => activeTechnicalDesignState(editorState());
  const errorMessage = () => technicalDesignError(editorState());
  const stale = () => technicalDesignStale(props.revision, props.productRevisionID);

  function change(content: TechnicalDesignContent) {
    const current = editorState();
    if (current.kind !== "editing") return;
    setEditorState({ ...current, draft: content });
    persistTechnicalDesignDraft(props.storageKey, current.baseID, content);
  }

  function beginEdit() {
    setEditorState(beginTechnicalDesignEdit(props.storageKey, props.revision));
  }

  function discardEdits() {
    setEditorState(initialTechnicalDesignEditorState());
    clearTechnicalDesignDraft(props.storageKey);
  }

  onSettled(() => {
    const publish = untrack(() => props.onEditing);
    publish?.(editing);
    return () => publish?.(undefined);
  });

  async function save() {
    const current = editorState();
    if (current.kind !== "editing" || props.busy) return;
    const scopeKey = props.storageKey;
    const revisionID = current.baseID;
    const validated = validateTechnicalDesignForSave(current, props.revision.id);
    if (!validated.ok) {
      setEditorState({ ...current, error: validated.error });
      return;
    }
    setEditorState({ kind: "saving", baseID: revisionID, draft: current.draft });
    try {
      const saved = await props.onSave?.(revisionID, validated.data);
      const latest = editorState();
      if (props.storageKey !== scopeKey || latest.kind !== "saving" || latest.baseID !== revisionID)
        return;
      if (saved) {
        clearTechnicalDesignDraft(scopeKey);
        setEditorState(initialTechnicalDesignEditorState());
      } else {
        setEditorState({
          kind: "editing",
          baseID: latest.baseID,
          draft: latest.draft,
          error: "Could not save the design. Your draft is retained.",
        });
      }
    } catch (cause) {
      const latest = editorState();
      if (props.storageKey !== scopeKey || latest.kind !== "saving" || latest.baseID !== revisionID)
        return;
      setEditorState({
        kind: "editing",
        baseID: latest.baseID,
        draft: latest.draft,
        error:
          cause instanceof Error
            ? plainErrorMessage(cause.message)
            : "Could not save the design. Your draft is retained.",
      });
    }
  }

  return (
    <>
      <section
        id="ticket-technical"
        class="ticket-chapter"
        aria-label="Technical design"
        tabindex="-1"
      >
        <div class="ticket-chapter-heading">
          <h2>Technical design</h2>
          <div class="ticket-chapter-actions">
            <Show when={activeState()}>
              <button
                type="submit"
                form={formID}
                class="workspace-action"
                data-primary="true"
                disabled={saving() || props.busy}
              >
                {saving() ? "Saving design…" : "Save design"}
              </button>
              <button
                type="button"
                class="workspace-action"
                disabled={saving() || props.busy}
                onClick={discardEdits}
              >
                Discard edits
              </button>
            </Show>
            <Show when={props.editable && !editing() && !stale()}>
              <button
                type="button"
                class="workspace-action"
                disabled={props.busy}
                onClick={beginEdit}
              >
                Edit design
              </button>
            </Show>
            <Show when={props.editable && !editing() && props.onPlan}>
              <button
                type="button"
                class="workspace-action"
                disabled={props.busy}
                onClick={props.onPlan}
              >
                {stale() ? "Update design" : "Replan"}
              </button>
            </Show>
          </div>
        </div>
        <p class="ticket-design-provenance">
          {props.revision.approved ? "Approved" : "Proposed"} · Revision {props.revision.ordinal} ·
          Source <code>{props.revision.sourceCommit.slice(0, 8)}</code> ·{" "}
          <span>Development access</span>
        </p>
        <Show when={stale()}>
          <p class="ticket-design-stale" role="status">
            The product specification changed. Update this design before implementation.
          </p>
        </Show>
        <Show when={errorMessage()}>
          {(message) => (
            <p class="inline-error" role="alert">
              {message()}
            </p>
          )}
        </Show>
        <Show when={activeState()} fallback={<TechnicalDesignReadView revision={props.revision} />}>
          {(active) => (
            <TechnicalDesignEditorForm
              formID={formID}
              draft={active().draft}
              disabled={saving() || props.busy}
              onChange={change}
              onSubmit={() => void save()}
            />
          )}
        </Show>
      </section>
      <TechnicalArchitectureSection revision={props.revision} />
      <TechnicalValidationSection revision={props.revision} />
    </>
  );
}
