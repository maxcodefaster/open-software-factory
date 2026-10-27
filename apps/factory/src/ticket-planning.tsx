import {
  createEffect,
  createSignal,
  createUniqueId,
  For,
  onSettled,
  Show,
  untrack,
} from "solid-js";
import { z } from "zod";
import {
  type TechnicalDesignContent,
  technicalDesignContentInput,
} from "../../../packages/requirement-domain/src/technical-design";
import type { TechnicalDesignRevision } from "./api-contracts";
import { MarkdownReader } from "./markdown-reader";
import "./ticket-planning.css";

// Private drafts may be incomplete or contain a syntax error. Only the stronger
// domain schema can authorize a save or a render.
const technicalDraftInput = technicalDesignContentInput.extend({
  context: z.string().max(12_000),
  proposedChanges: z.string().max(12_000),
  validation: z
    .array(
      z.strictObject({
        criterion: z.number().int().min(1).max(100),
        check: z.string().max(2_000),
      }),
    )
    .max(100),
  diagrams: z
    .array(
      z.strictObject({
        title: z.string().max(160),
        description: z.string().max(2_000),
        source: z.string().max(16_000),
      }),
    )
    .max(2),
});

export function TicketChapterNavigation(props: {
  root: HTMLElement | undefined;
  technical: boolean;
  validation: boolean;
  architecture: boolean;
  review: boolean;
}) {
  const [active, setActive] = createSignal("ticket-product");
  const chapters = () => [
    ...(props.review ? [{ id: "ticket-review", label: "Review" }] : []),
    { id: "ticket-product", label: "Product" },
    ...(props.technical ? [{ id: "ticket-technical", label: "Technical design" }] : []),
    ...(props.architecture ? [{ id: "ticket-architecture", label: "Architecture" }] : []),
    ...(props.validation ? [{ id: "ticket-validation", label: "Validation" }] : []),
  ];
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
  );
}

