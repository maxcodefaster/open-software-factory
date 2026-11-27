import type { JSX } from "@solidjs/web";
import { createEffect, createSignal, Show } from "solid-js";
import type {
  SkillLibraryEntry,
  SkillLibraryView,
  SkillScope,
} from "#conversation-domain/skill-library";
import { plainErrorMessage } from "../command-error";
import { serverCall } from "../server-functions/result";
import { getSkillLibrary } from "../server-functions/skills";
import { SkillGalleryDetail } from "./gallery-detail";
import type { SkillFilters } from "./gallery-state";
import { createSkillLibraryCommands } from "./library-commands";
import { SkillLibraryGallery, SkillManageContextBar } from "./library-gallery";
import { SkillLibraryHeader } from "./library-header";
import * as state from "./library-state";
import { SkillLibraryFeedback, SkillLibraryWorkflowScreens } from "./library-workflow";
import "./library.css";

export function SkillLibrary(props: {
  projectId?: string | undefined;
  projectName?: string | undefined;
  active?: boolean | undefined;
  navigation?: JSX.Element;
}) {
  const [view, setView] = createSignal<SkillLibraryView>();
  const [filters, setFilters] = createSignal<SkillFilters>(state.initialSkillFilters());
  const [filtersOpen, setFiltersOpen] = createSignal(false);
  const [mode, setMode] = createSignal(state.initialSkillViewMode());
  const [surface, setSurface] = createSignal(state.initialSkillSurface());
  const [activity, setActivity] = createSignal(state.initialSkillActivity());

  const managing = () => mode().kind === "manage";
  const inspected = () => {
    const current = mode();
    return current.kind === "manage" ? current.inspected : undefined;
  };
  const canManage = () => state.canManageSkills(view());
  const managementScope = () => state.resolveManagementScope(view(), props.projectId, mode());
  const scope = () => state.resolveSkillScope(view(), props.projectId, mode());
  const draft = () => state.activeSkillDraft(surface());
  const busy = () => state.skillActivityBusy(activity());
  const loading = () => state.skillActivityLoading(activity());
  const selectedEntry = () => view()?.entries.find((entry) => entry.id === surface().selectedId);
  const entries = () => state.visibleSkillEntries(view(), mode(), scope(), filters());
  const proposals = () => state.visibleSkillProposals(view(), scope());

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
    setActivity((current) => ({ ...current, status: "", error: "" }));
  }
  function focusWorkflow(selector: string) {
    requestAnimationFrame(() => {
      const heading = libraryRoot?.querySelector<HTMLHeadingElement>(selector);
      heading?.closest(".skill-editor-screen")?.scrollTo(0, 0);
      heading?.focus({ preventScroll: true });
    });
  }
  const report = (cause: unknown) => {
    const message =
      cause instanceof Error
        ? plainErrorMessage(cause.message)
        : "Could not load library. Try reloading.";
    setActivity((current) => ({ ...current, error: message }));
  };

  async function load(projectId: string | undefined) {
    const request = ++sequence;
    setActivity(state.beginSkillLoad);
    try {
      const next = await serverCall(
        projectId ? getSkillLibrary({ data: [projectId] }) : getSkillLibrary({ data: [] }),
      );
      if (request !== sequence) return;
      setView(next);
      if (!next.canManageProject && !next.canManageSystem) setMode(state.exitSkillManageMode);
      return next;
    } finally {
      if (request === sequence) setActivity(state.finishSkillLoad);
    }
  }

  async function mutate(action: () => Promise<unknown>, message: string) {
    if (busy()) return false;
    setActivity({ kind: "saving", refreshing: false, status: "", error: "" });
    try {
      const result = await action();
      const nextStatus = typeof result === "string" ? result : message;
      setActivity((current) => ({ ...current, status: nextStatus }));
      try {
        await load(props.projectId);
      } catch {
        setActivity((current) => ({
          ...current,
          error: "The action completed, but the library could not refresh. Reload to see it.",
        }));
      }
      return true;
    } catch (cause) {
      report(cause);
      return false;
    } finally {
      setActivity(state.finishSkillMutation);
    }
  }

  const commands = createSkillLibraryCommands({
    projectId: () => props.projectId,
    view,
    hasDraft: () => Boolean(draft()),
    mutate,
    onOpenSourceUpdate: setSurface,
    onFocusEditor: () => focusWorkflow(".skill-editor h3"),
    onInspected: (next) => setMode((current) => state.setInspectedSkillProposal(current, next)),
    onAccepted: (libraryId) => setSurface((current) => state.selectSkillEntry(current, libraryId)),
  });

  createEffect(
    () => ({ projectId: props.projectId, active: props.active }),
    ({ projectId, active }) => {
      if (active !== false) void load(projectId).catch(report);
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

  function closeActions() {
    if (actionMenu) actionMenu.open = false;
  }
  function openSkill(id: string) {
    savedScroll = galleryScroll?.scrollTop ?? 0;
    closeActions();
    setFiltersOpen(false);
    setSurface((current) => state.selectSkillEntry(current, id));
    requestAnimationFrame(() => {
      detailHeading?.closest(".skill-gallery-detail")?.scrollTo(0, 0);
      detailHeading?.focus({ preventScroll: true });
    });
  }
  function closeSkill() {
    const id = surface().selectedId;
    setSurface((current) => state.selectSkillEntry(current, undefined));
    requestAnimationFrame(() => {
      if (galleryScroll) galleryScroll.scrollTop = savedScroll;
      const target =
        document.getElementById(`skill-open-${id}`) ??
        document.querySelector<HTMLInputElement>(".skill-search input");
      target?.focus({ preventScroll: true });
    });
  }
  function edit(entry?: SkillLibraryEntry) {
    clearFeedback();
    setSurface((current) => state.openSkillEditor(current, entry));
    focusWorkflow(".skill-editor h3");
  }
  function returnFromEditor() {
    requestAnimationFrame(() =>
      selectedEntry() ? detailHeading?.focus({ preventScroll: true }) : newButton?.focus(),
    );
  }
  function handleSaved(saved: { libraryId: string; revisionId: string; scope: SkillScope }) {
    setSurface({ kind: "browser", selectedId: saved.libraryId });
    if (saved.scope === "personal") setMode(state.exitSkillManageMode);
    else if (managing())
      setMode((current) =>
        state.setSkillManageTarget(current, saved.scope as "project" | "system"),
      );
    void mutate(async () => saved, "Skill saved. Choose where to enable it.").then(() => {
      if (selectedEntry()?.id === saved.libraryId) {
        requestAnimationFrame(() => {
          detailHeading?.closest(".skill-gallery-detail")?.scrollTo(0, 0);
          detailHeading?.focus({ preventScroll: true });
        });
      }
    });
  }

  return (
    <div
      class="skill-library"
      data-detail={selectedEntry() ? "true" : "false"}
      ref={(element) => {
        libraryRoot = element;
      }}
    >
      <SkillLibraryHeader
        hidden={Boolean(selectedEntry()) && surface().kind === "browser"}
        browsing={surface().kind === "browser"}
        editorOpen={surface().kind === "editor"}
        importing={surface().kind === "import"}
        hasView={Boolean(view())}
        entryCount={entries().length}
        navigation={props.navigation}
        busy={busy()}
        hasDraft={Boolean(draft())}
        canManage={canManage()}
        managing={managing()}
        filters={filters()}
        filtersOpen={filtersOpen()}
        filterID={filterID}
        onActionMenuRef={(element) => {
          actionMenu = element;
        }}
        onActionTriggerRef={(element) => {
          actionTrigger = element;
        }}
        onNewButtonRef={(element) => {
          newButton = element;
        }}
        onFilterRootRef={(element) => {
          filterRoot = element;
        }}
        onFilterButtonRef={(element) => {
          filterButton = element;
        }}
        onCloseActions={closeActions}
        onOpenImport={() => {
          closeActions();
          clearFeedback();
          setSurface(state.openSkillImport);
          focusWorkflow(".skill-import-panel h3");
        }}
        onEnterManage={() => {
          closeActions();
          setMode(state.enterSkillManageMode);
          setFilters((current) => ({ ...current, owner: "all" }));
          setSurface((current) => state.selectSkillEntry(current, undefined));
          void load(props.projectId).catch(report);
        }}
        onAddSkill={() => edit()}
        onUpdateFilters={(patch) => setFilters((current) => ({ ...current, ...patch }))}
        onToggleFilters={() => {
          closeActions();
          setFiltersOpen((open) => !open);
        }}
        onDismissFilters={() => {
          setFiltersOpen(false);
          filterButton?.focus();
        }}
      />
      <SkillLibraryWorkflowScreens
        editorOpen={surface().kind === "editor"}
        importing={surface().kind === "import"}
        draft={draft()}
        projectId={props.projectId}
        canManageProject={view()?.canManageProject ?? false}
        canManageSystem={view()?.canManageSystem ?? false}
        onCancelEditor={() => {
          setSurface(state.closeSkillEditor);
          returnFromEditor();
        }}
        onDiscardDraft={() => {
          setSurface(state.discardSkillDraft);
          returnFromEditor();
        }}
        onSaved={handleSaved}
        onCancelImport={() => {
          setSurface(state.closeSkillImport);
          requestAnimationFrame(() => actionTrigger?.focus({ preventScroll: true }));
        }}
        onImportPreview={(preview) => {
          clearFeedback();
          setSurface((current) => state.applySkillImportPreview(current, preview));
          focusWorkflow(".skill-editor h3");
        }}
      />
      <div class="skill-library-browser" hidden={surface().kind !== "browser"}>
        <Show when={managing() && !selectedEntry()}>
          <SkillManageContextBar
            managing={managing()}
            managementScope={managementScope()}
            canManageProject={Boolean(view()?.canManageProject)}
            canManageSystem={Boolean(view()?.canManageSystem)}
            projectId={props.projectId}
            projectName={props.projectName}
            onExitManage={() => {
              setMode(state.exitSkillManageMode);
              setSurface((current) => state.selectSkillEntry(current, undefined));
            }}
            onChangeTarget={(target) => {
              setMode((current) => state.setSkillManageTarget(current, target));
              setFilters((current) => ({ ...current, owner: "all" }));
              setSurface((current) => state.selectSkillEntry(current, undefined));
            }}
          />
        </Show>
        <div class="skill-library-layout">
          <SkillLibraryGallery
            hidden={Boolean(selectedEntry())}
            managing={managing()}
            view={view()}
            entries={entries()}
            proposals={proposals()}
            scope={scope()}
            roleFilter={filters().role}
            selectedId={surface().selectedId}
            inspected={inspected()}
            busy={busy()}
            onGalleryRef={(element) => {
              galleryScroll = element;
            }}
            onInspectProposal={commands.inspectProposal}
            onAcceptProposal={commands.acceptProposal}
            onOpenSkill={openSkill}
            onClearFilters={() => setFilters(state.initialSkillFilters())}
          />
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
                    hasDraft={Boolean(draft())}
                    preferredRole={filters().role}
                    onChoose={commands.choose}
                    onClose={closeSkill}
                    onEdit={edit}
                    onShare={commands.share}
                    onCheckSource={commands.checkSource}
                    onCover={(key, expectedVersion) =>
                      commands.saveCover(entry().id, key, expectedVersion)
                    }
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
      <SkillLibraryFeedback
        statusText={state.skillActivityStatusText(activity())}
        error={activity().error}
        disabled={busy() || loading()}
        onReload={() => {
          setActivity((current) => ({ ...current, error: "" }));
          void load(props.projectId).catch(report);
        }}
      />
    </div>
  );
}
