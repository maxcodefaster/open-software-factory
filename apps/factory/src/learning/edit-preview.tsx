import { createSignal, Show } from "solid-js";
import type { LearningView } from "../../../../packages/conversation-domain/src/learning";

export type LearningDecision = (
  id: string,
  decision: "dismiss" | "create-ticket" | "apply",
  releasePrivate: boolean,
  editDigest?: string | null,
) => void;
export function LearningEditPreview(props: {
  proposal: LearningView["proposals"][number];
  busy?: boolean;
  canRequest: boolean;
  onDecide?: LearningDecision | undefined;
}) {
  const [release, setRelease] = createSignal(false);
  const needsRelease = () =>
    Boolean(
      props.proposal.private && (props.proposal.requiresPrivateRelease || !props.proposal.canApply),
    );
  return (
    <Show when={props.proposal.content.edit}>
      {(edit) => (
        <details class="work-edit-preview">
          <summary>Review exact edit</summary>
          <p class="work-note">
            {props.proposal.targetScope === "system"
              ? "Factory-wide"
              : props.proposal.targetScope === "personal"
                ? "Personal"
                : props.proposal.targetScope === "project"
                  ? "Project"
                  : "Exact"}{" "}
            {edit().target.kind} · {edit().target.field} · base version {edit().target.version}
          </p>
          <p class="work-note">
            {props.proposal.targetLabel ? `${props.proposal.targetLabel} · ` : "Resource "}
            <code>{edit().target.id}</code>
          </p>
          <div class="work-edit-passages">
            <section aria-label="Current passage">
              <h5>Before</h5>
              <pre>{edit().before}</pre>
            </section>
            <section aria-label="Proposed passage">
              <h5>After</h5>
              <pre>{edit().after}</pre>
            </section>
          </div>
          <p class="work-note">
            {props.proposal.comparisonState === "not-demonstrated"
              ? "The matched text comparison did not demonstrate improvement. Manual application remains your decision."
              : props.proposal.comparisonState === "running"
                ? "A matched text comparison is running. Applying now makes an explicit human decision instead."
                : props.proposal.comparisonState === "unconfirmed"
                  ? "The comparison did not establish a result and will not repeat automatically. Manual application remains your decision."
                  : "This edit has not been benchmarked. Applying it records your explicit decision, not a proven improvement."}
          </p>
          <p class="work-note">
            {edit().target.kind === "skill"
              ? "New work adopts the owning scope's version. Admitted turns keep their exact Skill revisions."
              : edit().target.kind === "knowledge"
                ? "Creates a new Wiki revision. Writing outside this exact passage stays unchanged."
                : "Changes only the saved task after current Input work settles. Sources, delegation, key and enabled state stay unchanged."}
          </p>
          <Show when={needsRelease()}>
            <label class="work-edit-release">
              <input
                type="checkbox"
                checked={release()}
                onChange={(event) => setRelease(event.currentTarget.checked)}
              />
              Share this exact edit outside my private work. Do not share the private case packet.
            </label>
          </Show>
          <Show
            when={props.proposal.canApply}
            fallback={
              <p class="work-note">
                {props.proposal.applyBlockedReason ??
                  "The owning settings manager must apply this edit."}
              </p>
            }
          >
            <button
              class="secondary-button"
              type="button"
              disabled={props.busy || !props.proposal.editDigest || (needsRelease() && !release())}
              onClick={() =>
                props.onDecide?.(props.proposal.id, "apply", release(), props.proposal.editDigest)
              }
            >
              Apply exact edit
            </button>
          </Show>
          <Show when={!props.proposal.canApply && props.canRequest}>
            <button
              class="secondary-button"
              type="button"
              disabled={props.busy || !props.proposal.editDigest || (needsRelease() && !release())}
              onClick={() =>
                props.onDecide?.(
                  props.proposal.id,
                  "create-ticket",
                  release(),
                  props.proposal.editDigest,
                )
              }
            >
              {props.proposal.private
                ? "Share exact edit as Ticket"
                : "Request settings edit in Ticket"}
            </button>
          </Show>
        </details>
      )}
    </Show>
  );
}
