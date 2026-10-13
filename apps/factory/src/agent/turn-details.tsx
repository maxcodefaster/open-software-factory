import { For, Show } from "solid-js";
import type { TurnObservation } from "../../../../packages/conversation-domain/src/turn-observation";

const measured = (value: number | null) => (value === null ? "Unknown" : value.toLocaleString());

const taskLabels = {
  pending: "Pending",
  dispatching: "Dispatching",
  running: "Running",
  completed: "Turn completed",
  failed: "Failed",
  stopped: "Stopped",
  uncertain: "Outcome uncertain",
} satisfies Record<TurnObservation["state"], string>;

export function TurnDetails(props: { turn: TurnObservation | undefined }) {
  return (
    <Show when={props.turn}>
      {(turn) => (
        <section aria-label="Last admitted turn">
          <p>Last admitted turn · {taskLabels[turn().state]}</p>
          <dl>
            <dt>Engine / mode</dt>
            <dd>
              {turn().engine === "mastra" ? "Mastra" : "OpenCode 2"} / {turn().mode}
            </dd>
            <dt>Model</dt>
            <dd>{turn().modelId}</dd>
            <dt>Skills</dt>
            <dd>
              <Show when={turn().skills.length} fallback="No Skills admitted">
                <ul>
                  <For each={turn().skills}>
                    {(skill) => (
                      <li>
                        {skill.name} · r{skill.revision} · {skill.loaded ? "Loaded" : "Not loaded"}
                        <code title={`Content digest: ${skill.digest}`}>{skill.id}</code>
                      </li>
                    )}
                  </For>
                </ul>
              </Show>
            </dd>
          </dl>
          <p>Saved at admission, not your current defaults.</p>
          <Show when={turn().state === "uncertain"}>
            <p>Factory will not automatically replay this paid request.</p>
          </Show>
          <Show when={turn().state === "completed"}>
            <p>Turn completion is not Verification or Delivery approval.</p>
          </Show>
          <details>
            <summary>Usage and turn identity</summary>
            <dl>
              <dt>Turn</dt>
              <dd>
                <code>{turn().id}</code>
              </dd>
              <dt>Input / output tokens</dt>
              <dd>
                {measured(turn().usage.inputTokens)} / {measured(turn().usage.outputTokens)}
              </dd>
              <dt>Reasoning tokens</dt>
              <dd>{measured(turn().usage.reasoningTokens)}</dd>
              <dt>Cache read / write</dt>
              <dd>
                {measured(turn().usage.cacheReadTokens)} / {measured(turn().usage.cacheWriteTokens)}
              </dd>
              <dt>Cost / compute</dt>
              <dd>Unknown / not measured</dd>
            </dl>
            <p>
              {turn().usage.source === "mastra-provider"
                ? `${turn().usage.coverage === "partial" ? "Incomplete provider coverage; missing totals are unknown." : "Provider-reported tokens across this turn's Mastra steps."} Retained in memory for up to 30 minutes; unavailable after restart.`
                : turn().usage.source === "opencode-provider"
                  ? `${turn().usage.coverage === "partial" || turn().state === "running" ? "Partial" : "Observed"} provider tokens for this turn's assistant messages. Excludes title and compaction calls.`
                  : "No trustworthy token observation available for this turn."}
            </p>
            <p>
              Provider pricing and Sandbox compute usage are not measured. Unknown does not mean
              free.
            </p>
            <Show when={turn().summary}>
              <p>{turn().summary}</p>
            </Show>
          </details>
        </section>
      )}
    </Show>
  );
}
