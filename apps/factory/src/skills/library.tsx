import { createEffect, createSignal, For, Show } from "solid-js";
import type { JSX } from "@solidjs/web";
import { z } from "zod";
import {
  type SkillLibraryEntry,
  type SkillLibraryView,
  type SkillScope,
  skillLibraryView,
} from "../../../../packages/conversation-domain/src/skill-library";
import {
  type SkillContent,
  type SkillRevision,
  skillContentInput,
  skillRevisionInput,
} from "../../../../packages/conversation-domain/src/skills";
import { apiRequest } from "../api-client";
import { Icon } from "../icon";
import { WorkspaceActionBar } from "../ui/workspace-actions";
import type { ChooseSkill } from "./choice-controls";
import { skillCover, skillSummary } from "./cover";
import { SkillGalleryDetail } from "./gallery-detail";
import { matchesSkill, type SkillFilters, skillAvailability } from "./gallery-state";
import { SkillImportPanel } from "./import-panel";
import { SkillRevisionDetails } from "./revision-details";
import { SkillRevisionEditor } from "./revision-editor";
import "./library.css";

const resultInput = z.object({ content: skillContentInput, warnings: z.array(z.string()) });
export function SkillLibrary(props: {
  projectId?: string | undefined;
  projectName?: string | undefined;
  active?: boolean | undefined;
  navigation?: JSX.Element;
}) {
  const [view, setView] = createSignal<SkillLibraryView>();
  const [query, setQuery] = createSignal("");
  const [owner, setOwner] = createSignal<SkillFilters["owner"]>("all");
  const [role, setRole] = createSignal<SkillFilters["role"]>("all");
  const [availability, setAvailability] = createSignal<SkillFilters["availability"]>("all");
  const [filtersOpen, setFiltersOpen] = createSignal(false);
  const [managing, setManaging] = createSignal(false);
  const [managementTarget, setManagementTarget] = createSignal<"project" | "system">("project");
  const [selected, setSelected] = createSignal<string>();
  const [editing, setEditing] = createSignal<{
    content: SkillContent;
    entry?: SkillLibraryEntry;
    warnings?: string[];
  }>();
  const [editorOpen, setEditorOpen] = createSignal(false);
  const [importing, setImporting] = createSignal(false);
  const [inspected, setInspected] = createSignal<{ proposalId: string; revision: SkillRevision }>();
  const [busy, setBusy] = createSignal(false);
  const [loading, setLoading] = createSignal(false);
  const [error, setError] = createSignal("");
  const [status, setStatus] = createSignal("");
  const canManage = () => view()?.canManageProject || view()?.canManageSystem;
  const managementScope = () =>
    view()?.canManageProject && props.projectId
      ? view()?.canManageSystem
        ? managementTarget()
        : "project"
      : "system";
  const scope = (): SkillScope => (managing() && canManage() ? managementScope() : "personal");
  const suffix = () => (props.projectId ? `?project=${props.projectId}` : "");
  let sequence = 0;
  let detailHeading: HTMLHeadingElement | undefined;
  let newButton: HTMLButtonElement | undefined;
  let actionMenu: HTMLDetailsElement | undefined;
  let actionTrigger: HTMLElement | undefined;
  let filterRoot: HTMLDivElement | undefined;
  let filterButton: HTMLButtonElement | undefined;
  let libraryRoot: HTMLDivElement | undefined;
  let galleryScroll: HTMLDivElement | undefined;
  let savedScroll = 0;
  const filterID = `skill-filters-${crypto.randomUUID()}`;
  function clearFeedback() {
    setStatus("");
    setError("");
  }
  function focusWorkflow(selector: string) {
    requestAnimationFrame(() => {
      const heading = libraryRoot?.querySelector<HTMLHeadingElement>(selector);
      heading?.closest(".skill-editor-screen")?.scrollTo(0, 0);
      heading?.focus({ preventScroll: true });
    });
  }
  const report = (cause: unknown) =>
    setError(cause instanceof Error ? cause.message : "Could not load library. Try reloading.");
  async function load() {
    const request = ++sequence;
    setLoading(true);
    try {
      const next = await apiRequest(skillLibraryView, `/api/skills${suffix()}`);
      if (request !== sequence) return;
      setView(next);
      if (!next.canManageProject && !next.canManageSystem) setManaging(false);
      return next;
    } finally {
      if (request === sequence) setLoading(false);
    }
  }
  createEffect(
    () => ({ projectId: props.projectId, active: props.active }),
    ({ active }) => {
      if (active !== false) void load().catch(report);
      return () => {
        sequence++;
      };
    },
  );
  createEffect(
    () => props.active,
    (active) => {
      if (active === false) return;
      const dismiss = (event: PointerEvent) => {
        if (!(event.target instanceof Node)) return;
        if (filtersOpen() && !filterRoot?.contains(event.target)) setFiltersOpen(false);
        if (actionMenu?.open && !actionMenu.contains(event.target)) actionMenu.open = false;
      };
      document.addEventListener("pointerdown", dismiss);
      return () => document.removeEventListener("pointerdown", dismiss);
    },
  );
  const selectedEntry = () => view()?.entries.find((entry) => entry.id === selected());
  const entries = () =>
    (view()?.entries ?? [])
      .filter(
        (entry) =>
          entry.revisions.length &&
          (!managing() ||
            (entry.scope !== "personal" && (scope() !== "system" || entry.scope === "system"))) &&
          matchesSkill(entry, view()?.choices ?? [], scope(), {
            query: query(),
            owner: owner(),
            role: role(),
            availability: availability(),
          }),
      )
      .toSorted((a, b) =>
        (a.revisions[0]?.content.name ?? "").localeCompare(b.revisions[0]?.content.name ?? ""),
      );
  const proposals = () =>
    (view()?.proposals ?? []).filter(
      (proposal) =>
        proposal.target === scope() &&
        (proposal.target === "system" ? view()?.canManageSystem : view()?.canManageProject),
    );
  function clearFilters() {
    setQuery("");
    setOwner("all");
    setRole("all");
    setAvailability("all");
  }
  function openSkill(id: string) {
    savedScroll = galleryScroll?.scrollTop ?? 0;
    closeActions();
    setFiltersOpen(false);
    setSelected(id);
    requestAnimationFrame(() => {
      detailHeading?.closest(".skill-gallery-detail")?.scrollTo(0, 0);
      detailHeading?.focus({ preventScroll: true });
    });
  }
  function closeSkill() {
    const id = selected();
    setSelected(undefined);
    requestAnimationFrame(() => {
      if (galleryScroll) galleryScroll.scrollTop = savedScroll;
      const target =
        document.getElementById(`skill-open-${id}`) ??
        document.querySelector<HTMLInputElement>(".skill-search input");
      target?.focus({ preventScroll: true });
    });
  }
  async function mutate(action: () => Promise<unknown>, message: string) {
    if (busy()) return;
    setBusy(true);
    setError("");
    setStatus("");
    try {
      const result = await action();
      setStatus(typeof result === "string" ? result : message);
      try {
        await load();
      } catch {
        setError("The action completed, but the library could not refresh. Reload to see it.");
      }
    } catch (cause) {
      report(cause);
    } finally {
      setBusy(false);
    }
  }
  const choose: ChooseSkill = (entry, target, selectedRole, state, revisionId) => {
    const current = skillAvailability(entry, view()?.choices ?? [], target, selectedRole);
    void mutate(
      () =>
        apiRequest(z.object({ saved: z.boolean() }), "/api/skills/choices", {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            libraryId: entry.id,
            scope: target,
            ...(props.projectId ? { projectId: props.projectId } : {}),
            role: selectedRole,
            state,
            revisionId: revisionId ?? current.revision?.id,
            expectedVersion: current.own?.version ?? 0,
          }),
        }),
      target === "personal"
        ? "Choice saved for your new work in this Project"
        : `Default saved for new ${target === "system" ? "Factory" : "Project"} work`,
    );
  };
  function edit(entry?: SkillLibraryEntry) {
    clearFeedback();
    if (!editing())
      setEditing({
        ...(entry ? { entry } : {}),
        content: entry?.revisions[0]?.content ?? {
          key: "custom-skill",
          name: "",
          description: "",
          instructions: "",
          roles: ["planning", "build"],
          references: [],
        },
      });
    setEditorOpen(true);
    focusWorkflow(".skill-editor h3");
  }
  function checkSource(entry: SkillLibraryEntry) {
    if (editing()) return;
    void mutate(async () => {
      const revision = entry.revisions[0];
      if (!revision) return;
      const result = await apiRequest(
        z.discriminatedUnion("current", [
          z.object({ current: z.literal(true) }),
          resultInput.extend({ current: z.literal(false) }),
        ]),
        `/api/skills/revisions/${revision.id}/source-update${suffix()}`,
      );
      if (result.current) return "The pinned source is current";
      setEditing({
        entry,
        content: { ...result.content, key: revision.content.key, name: revision.content.name },
        warnings: [
          ...result.warnings,
          "A newer pinned source is available. Compare it with the saved version. Factory adaptations and your edits are not merged automatically.",
        ],
      });
      setEditorOpen(true);
      focusWorkflow(".skill-editor h3");
    }, "Source check complete");
  }
  function share(entry: SkillLibraryEntry, target: "project" | "system") {
    void mutate(
      () =>
        apiRequest(z.object({ id: z.uuid() }), "/api/skills/share", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            id: crypto.randomUUID(),
            revisionId: entry.revisions[0]?.id,
            target,
            ...(target === "project" ? { projectId: props.projectId } : {}),
          }),
        }),
      "Exact version proposed for sharing",
    );
  }
  function closeActions() {
    if (actionMenu) actionMenu.open = false;
  }
  function returnFromEditor() {
    requestAnimationFrame(() =>
      selectedEntry() ? detailHeading?.focus({ preventScroll: true }) : newButton?.focus(),
    );
  }
  return (
    <div
      class="skill-library"
      data-detail={selectedEntry() ? "true" : "false"}
      ref={(element) => {
        libraryRoot = element;
      }}
    >
      <header
        class="skill-library-heading"
        hidden={Boolean(selectedEntry()) && !editorOpen() && !importing()}
      >
        <WorkspaceActionBar label="Skills library actions" leading={props.navigation}>
          <details
            class="skill-action-menu"
            ref={(element) => {
              actionMenu = element;
            }}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.preventDefault();
                event.stopPropagation();
                closeActions();
                actionTrigger?.focus();
              }
            }}
          >
            <summary
              class="workspace-action workspace-menu-trigger"
              aria-label="Library actions"
              ref={(element) => {
                actionTrigger = element;
              }}
            >
              <Icon name="more" />
            </summary>
            <div class="skill-action-options">
              <button
                type="button"
                class="quiet-button"
                disabled={busy() || Boolean(editing()) || editorOpen() || importing()}
                title={editing() ? "Finish or discard your draft before importing" : undefined}
                onClick={() => {
                  closeActions();
                  clearFeedback();
                  setImporting(true);
                  focusWorkflow(".skill-import-panel h3");
                }}
              >
                Import
              </button>
              <Show when={canManage()}>
                <button
                  type="button"
                  class="quiet-button"
                  disabled={editorOpen() || importing()}
                  onClick={() => {
                    closeActions();
                    setManaging(true);
                    setOwner("all");
                    setSelected(undefined);
                    void load().catch(report);
                  }}
                >
                  Manage
                </button>
              </Show>
            </div>
          </details>
          <button
            ref={(element) => {
              newButton = element;
            }}
            type="button"
            class="workspace-action"
            data-primary="true"
            disabled={busy() || importing()}
            onClick={() => edit()}
          >
            {editing() ? "Resume draft" : "Add skill"}
          </button>
        </WorkspaceActionBar>
        <div class="skill-library-title">
          <h2>Skills library</h2>
          <Show when={!editorOpen() && !importing()}>
            <span class="skill-result-count" aria-live="polite">
              {view() ? `${entries().length} ${entries().length === 1 ? "skill" : "skills"}` : ""}
            </span>
          </Show>
        </div>
        <div class="skill-library-tools">
          <Show when={!editorOpen() && !importing()}>
            <label class="skill-search">
              <Icon name="search" />
              <input
                type="search"
                aria-label="Search skills"
                placeholder="Find a skill"
                value={query()}
                onInput={(event) => setQuery(event.currentTarget.value)}
              />
            </label>
            <div
              class="skill-filter-control"
              ref={(element) => {
                filterRoot = element;
              }}
            >
              <button
                ref={(element) => {
                  filterButton = element;
                }}
                type="button"
                class="workspace-action skill-filter-toggle"
                aria-label="Filters"
                aria-expanded={filtersOpen() ? "true" : "false"}
                aria-controls={filterID}
                onClick={() => {
                  closeActions();
                  setFiltersOpen((open) => !open);
                }}
                onKeyDown={(event) => {
                  if (event.key === "Escape") {
                    event.preventDefault();
                    event.stopPropagation();
                    setFiltersOpen(false);
                    filterButton?.focus();
                  }
                }}
              >
                Filter
                {owner() !== "all" || role() !== "all" || availability() !== "all"
                  ? ` · ${[owner(), role(), availability()].filter((value) => value !== "all").length}`
                  : ""}
              </button>
              <div class="skill-filter-options" id={filterID} hidden={!filtersOpen()}>
                <label>
                  Ownership
                  <select
                    value={owner()}
                    onChange={(event) =>
                      setOwner(event.currentTarget.value as SkillFilters["owner"])
                    }
                  >
                    <option value="all">All owners</option>
                    <Show when={!managing()}>
                      <option value="personal">Only me</option>
                    </Show>
                    <option value="project">Project</option>
                    <option value="system">Factory</option>
                  </select>
                </label>
                <label>
                  Work type
                  <select
                    value={role()}
                    onChange={(event) => setRole(event.currentTarget.value as SkillFilters["role"])}
                  >
                    <option value="all">All work types</option>
                    <option value="planning">Investigate &amp; Plan</option>
                    <option value="build">Build</option>
                  </select>
                </label>
                <label>
                  Availability
                  <select
                    value={availability()}
                    onChange={(event) =>
                      setAvailability(event.currentTarget.value as SkillFilters["availability"])
                    }
                  >
                    <option value="all">Any availability</option>
                    <option value="enabled">Enabled</option>
                    <option value="disabled">Off</option>
                    <option value="required">Required</option>
                    <option value="updates">Updates available</option>
                  </select>
                </label>
              </div>
            </div>
          </Show>
        </div>
      </header>
      <div class="skill-editor-screen" hidden={!editorOpen()}>
        <Show when={editing()}>
          {(editor) => (
            <SkillRevisionEditor
              content={editor().content}
              entry={editor().entry}
              warnings={editor().warnings}
              scope="personal"
              projectId={props.projectId}
              canManageProject={view()?.canManageProject ?? false}
              canManageSystem={view()?.canManageSystem ?? false}
              onCancel={() => {
                setEditorOpen(false);
                returnFromEditor();
              }}
              onDiscard={() => {
                setEditorOpen(false);
                setEditing(undefined);
                returnFromEditor();
              }}
              onSaved={(saved) => {
                setEditorOpen(false);
                setEditing(undefined);
                if (saved.scope === "personal") setManaging(false);
                else if (managing()) setManagementTarget(saved.scope);
                setSelected(saved.libraryId);
                void mutate(async () => saved, "Skill saved. Choose where to enable it.").then(
                  () => {
                    if (selectedEntry()?.id === saved.libraryId) {
                      requestAnimationFrame(() => {
                        detailHeading?.closest(".skill-gallery-detail")?.scrollTo(0, 0);
                        detailHeading?.focus({ preventScroll: true });
                      });
                    }
                  },
                );
              }}
            />
          )}
        </Show>
      </div>
      <div class="skill-editor-screen" hidden={!importing()}>
        <SkillImportPanel
          onCancel={() => {
            setImporting(false);
            requestAnimationFrame(() => actionTrigger?.focus({ preventScroll: true }));
          }}
          onPreview={(preview) => {
            clearFeedback();
            setEditing(preview);
            setImporting(false);
            setEditorOpen(true);
            focusWorkflow(".skill-editor h3");
          }}
        />
      </div>
      <div class="skill-library-browser" hidden={editorOpen() || importing()}>
        <Show when={managing() && !selectedEntry()}>
          <div class="skill-library-context">
            <nav aria-label="Skill library views">
              <button
                type="button"
                class="quiet-button"
                aria-pressed={managing() ? "false" : "true"}
                onClick={() => {
                  setManaging(false);
                  setSelected(undefined);
                }}
              >
                Browse skills
              </button>
            </nav>
            <label>
              Manage defaults for
              <select
                value={managementScope()}
                onChange={(event) => {
                  setManagementTarget(event.currentTarget.value as "project" | "system");
                  setOwner("all");
                  setSelected(undefined);
                  setInspected(undefined);
                }}
              >
                <Show when={view()?.canManageProject && props.projectId}>
                  <option value="project">{props.projectName ?? "This Project"}</option>
                </Show>
                <Show when={view()?.canManageSystem}>
                  <option value="system">Everyone in Factory</option>
                </Show>
              </select>
            </label>
            <p>Shared defaults, not personal choices.</p>
          </div>
        </Show>
        <div class="skill-library-layout">
          <div
            class="skill-gallery-scroll"
            hidden={Boolean(selectedEntry())}
            ref={(element) => {
              galleryScroll = element;
            }}
          >
            <Show when={managing()}>
              <section class="skill-proposals" aria-label="Sharing review queue">
                <h3>Sharing review · {proposals().length}</h3>
                <Show when={!proposals().length}>
                  <p>No sharing proposals awaiting your review.</p>
                </Show>
                <For each={proposals()}>
                  {(proposal) => (
                    <section class="skill-proposal" aria-label={proposal.name}>
                      <h4>{proposal.name}</h4>
                      <p>Review the exact proposed version before adding a separate shared copy.</p>
                      <button
                        type="button"
                        class="quiet-button"
                        disabled={busy()}
                        onClick={() =>
                          void mutate(async () => {
                            const revision = await apiRequest(
                              skillRevisionInput,
                              `/api/skills/revisions/${proposal.revisionId}${suffix()}`,
                            );
                            setInspected({ proposalId: proposal.id, revision });
                          }, "Proposed version opened")
                        }
                      >
                        Inspect proposed version
                      </button>
                      <Show when={inspected()?.proposalId === proposal.id}>
                        <Show when={inspected()?.revision}>
                          {(revision) => <SkillRevisionDetails revision={revision()} expanded />}
                        </Show>
                      </Show>
                      <button
                        type="button"
                        class="quiet-button"
                        disabled={busy() || inspected()?.proposalId !== proposal.id}
                        onClick={() =>
                          void mutate(async () => {
                            const result = await apiRequest(
                              z.object({ libraryId: z.uuid() }),
                              `/api/skills/share/${proposal.id}/accept`,
                              { method: "POST" },
                            );
                            setSelected(result.libraryId);
                            setInspected(undefined);
                          }, "Version added to the shared library. Enable it for new work.")
                        }
                      >
                        Add to shared library
                      </button>
                    </section>
                  )}
                </For>
              </section>
            </Show>
            <section class="skill-gallery" aria-label="Skill gallery">
              <For each={entries()}>
                {(entry) => {
                  const states = () =>
                    (["planning", "build"] as const)
                      .filter((item) => role() === "all" || item === role())
                      .map((item) => ({
                        role: item,
                        ...skillAvailability(entry, view()?.choices ?? [], scope(), item),
                      }))
                      .filter((item) => item.compatible);
                  const revision = () => states()[0]?.revision ?? entry.revisions[0];
                  return (
                    <article class="skill-gallery-card" aria-label={revision()?.content.name}>
                      <button
                        id={`skill-open-${entry.id}`}
                        type="button"
                        class="skill-tile"
                        aria-label={`Inspect ${revision()?.content.name}`}
                        aria-pressed={selected() === entry.id ? "true" : "false"}
                        onClick={() => openSkill(entry.id)}
                      >
                        <img
                          class="skill-cover"
                          src={skillCover(entry.id)}
                          width="384"
                          height="512"
                          alt=""
                          loading="lazy"
                          decoding="async"
                        />
                        <span class="skill-tile-caption">
                          <span class="skill-tile-title">{revision()?.content.name}</span>
                          <span class="skill-tile-description">
                            <Show when={revision()}>{(item) => skillSummary(item().content)}</Show>
                          </span>
                        </span>
                      </button>
                    </article>
                  );
                }}
              </For>
            </section>
            <Show when={view() && !entries().length}>
              <div class="skill-library-empty">
                <h3>No matching skills</h3>
                <p>
                  Try another search or clear the filters. You can also create or import a skill.
                </p>
                <button type="button" class="quiet-button" onClick={clearFilters}>
                  Clear filters
                </button>
              </div>
            </Show>
            <Show when={view()?.sharedVersions.length && !managing()}>
              <details class="skill-shared-history">
                <summary>Versions used in shared work</summary>
                <p>
                  Only these exact personal versions are visible. Other private versions stay
                  private.
                </p>
                <For each={view()?.sharedVersions}>
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
          <Show when={selectedEntry()}>
            {(entry) => (
              <Show when={view()}>
                {(library) => (
                  <SkillGalleryDetail
                    entry={entry()}
                    view={library()}
                    scope={scope()}
                    projectId={props.projectId}
                    projectName={props.projectName}
                    busy={busy()}
                    hasDraft={Boolean(editing())}
                    preferredRole={role()}
                    onChoose={choose}
                    onClose={closeSkill}
                    onEdit={edit}
                    onShare={share}
                    onCheckSource={checkSource}
                    onHeading={(element) => {
                      detailHeading = element;
                    }}
                  />
                )}
              </Show>
            )}
          </Show>
        </div>
      </div>
      <p role="status" class="skill-library-status">
        {busy() ? "Saving…" : loading() ? "Loading skills…" : status()}
      </p>
      <Show when={error()}>
        <div class="skill-library-error">
          <p role="alert">{error()}</p>
          <button
            type="button"
            class="quiet-button"
            disabled={busy() || loading()}
            onClick={() => {
              setError("");
              void load().catch(report);
            }}
          >
            Reload library
          </button>
        </div>
      </Show>
    </div>
  );
}
