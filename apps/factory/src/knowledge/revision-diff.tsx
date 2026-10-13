import { diffLines } from "diff";
import { For } from "solid-js";
export function RevisionDiff(props: { previous: string; current: string }) {
  const lines = () =>
    diffLines(props.previous, props.current, { timeout: 100, maxEditLength: 10_000 }) ?? [
      { removed: true, added: false, value: props.previous },
      { removed: false, added: true, value: props.current },
    ];
  return (
    <section class="knowledge-text-diff" aria-label="Revision text changes">
      <For each={lines()}>
        {(line) => (
          <pre class={line.added ? "diff-added" : line.removed ? "diff-removed" : "diff-unchanged"}>
            <span aria-hidden="true">{line.added ? "+" : line.removed ? "−" : " "}</span>
            {line.value}
          </pre>
        )}
      </For>
    </section>
  );
}
