import { createPatch } from "diff";
import { Show } from "solid-js";
import type {
  LibraryChoice,
  SkillLibraryEntry,
  SkillScope,
} from "../../../../packages/conversation-domain/src/skill-library";
import type { SkillRole } from "../../../../packages/conversation-domain/src/skills";
import { type SkillChoiceState, skillAvailability, skillRoleLabel } from "./gallery-state";

export type ChooseSkill = (
  entry: SkillLibraryEntry,
  scope: SkillScope,
  role: SkillRole,
  state: SkillChoiceState,
  revisionId?: string,
) => void;

export function SkillChoiceControls(props: {
  entry: SkillLibraryEntry;
  choices: LibraryChoice[];
  scope: SkillScope;
  role: SkillRole;
  busy: boolean;
  projectId?: string | undefined;
  onChoose: ChooseSkill;
}) {
  const state = () => skillAvailability(props.entry, props.choices, props.scope, props.role);
  const label = () => `${props.entry.revisions[0]?.content.name} ${skillRoleLabel(props.role)}`;
  return (
    <Show when={state().compatible}>
      <div class="skill-choice">
        <label>
          <span>{skillRoleLabel(props.role)}</span>
          <select
            aria-label={`${label()} choice`}
            value={state().locked ? "inherit" : (state().own?.state ?? "inherit")}
            disabled={
              props.busy || state().locked || (props.scope !== "system" && !props.projectId)
            }
            onChange={(event) =>
              props.onChoose(
                props.entry,
                props.scope,
                props.role,
                event.currentTarget.value as SkillChoiceState,
              )
            }
          >
            <option value="inherit">
              Follow defaults ·{" "}
              {state().inherited && state().inherited?.state !== "disable" ? "On" : "Off"}
            </option>
            <option value="enable">Enable</option>
            <option value="disable">Disable</option>
            <Show when={props.scope !== "personal"}>
              <option value="required">Required</option>
            </Show>
          </select>
        </label>
        <span
          class="skill-state"
          data-state={state().required ? "required" : state().enabled ? "enabled" : "disabled"}
        >
          {state().label}
        </span>
        <Show when={state().revision}>
          {(revision) => <small>Version {revision().revision} for new work</small>}
        </Show>
        <Show when={state().updateAvailable}>
          <details class="skill-update">
            <summary>Update available · v{state().latest?.revision}</summary>
            <p>
              Review the changes before adopting this version for {skillRoleLabel(props.role)}.
              Existing work keeps its original version.
            </p>
            <pre>
              {createPatch(
                props.entry.revisions[0]?.content.key ?? "skill",
                JSON.stringify(state().revision?.content, null, 2),
                JSON.stringify(state().latest?.content, null, 2),
                `v${state().revision?.revision}`,
                `v${state().latest?.revision}`,
              )}
            </pre>
            <Show
              when={!state().locked}
              fallback={<p>The requiring authority must adopt this update.</p>}
            >
              <button
                type="button"
                class="quiet-button"
                disabled={
                  props.busy ||
                  !state().latest?.content.roles.includes(props.role) ||
                  (props.scope !== "system" && !props.projectId)
                }
                onClick={() =>
                  props.onChoose(
                    props.entry,
                    props.scope,
                    props.role,
                    state().effective?.state === "required"
                      ? "required"
                      : state().enabled
                        ? "enable"
                        : "disable",
                    state().latest?.id,
                  )
                }
              >
                Use v{state().latest?.revision} for {skillRoleLabel(props.role)}
              </button>
            </Show>
          </details>
        </Show>
      </div>
    </Show>
  );
}
