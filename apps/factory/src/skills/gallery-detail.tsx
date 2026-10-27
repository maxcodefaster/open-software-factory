import { createSignal, For, Show } from "solid-js";
import type {
  SkillLibraryEntry,
  SkillLibraryView,
  SkillScope,
} from "../../../../packages/conversation-domain/src/skill-library";
import type { SkillRole } from "../../../../packages/conversation-domain/src/skills";
import { WorkspaceActionBar } from "../ui/workspace-actions";
import { type ChooseSkill, SkillChoiceControls } from "./choice-controls";
import { skillCover } from "./cover";
import { skillAvailability, skillRoleLabel, skillScopeLabel } from "./gallery-state";
import { SkillRevisionDetails, SkillRevisionSource } from "./revision-details";
import { LibraryCoverPicker } from "../library-covers/picker";
import type { LibraryCoverKey } from "../../../../packages/conversation-domain/src/library-covers";

export function SkillGalleryDetail(props: {
  entry: SkillLibraryEntry;
  view: SkillLibraryView;
  scope: SkillScope;
  projectId?: string | undefined;
  projectName?: string | undefined;
  busy: boolean;
  hasDraft: boolean;
  preferredRole: "all" | SkillRole;
  onChoose: ChooseSkill;
  onClose: () => void;
  onEdit: (entry: SkillLibraryEntry) => void;
  onCheckSource: (entry: SkillLibraryEntry) => void;
  onShare: (entry: SkillLibraryEntry, target: "project" | "system") => void;
  onHeading: (element: HTMLHeadingElement) => void;
  onCover: (key: LibraryCoverKey, expectedVersion: number) => Promise<boolean>;
}) {
  const [reading, setReading] = createSignal<SkillRole>(
    props.preferredRole === "build" ? "build" : "planning",
  );
  const [target, setTarget] = createSignal<"project" | "system">(
    props.projectId ? "project" : "system",
  );
  const roles = () =>
    (["planning", "build"] as const).filter(
      (role) => skillAvailability(props.entry, props.view.choices, props.scope, role).compatible,
    );
  const readingRole = () => (roles().includes(reading()) ? reading() : (roles()[0] ?? "build"));
  const state = () =>
    skillAvailability(props.entry, props.view.choices, props.scope, readingRole());
  const pending = () =>
    props.view.proposals.some(
      (proposal) => proposal.revisionId === state().latest?.id && proposal.target === target(),
    );
  const canEdit = () => props.entry.editable;
  return (
    <section
      class="skill-gallery-detail"
      aria-label="Skill details"
      onKeyDown={(event) => {
        if (event.key === "Escape" && !(event.target instanceof HTMLSelectElement)) {
          event.preventDefault();
          event.stopPropagation();
          props.onClose();
        }
      }}
    >
      <header class="skill-detail-heading">
        <img
          class="skill-cover"
          src={skillCover(props.entry.id, props.entry.cover)}
          width="384"
          height="512"
          alt=""
          decoding="async"
        />
        <div class="skill-detail-introduction">
          <div class="workspace-heading">
            <h3 class="workspace-heading-title" tabindex="-1" ref={props.onHeading}>
              {state().revision?.content.name}
            </h3>
            <WorkspaceActionBar label="Skill actions">
              <button type="button" class="workspace-action" onClick={props.onClose}>
                Back to library
              </button>
              <Show when={canEdit()}>
                <button
                  type="button"
                  class="workspace-action"
                  data-primary="true"
                  disabled={props.busy || props.hasDraft}
                  title={
                    props.hasDraft ? "Resume or discard your existing draft first." : undefined
                  }
                  onClick={() => props.onEdit(props.entry)}
                >
                  Edit skill
                </button>
              </Show>
            </WorkspaceActionBar>
          </div>
          <p>{state().revision?.content.description}</p>
          <p class="skill-detail-origin">
            {props.entry.scope === "personal"
              ? "Personal library"
              : `${skillScopeLabel(props.entry.scope)} library`}
          </p>
          <For
            each={roles().filter(
              (role) =>
                skillAvailability(props.entry, props.view.choices, props.scope, role).required,
            )}
          >
            {(role) => (
              <p class="skill-state" data-state="required">
                {skillRoleLabel(role)} ·{" "}
                {skillAvailability(props.entry, props.view.choices, props.scope, role).label}
              </p>
            )}
          </For>
        </div>
      </header>
      <Show when={canEdit()}>
        <LibraryCoverPicker
          kind="skill"
          cover={props.entry.cover}
          busy={props.busy}
          onSave={props.onCover}
        />
      </Show>
      <Show
        when={
          new Set(
            roles().map(
              (role) =>
                skillAvailability(props.entry, props.view.choices, props.scope, role).revision?.id,
            ),
          ).size > 1
        }
      >
        <label class="skill-reading-role">
          Read version for
          <select
            value={readingRole()}
            onChange={(event) => setReading(event.currentTarget.value as SkillRole)}
          >
            <For each={roles()}>
              {(role) => <option value={role}>{skillRoleLabel(role)}</option>}
            </For>
          </select>
        </label>
      </Show>
      <Show when={state().revision}>
        {(revision) => (
          <SkillRevisionDetails
            revision={revision()}
            expanded
            reading
            busy={props.busy || props.hasDraft}
            onCheckUpdate={canEdit() ? () => props.onCheckSource(props.entry) : undefined}
          />
        )}
      </Show>
      <section class="skill-availability" aria-label="Skill availability">
        <h4>
          {props.scope === "personal"
            ? `For you${props.projectName ? ` in ${props.projectName}` : ""}`
            : props.scope === "project"
              ? `Defaults for ${props.projectName ?? "this Project"}`
              : "Defaults for everyone in Factory"}
        </h4>
        <Show when={props.scope !== "system" && !props.projectId}>
          <p>Select a Project to enable skills. Your personal library spans Projects.</p>
        </Show>
        <For each={roles()}>
          {(role) => (
            <SkillChoiceControls
              entry={props.entry}
              choices={props.view.choices}
              scope={props.scope}
              role={role}
              busy={props.busy}
              projectId={props.projectId}
              onChoose={props.onChoose}
            />
          )}
        </For>
        <p class="skill-help">
          {state().revision?.content.manualOnly
            ? `Manual only. Invoke /${state().revision?.content.key} explicitly to load it.`
            : "Enabled skills are available when relevant, not guaranteed to load."}{" "}
          Changes apply to new work only.
        </p>
      </section>
      <Show when={state().revision}>
        {(revision) => (
          <SkillRevisionSource
            revision={revision()}
            busy={props.busy || props.hasDraft}
            onCheckUpdate={canEdit() ? () => props.onCheckSource(props.entry) : undefined}
          />
        )}
      </Show>
      <Show when={canEdit() && props.hasDraft}>
        <p class="skill-help">
          Resume or discard your existing draft before editing another skill.
        </p>
      </Show>
      <Show when={props.entry.scope === "personal" && props.scope === "personal"}>
        <details class="skill-sharing">
          <summary>Share this skill</summary>
          <p>
            Propose v{state().latest?.revision} for manager review. Acceptance creates a separate
            shared copy, without sharing your other private versions or enabling the copy.
          </p>
          <label>
            Share with
            <select
              aria-label={`${state().latest?.content.name} sharing scope`}
              value={target()}
              disabled={props.busy}
              onChange={(event) => setTarget(event.currentTarget.value as "project" | "system")}
            >
              <Show when={props.projectId}>
                <option value="project">{props.projectName ?? "This Project"}</option>
              </Show>
              <option value="system">Factory</option>
            </select>
          </label>
          <button
            type="button"
            class="quiet-button"
            disabled={props.busy || pending()}
            onClick={() => props.onShare(props.entry, target())}
          >
            {pending() ? "Sharing proposed" : "Propose sharing"}
          </button>
          <Show when={pending()}>
            <p>Awaiting manager review of this exact version.</p>
          </Show>
        </details>
      </Show>
      <Show when={props.entry.revisions.length > 1}>
        <details class="skill-version-history">
          <summary>Version history · {props.entry.revisions.length} versions</summary>
          <p>Published versions are immutable. Viewing history never adopts a version.</p>
          <For each={props.entry.revisions}>
            {(revision) => (
              <section>
                <h4>Version {revision.revision}</h4>
                <SkillRevisionDetails revision={revision} />
              </section>
            )}
          </For>
        </details>
      </Show>
    </section>
  );
}
