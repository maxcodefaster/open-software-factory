import { For, Show } from "solid-js";
import type { RequirementContent } from "../../../packages/requirement-domain/src/content";
import { markdownHTML } from "./markdown";

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
          <small>Revision {props.ordinal} · Read only</small>
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
            <div class="markdown-body" innerHTML={markdownHTML(content().summary)} />
            <section class="specification-block">
              <h4>Acceptance criteria</h4>
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
                <h4>Non-goals</h4>
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
