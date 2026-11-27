import { createEffect, createMemo, createSignal, For, onCleanup, Show } from "solid-js";
import type { TechnicalDesignContent } from "#requirement-domain/technical-design";
import type { TechnicalDesignRevision } from "../change/contracts";
import { documentationLanguage } from "../knowledge/client";
import { createClipboardFeedback, setCopyButtonState } from "../ui/client";
import { formatTechnicalDesignHTML } from "./ticket-planning-markdown";
import "../ui/feedback.css";

function TechnicalProse(props: {
  value: string;
  label: string;
  citations?: readonly TechnicalDesignRevision["citations"][number][] | undefined;
  onCitation?: ((reference: number) => void) | undefined;
}) {
  const scope = createMemo(() => props.value);
  const language = createMemo(() => documentationLanguage([props.value]));
  const rendered = createMemo(() => formatTechnicalDesignHTML(props.value, props.citations));
  const clipboard = createClipboardFeedback(scope);
  const [copyButton, setCopyButton] = createSignal<HTMLButtonElement>();
  createEffect(
    () => ({ button: copyButton(), state: clipboard.state() }),
    (current, previous) => {
      if (previous?.button && previous.button !== current.button)
        setCopyButtonState(previous.button, "idle");
      if (current.button) setCopyButtonState(current.button, current.state);
    },
  );
  onCleanup(() => {
    const button = copyButton();
    if (button) setCopyButtonState(button, "idle");
  });
  return (
    <>
      {/* biome-ignore lint/a11y/useKeyWithClickEvents: Parsed copy-code and citation buttons handle keyboard activation; this container only delegates clicks. */}
      <article
        class="markdown-body ticket-technical-prose"
        aria-label={props.label}
        lang={language()}
        innerHTML={rendered()}
        onClick={async (event) => {
          const target = event.target;
          if (!(target instanceof HTMLElement)) return;
          const citation = target.closest<HTMLButtonElement>("button[data-citation]");
          if (citation && event.currentTarget.contains(citation)) {
            const reference = Number(citation.dataset["citation"]);
            if (Number.isFinite(reference)) props.onCitation?.(reference);
            return;
          }
          const button = target.closest<HTMLButtonElement>('button[aria-label="Copy code"]');
          if (button) {
            if (clipboard.state() === "pending") return;
            setCopyButton(button);
            await clipboard.copy(button.closest("pre")?.querySelector("code")?.textContent ?? "");
          }
        }}
      />
      <span class="sr-only" role="status" aria-live="polite" aria-atomic="true">
        {clipboard.state() === "success" ? "Code copied" : ""}
      </span>
      <Show when={clipboard.state() === "error"}>
        <small class="copy-feedback-error" role="alert">
          Could not copy. Select the code to copy manually.
        </small>
      </Show>
    </>
  );
}

export function ArchitectureFigure(props: {
  diagram: TechnicalDesignContent["diagrams"][number];
  svg: string | null;
}) {
  const [url, setURL] = createSignal("");
  createEffect(
    () => props.svg,
    (svg) => {
      if (!svg) {
        setURL("");
        return;
      }
      const value = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml" }));
      setURL(value);
      return () => URL.revokeObjectURL(value);
    },
  );
  return (
    <figure class="ticket-architecture-figure">
      <figcaption>
        <div class="ticket-architecture-heading">
          <h3>{props.diagram.title}</h3>
          <Show when={url()}>
            <a class="workspace-action" href={url()} target="_blank" rel="noopener noreferrer">
              Open diagram
            </a>
          </Show>
        </div>
        <p>{props.diagram.description}</p>
      </figcaption>
      <Show when={url()}>
        <a
          href={url()}
          target="_blank"
          rel="noopener noreferrer"
          aria-label={`Open ${props.diagram.title} diagram`}
        >
          <img src={url()} alt={props.diagram.description} />
        </a>
      </Show>
      <Show when={!props.svg}>
        <p class="ticket-diagram-status" role="status">
          Diagram not rendered. The technical design and diagram source are retained.
        </p>
      </Show>
      <details class="ticket-diagram-source" open={!props.svg}>
        <summary>PlantUML source</summary>
        <pre>
          <code>{props.diagram.source}</code>
        </pre>
      </details>
    </figure>
  );
}

export function TechnicalDesignReadView(props: { revision: TechnicalDesignRevision }) {
  let sourcesDetails: HTMLDetailsElement | undefined;
  const revealSources = () => {
    if (!sourcesDetails) return;
    sourcesDetails.open = true;
    sourcesDetails.scrollIntoView({ block: "nearest" });
  };
  const groups = () =>
    [
      { label: "Decisions", values: props.revision.content.decisions },
      { label: "Assumptions", values: props.revision.content.assumptions },
      { label: "Risks", values: props.revision.content.risks },
    ].filter((group) => group.values.length);
  return (
    <div class="ticket-design-sections">
      <div class="ticket-design-card">
        <div class="specification-block-heading">
          <h3>Current system</h3>
        </div>
        <TechnicalProse
          value={props.revision.content.context}
          label="Current system"
          citations={props.revision.citations}
          onCitation={revealSources}
        />
      </div>
      <div class="ticket-design-card">
        <div class="specification-block-heading">
          <h3>Proposed changes</h3>
        </div>
        <TechnicalProse
          value={props.revision.content.proposedChanges}
          label="Proposed technical changes"
          citations={props.revision.citations}
          onCitation={revealSources}
        />
      </div>
      <For each={groups()}>
        {(group) => (
          <div class="ticket-design-card ticket-design-list">
            <div class="specification-block-heading">
              <h3>{group.label}</h3>
              <span class="specification-block-count" aria-hidden="true">
                {group.values.length}
              </span>
            </div>
            <ul>
              <For each={group.values}>
                {(value) => (
                  <li>
                    <TechnicalProse
                      value={value}
                      label={group.label}
                      citations={props.revision.citations}
                      onCitation={revealSources}
                    />
                  </li>
                )}
              </For>
            </ul>
          </div>
        )}
      </For>
      <Show when={props.revision.citations.length}>
        <details ref={sourcesDetails} class="ticket-design-sources">
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
    </div>
  );
}

export function TechnicalArchitectureSection(props: { revision: TechnicalDesignRevision }) {
  return (
    <Show when={props.revision.content.diagrams.length}>
      <section
        id="ticket-architecture"
        class="ticket-chapter"
        aria-label="Architecture"
        tabindex="-1"
      >
        <div class="ticket-chapter-heading">
          <h2>Architecture</h2>
        </div>
        <For each={props.revision.content.diagrams} keyed={false}>
          {(diagram, index) => (
            <ArchitectureFigure
              diagram={diagram()}
              svg={props.revision.diagramRenders[index] ?? null}
            />
          )}
        </For>
      </section>
    </Show>
  );
}

export function TechnicalValidationSection(props: { revision: TechnicalDesignRevision }) {
  return (
    <section id="ticket-validation" class="ticket-chapter" aria-label="Validation" tabindex="-1">
      <div class="ticket-chapter-heading">
        <h2>Validation</h2>
      </div>
      <p class="ticket-chapter-description">Checks against the product acceptance criteria.</p>
      <ol class="ticket-validation-list">
        <For each={props.revision.content.validation} keyed={false}>
          {(item) => (
            <li>
              <span class="ticket-validation-reference">Criterion {item().criterion}</span>
              <TechnicalProse
                value={item().check}
                label={`Validation for criterion ${item().criterion}`}
                citations={props.revision.citations}
              />
            </li>
          )}
        </For>
      </ol>
    </section>
  );
}
