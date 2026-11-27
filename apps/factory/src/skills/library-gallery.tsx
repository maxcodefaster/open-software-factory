import { For, Show } from "solid-js";
import type {
  SkillLibraryEntry,
  SkillLibraryView,
  SkillScope,
} from "#conversation-domain/skill-library";
import type { SkillRevision } from "#conversation-domain/skills";
import { skillCover, skillSummary } from "./cover";
import { type SkillFilters, skillAvailability } from "./gallery-state";
import { SkillRevisionDetails } from "./revision-details";

export function SkillManageContextBar(props: {
  managing: boolean;
  managementScope: "project" | "system";
  canManageProject: boolean;
  canManageSystem: boolean;
  projectId: string | undefined;
  projectName: string | undefined;
  onExitManage: () => void;
  onChangeTarget: (target: "project" | "system") => void;
}) {
  return (
    <div class="skill-library-context">
      <nav aria-label="Skill library views">
        <button
          type="button"
          class="quiet-button"
          aria-pressed={props.managing ? "false" : "true"}
          onClick={props.onExitManage}
        >
          Browse skills
        </button>
      </nav>
      <label>
        Manage defaults for
        <select
          value={props.managementScope}
          onChange={(event) =>
            props.onChangeTarget(event.currentTarget.value as "project" | "system")
          }
        >
          <Show when={props.canManageProject && props.projectId}>
            <option value="project">{props.projectName ?? "This Project"}</option>
          </Show>
          <Show when={props.canManageSystem}>
            <option value="system">Everyone in Factory</option>
          </Show>
        </select>
      </label>
      <p>Shared defaults, not personal choices.</p>
    </div>
  );
}

export function SkillLibraryGallery(props: {
  hidden: boolean;
  managing: boolean;
  view: SkillLibraryView | undefined;
  entries: SkillLibraryEntry[];
  proposals: SkillLibraryView["proposals"];
  scope: SkillScope;
  roleFilter: SkillFilters["role"];
  selectedId: string | undefined;
  inspected: { proposalId: string; revision: SkillRevision } | undefined;
  busy: boolean;
  onGalleryRef: (element: HTMLDivElement) => void;
  onInspectProposal: (proposalId: string, revisionId: string) => void;
  onAcceptProposal: (proposalId: string) => void;
  onOpenSkill: (id: string) => void;
  onClearFilters: () => void;
}) {
  return (
    <div class="skill-gallery-scroll" hidden={props.hidden} ref={props.onGalleryRef}>
      <Show when={props.managing}>
        <section class="skill-proposals" aria-label="Sharing review queue">
          <h3>Sharing review · {props.proposals.length}</h3>
          <Show when={!props.proposals.length}>
            <p>No sharing proposals awaiting your review.</p>
          </Show>
          <For each={props.proposals}>
            {(proposal) => (
              <section class="skill-proposal" aria-label={proposal.name}>
                <h4>{proposal.name}</h4>
                <p>Review the exact proposed version before adding a separate shared copy.</p>
                <button
                  type="button"
                  class="quiet-button"
                  disabled={props.busy}
                  onClick={() => props.onInspectProposal(proposal.id, proposal.revisionId)}
                >
                  Inspect proposed version
                </button>
                <Show when={props.inspected?.proposalId === proposal.id}>
                  <Show when={props.inspected?.revision}>
                    {(revision) => <SkillRevisionDetails revision={revision()} expanded />}
                  </Show>
                </Show>
                <button
                  type="button"
                  class="quiet-button"
                  disabled={props.busy || props.inspected?.proposalId !== proposal.id}
                  onClick={() => props.onAcceptProposal(proposal.id)}
                >
                  Add to shared library
                </button>
              </section>
            )}
          </For>
        </section>
      </Show>
      <section class="skill-gallery" aria-label="Skill gallery">
        <For each={props.entries}>
          {(entry) => {
            const states = () =>
              (["planning", "build"] as const)
                .filter((item) => props.roleFilter === "all" || item === props.roleFilter)
                .map((item) => ({
                  role: item,
                  ...skillAvailability(entry, props.view?.choices ?? [], props.scope, item),
                }))
                .filter((item) => item.compatible);
            const revision = () => states()[0]?.revision ?? entry.revisions[0];
            return (
              <article class="skill-gallery-card" aria-label={revision()?.content.name}>
                <button
                  id={`skill-open-${entry.id}`}
                  type="button"
                  class="skill-tile"
                  aria-pressed={props.selectedId === entry.id ? "true" : "false"}
                  onClick={() => props.onOpenSkill(entry.id)}
                >
                  <img
                    class="skill-cover"
                    src={skillCover(entry.id, entry.cover)}
                    width="384"
                    height="512"
                    alt=""
                    loading="lazy"
                    decoding="async"
                  />
                  <span class="skill-tile-caption">
                    <span class="skill-tile-title">{revision()?.content.name}</span>
                    <span class="skill-tile-description">
                      <Show when={revision()}>{(item) => <>{skillSummary(item().content)}</>}</Show>
                    </span>
                  </span>
                </button>
              </article>
            );
          }}
        </For>
      </section>
      <Show when={props.view && !props.entries.length}>
        <div class="skill-library-empty">
          <h3>No matching skills</h3>
          <p>Try another search or clear the filters. You can also create or import a skill.</p>
          <button type="button" class="quiet-button" onClick={props.onClearFilters}>
            Clear filters
          </button>
        </div>
      </Show>
      <Show when={props.view?.sharedVersions.length && !props.managing}>
        <details class="skill-shared-history">
          <summary>Versions used in shared work</summary>
          <p>
            Only these exact personal versions are visible. Other private versions stay private.
          </p>
          <For each={props.view?.sharedVersions}>
            {(revision) => (
              <section>
                <h4>
                  {revision.content.name} · v{revision.revision}
                </h4>
                <SkillRevisionDetails revision={revision} />
              </section>
            )}
          </For>
        </details>
      </Show>
    </div>
  );
}