function ArchitectureFigure(props: {
  diagram: TechnicalDesignContent["diagrams"][number];
  svg: string;
}) {
  const [url, setURL] = createSignal("");
  createEffect(
    () => props.svg,
    (svg) => {
      const value = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml" }));
      setURL(value);
      return () => URL.revokeObjectURL(value);
    },
  );
  return (
    <figure class="ticket-architecture-figure">
      <figcaption>
        <div class="ticket-architecture-heading">
          <h4>{props.diagram.title}</h4>
          <a class="workspace-action" href={url()} target="_blank" rel="noopener noreferrer">
            Open diagram
          </a>
        </div>
        <p>{props.diagram.description}</p>
      </figcaption>
      <a
        href={url()}
        target="_blank"
        rel="noopener noreferrer"
        aria-label={`Open ${props.diagram.title} diagram`}
      >
        <img src={url()} alt={props.diagram.description} />
      </a>
      <details class="ticket-diagram-source">
        <summary>PlantUML source</summary>
        <pre>
          <code>{props.diagram.source}</code>
        </pre>
      </details>
    </figure>
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
  const [editing, setEditing] = createSignal(false);
  const [draft, setDraft] = createSignal<TechnicalDesignContent>(
    untrack(() => props.revision.content),
  );
  const [baseID, setBaseID] = createSignal(untrack(() => props.revision.id));
  const [saving, setSaving] = createSignal(false);
  const [error, setError] = createSignal("");
  const stale = () => props.revision.requirementRevisionId !== props.productRevisionID;
  const read = (value: string, label: string) => (
    <MarkdownReader value={value} label={label} class="markdown-body ticket-technical-prose" />
  );
  function change(content: TechnicalDesignContent) {
    setDraft(content);
    try {
      localStorage.setItem(props.storageKey, JSON.stringify({ id: baseID(), content }));
    } catch {
      /* The mounted editor still retains the draft. */
    }
  }
  function beginEdit() {
    setBaseID(props.revision.id);
    setDraft(props.revision.content);
    try {
      const saved = JSON.parse(localStorage.getItem(props.storageKey) ?? "null");
      const content = technicalDraftInput.safeParse(saved?.content);
      if (saved?.id === props.revision.id && content.success) setDraft(content.data);
    } catch {
      /* A corrupt draft never replaces the saved design. */
    }
    setError("");
    setEditing(true);
  }
  onSettled(() => {
    const publish = untrack(() => props.onEditing);
    publish?.(editing);
    return () => publish?.(undefined);
  });
  async function save() {
    if (saving() || props.busy) return;
    const scopeKey = props.storageKey;
    const revisionID = baseID();
    const parsed = technicalDesignContentInput.safeParse(draft());
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? "Complete the technical design before saving.");
      return;
    }
    if (baseID() !== props.revision.id) {
      setError("The technical design changed elsewhere. Your draft is retained.");
      return;
    }
    setSaving(true);
    setError("");
    try {
      const saved = await props.onSave?.(revisionID, parsed.data);
      if (props.storageKey !== scopeKey || baseID() !== revisionID) return;
      if (saved) {
        localStorage.removeItem(scopeKey);
        setEditing(false);
      } else setError("Could not save the design. Your draft is retained.");
    } catch (cause) {
      if (props.storageKey !== scopeKey) return;
      setError(
        cause instanceof Error
          ? cause.message
          : "Could not save the design. Your draft is retained.",
      );
    } finally {
      if (props.storageKey === scopeKey) setSaving(false);
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
          <h3>Technical design</h3>
          <div class="ticket-chapter-actions">
            <Show when={editing()}>
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
                onClick={() => {
                  setEditing(false);
                  localStorage.removeItem(props.storageKey);
                  setError("");
                }}
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
          Source <code>{props.revision.sourceCommit.slice(0, 8)}</code>
          <span>Development access</span>
        </p>
        <Show when={stale()}>
          <p class="ticket-design-stale" role="status">
            The product specification changed. Update this design before implementation.
          </p>
        </Show>
        <Show when={editing() && error()}>
          <p class="inline-error" role="alert">
            {error()}
          </p>
        </Show>
        <Show
          when={editing()}
          fallback={
            <>
              <h4>Current system</h4>
              {read(props.revision.content.context, "Current system")}
              <h4>Proposed changes</h4>
              {read(props.revision.content.proposedChanges, "Proposed technical changes")}
              <For
                each={[
                  { label: "Decisions", values: props.revision.content.decisions },
                  { label: "Assumptions", values: props.revision.content.assumptions },
                  { label: "Risks", values: props.revision.content.risks },
                ].filter((group) => group.values.length)}
              >
                {(group) => (
                  <div class="ticket-design-list">
                    <h4>{group.label}</h4>
                    <ul>
                      <For each={group.values}>
                        {(value) => <li>{read(value, group.label)}</li>}
                      </For>
                    </ul>
                  </div>
                )}
              </For>
              <Show when={props.revision.citations.length}>
                <details class="ticket-design-sources">
                  <summary>Inspected sources · {props.revision.citations.length}</summary>
                  <ul>
                    <For each={props.revision.citations}>
                      {(citation) => (
                        <li>
                          {citation.source === "code" ? (
                            <code>
                              {citation.path} · {citation.commitSha?.slice(0, 8)}
                            </code>
                          ) : (
                            citation.label
                          )}
                        </li>
                      )}
                    </For>
                  </ul>
                </details>
              </Show>
            </>
          }
        >
          <form
            id={formID}
            class="ticket-design-editor"
            onSubmit={(event) => {
              event.preventDefault();
              void save();
            }}
          >
            <fieldset disabled={saving() || props.busy}>
              <For each={["context", "proposedChanges"] as const}>
                {(field) => (
                  <label>
                    {field === "context" ? "Current system" : "Proposed changes"}
                    <textarea
                      rows={6}
                      value={draft()[field]}
                      onInput={(event) =>
                        change({ ...draft(), [field]: event.currentTarget.value })
                      }
                    />
                  </label>
                )}
              </For>
              <For each={["decisions", "assumptions", "risks"] as const}>
                {(field) => (
                  <label>
                    {field === "decisions"
                      ? "Decisions"
                      : field === "assumptions"
                        ? "Assumptions"
                        : "Risks"}{" "}
                    · one per line
                    <textarea
                      rows={3}
                      value={draft()[field].join("\n")}
                      onInput={(event) =>
                        change({
                          ...draft(),
                          [field]: event.currentTarget.value
                            .split("\n")
                            .filter((line) => line.trim()),
                        })
                      }
                    />
                  </label>
                )}
              </For>
              <For each={draft().validation.map((_, index) => index)}>
                {(index) => (
                  <label>
                    Validation for criterion {draft().validation[index]?.criterion}
                    <textarea
                      rows={2}
                      value={draft().validation[index]?.check}
                      onInput={(event) =>
                        change({
                          ...draft(),
                          validation: draft().validation.map((value, i) =>
                            i === index ? { ...value, check: event.currentTarget.value } : value,
                          ),
                        })
                      }
                    />
                  </label>
                )}
              </For>
              <For each={draft().diagrams.map((_, index) => index)}>
                {(index) => (
                  <div class="ticket-diagram-editor">
                    <label>
                      Diagram {index + 1} title
                      <input
                        value={draft().diagrams[index]?.title}
                        onInput={(event) =>
                          change({
                            ...draft(),
                            diagrams: draft().diagrams.map((value, i) =>
                              i === index ? { ...value, title: event.currentTarget.value } : value,
                            ),
                          })
                        }
                      />
                    </label>
                    <label>
                      Diagram explanation
                      <textarea
                        rows={2}
                        value={draft().diagrams[index]?.description}
                        onInput={(event) =>
                          change({
                            ...draft(),
                            diagrams: draft().diagrams.map((value, i) =>
                              i === index
                                ? { ...value, description: event.currentTarget.value }
                                : value,
                            ),
                          })
                        }
                      />
                    </label>
                    <label>
                      PlantUML source
                      <textarea
                        class="ticket-plantuml-editor"
                        rows={8}
                        spellcheck={false}
                        value={draft().diagrams[index]?.source}
                        onInput={(event) =>
                          change({
                            ...draft(),
                            diagrams: draft().diagrams.map((value, i) =>
                              i === index ? { ...value, source: event.currentTarget.value } : value,
                            ),
                          })
                        }
                      />
                    </label>
                    <button
                      type="button"
                      class="workspace-action"
                      onClick={() =>
                        change({
                          ...draft(),
                          diagrams: draft().diagrams.filter((_, i) => i !== index),
                        })
                      }
                    >
                      Remove diagram
                    </button>
                  </div>
                )}
              </For>
              <Show when={draft().diagrams.length < 2}>
                <button
                  type="button"
                  class="workspace-action"
                  onClick={() =>
                    change({
                      ...draft(),
                      diagrams: [
                        ...draft().diagrams,
                        { title: "", description: "", source: "@startuml\n\n@enduml" },
                      ],
                    })
                  }
                >
                  Add diagram
                </button>
              </Show>
            </fieldset>
          </form>
        </Show>
      </section>
      <Show when={props.revision.content.diagrams.length}>
        <section
          id="ticket-architecture"
          class="ticket-chapter"
          aria-label="Architecture"
          tabindex="-1"
        >
          <div class="ticket-chapter-heading">
            <h3>Architecture</h3>
          </div>
          <For each={props.revision.content.diagrams} keyed={false}>
            {(diagram, index) => (
              <ArchitectureFigure
                diagram={diagram()}
                svg={props.revision.diagramRenders[index] ?? ""}
              />
            )}
          </For>
        </section>
      </Show>
      <section id="ticket-validation" class="ticket-chapter" aria-label="Validation" tabindex="-1">
        <div class="ticket-chapter-heading">
          <h3>Validation</h3>
        </div>
        <p class="ticket-chapter-description">Checks against the product acceptance criteria.</p>
        <ol class="ticket-validation-list">
          <For each={props.revision.content.validation} keyed={false}>
            {(item) => (
              <li>
                <span class="ticket-validation-reference">Criterion {item().criterion}</span>
                {read(item().check, `Validation for criterion ${item().criterion}`)}
              </li>
            )}
          </For>
        </ol>
      </section>
    </>
  );
}
