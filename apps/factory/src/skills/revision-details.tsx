import { For, Show } from "solid-js";
import type { SkillRevision } from "../../../../packages/conversation-domain/src/skills";
import { MarkdownReader } from "../markdown-reader";

type RevisionDetailsProps = {
  revision: SkillRevision;
  onCheckUpdate?: (() => void) | undefined;
  busy?: boolean | undefined;
  expanded?: boolean | undefined;
  reading?: boolean | undefined;
};

export function SkillRevisionDetails(props: RevisionDetailsProps) {
  return (
    <Show
      when={props.reading}
      fallback={
        <details class="skill-details" open={props.expanded}>
          <summary>Instructions &amp; source</summary>
          <MarkdownReader
            value={props.revision.content.instructions}
            label="Skill instructions"
            class="skill-instructions"
          />
          <SkillSource {...props} />
        </details>
      }
    >
      <section class="skill-reading">
        <h4>Instructions</h4>
        <MarkdownReader
          value={props.revision.content.instructions}
          label="Skill instructions"
          class="skill-instructions"
        />
      </section>
    </Show>
  );
}

export function SkillRevisionSource(props: RevisionDetailsProps) {
  return (
    <details class="skill-details skill-revision-source">
      <summary>Source, files &amp; version</summary>
      <p>
        Version {props.revision.revision} · <code>/{props.revision.content.key}</code>
      </p>
      <SkillSource {...props} />
    </details>
  );
}

function SkillSource(props: RevisionDetailsProps) {
  return (
    <>
      <For each={props.revision.content.references}>
        {(file) => (
          <details>
            <summary>{file.path}</summary>
            <pre>{file.body}</pre>
          </details>
        )}
      </For>
      <For each={props.revision.content.files}>
        {(file) => (
          <details>
            <summary>{file.path}</summary>
            <pre>
              {file.encoding === "utf8"
                ? file.body
                : `Binary asset, ${file.body.length} base64 characters`}
            </pre>
          </details>
        )}
      </For>
      <Show when={props.revision.content.origin}>
        {(origin) => (
          <>
            <a href={origin().repository} target="_blank" rel="noopener noreferrer">
              {origin().repository}
            </a>
            <p>
              Commit {origin().commit} · {origin().path} · {origin().licence}
            </p>
            <Show when={props.onCheckUpdate}>
              <button
                type="button"
                class="quiet-button"
                disabled={props.busy}
                onClick={() => props.onCheckUpdate?.()}
              >
                Check source updates
              </button>
            </Show>
            <details>
              <summary>Licence</summary>
              <pre>{origin().licenceText}</pre>
            </details>
          </>
        )}
      </Show>
      <Show when={props.revision.content.review}>
        <p>{props.revision.content.review?.adaptations}</p>
      </Show>
      <Show when={props.revision.content.sourceSkill}>
        <details>
          <summary>Original SKILL.md</summary>
          <pre>{props.revision.content.sourceSkill}</pre>
        </details>
      </Show>
    </>
  );
}
