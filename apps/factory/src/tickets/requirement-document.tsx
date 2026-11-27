import { For, Show } from "solid-js";
import type { RequirementContent } from "#requirement-domain/content";
import { markdownHTML } from "../editor/client";

export function RequirementDocument(props: {
  title: string;
  content: RequirementContent | undefined;
  ordinal: number;
  description?: string | undefined;
}) {
  return (
    <article
      class="ticket-document historical-document"
      aria-label="Selected specification revision"
    >
      <header class="ticket-document-heading">
        <h2>{props.title}</h2>
        <div class="ticket-status-context">
          <small>Version {props.ordinal} · Read only</small>
        </div>
      </header>
      <Show when={props.description}>
        <div class="markdown-body" innerHTML={markdownHTML(props.description ?? "")} />
      </Show>
      <Show
        when={props.content}
        fallback={props.description ? null : <p>Revision content unavailable.</p>}
      >
        {(content) => (
          <>
            <Show when={content().summary !== props.description}>
              <div class="markdown-body" innerHTML={markdownHTML(content().summary)} />
            </Show>
            <section class="specification-block">
              <div class="specification-block-heading">
                <h3>Acceptance criteria</h3>
                <Show when={content().acceptanceCriteria.length > 0}>
                  <span class="specification-block-count" aria-hidden="true">
                    {content().acceptanceCriteria.length}
                  </span>
                </Show>
              </div>
              <ul class="requirement-checklist">
                <For each={content().acceptanceCriteria}>
                  {(value) => (
                    <li>
                      <span class="requirement-marker" aria-hidden="true">
                        ·
                      </span>
                      <div class="markdown-body" innerHTML={markdownHTML(value)} />
                    </li>
                  )}
                </For>
              </ul>
            </section>
            <Show when={content().nonGoals.length}>
              <section class="specification-block">
                <div class="specification-block-heading">
                  <h3>Non-goals</h3>
                  <span class="specification-block-count" aria-hidden="true">
                    {content().nonGoals.length}
                  </span>
                </div>
                <ul>
                  <For each={content().nonGoals}>
                    {(value) => <li class="markdown-body" innerHTML={markdownHTML(value)} />}
                  </For>
                </ul>
              </section>
            </Show>
          </>
        )}
      </Show>
    </article>
  );
}
