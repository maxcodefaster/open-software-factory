import type { JSX } from "@solidjs/web";
import { createEffect, createSignal, Show, untrack } from "solid-js";
import type { MCPDefinition, MCPLibraryView } from "#conversation-domain/mcp-library";
import "../skills/library.css";
import "./library.css";
import { createMCPLibraryCommands } from "./library-commands";
import { MCPLibraryDetail } from "./library-detail";
import { MCPLibraryEditor } from "./library-editor";
import { MCPLibraryGallery, MCPLibraryHeader, MCPLibraryScopeContext } from "./library-gallery";
import { MCPLibraryFeedback, MCPMonitoringSetupBanner } from "./library-monitoring-banner";
import type { MCPEntry, MCPMonitoringSetup } from "./library-shared";
import * as state from "./library-state";
import { createMCPNavigation } from "./navigation";

export function MCPLibrary(props: {
  active?: boolean | undefined;
  navigation?: JSX.Element;
  projectId?: string | undefined;
  projectName?: string | undefined;
  monitoringSetup?: MCPMonitoringSetup | undefined;
  onMonitoringReturn?: ((connectionId?: string) => void) | undefined;
}) {
  const [view, setView] = createSignal<MCPLibraryView>();
  const navigation = createMCPNavigation(() => props.monitoringSetup?.id);
  const {
    query,
    setQuery,
    owner,
    setOwner,
    workType,
    setWorkType,
    filters,
    setFilters,
    scope,
    setScope,
    selected,
    setSelected,
    setEditor,
  } = navigation;
  const [draftState, setDraftState] = createSignal(state.initialMCPDraftState());
  const [activity, setActivity] = createSignal(state.initialMCPActivity());
  const [detail, setDetail] = createSignal(state.initialMCPDetailInteraction());

  const draft = () => state.activeMCPDraft(draftState());
  const editor = () => navigation.editor() && Boolean(draft());
  const busy = () => state.isMCPBusy(activity());
  const loading = () => state.isMCPLoading(activity());
  const activeFilters = () => state.activeMCPFilterCount(owner(), workType());
  const setupHere = () => state.isMonitoringSetupHere(props.monitoringSetup, props.projectId);
  const setupBlocked = () =>
    state.isMonitoringSetupBlocked(props.monitoringSetup, props.projectId, view());
  const draftForMonitoring = () =>
    state.isMCPDraftForMonitoring(draftState(), props.monitoringSetup);
  const entry = () => view()?.entries.find((item) => item.id === selected());
  const entries = () =>
    state.filterMCPEntries(view(), {
      query: query(),
      owner: owner(),
      workType: workType(),
      scope: scope(),
      monitoringSetup: Boolean(props.monitoringSetup),
    });

  let editorHeading: HTMLHeadingElement | undefined;
  let detailHeading: HTMLHeadingElement | undefined;
  let addButton: HTMLButtonElement | undefined;
  let gallery: HTMLDivElement | undefined;
  let actionMenu: HTMLDetailsElement | undefined;
  let filterRoot: HTMLDivElement | undefined;
  let filterButton: HTMLButtonElement | undefined;
  let setupHeading: HTMLHeadingElement | undefined;
  const filterID = `mcp-filters-${crypto.randomUUID()}`;
  let scroll = 0;

  const commands = createMCPLibraryCommands({
    projectId: () => props.projectId,
    monitoringSetup: () => Boolean(props.monitoringSetup),
    setupBlocked,
    draftForMonitoring,
    view,
    setView,
    scope,
    selected,
    entry,
    activity,
    updateActivity: setActivity,
    draftState,
    detailState: detail,
    setDraftState,
    updateDetailState: setDetail,
    setEditor,
    setSelected,
    setScope,
    onFocusDetail: () => requestAnimationFrame(() => detailHeading?.focus()),
  });

  function clearFilters() {
    setQuery("");
    setOwner("all");
    setWorkType("all");
  }
  function dismissFilters(event: KeyboardEvent) {
    if (event.key !== "Escape") return;
    event.preventDefault();
    event.stopPropagation();
    setFilters(false);
    filterButton?.focus();
  }

  createEffect(
    () => ({ active: props.active, projectId: props.projectId }),
    ({ active, projectId }) => {
      setActivity((prev) => ({ ...prev, readError: "" }));
      if (active !== false) void commands.load(projectId);
      return commands.invalidateLoads;
    },
  );
  createEffect(
    () => props.active,
    (active) => {
      if (active === false) return;
      const dismiss = (event: PointerEvent) => {
        if (!(event.target instanceof Node)) return;
        if (filters() && !filterRoot?.contains(event.target)) setFilters(false);
        if (actionMenu?.open && !actionMenu.contains(event.target)) actionMenu.open = false;
      };
      document.addEventListener("pointerdown", dismiss);
      return () => document.removeEventListener("pointerdown", dismiss);
    },
  );
  createEffect(
    () => props.monitoringSetup?.id,
    (id) => {
      setActivity((prev) => ({ ...prev, error: "", message: "" }));
      if (!id) {
        const currentAllowed = untrack(() => entry()?.connection?.allowedTools ?? []);
        setDetail((prev) => state.resetMCPDetailInteraction(prev, currentAllowed));
        return;
      }
      setDetail(state.resetMCPDetailOnMonitoringEnter);
      requestAnimationFrame(() => setupHeading?.focus({ preventScroll: true }));
    },
  );
  createEffect(
    () => ({
      active: props.active !== false && setupHere(),
      authorizing: entry()?.connection?.state === "authorizing",
      projectId: props.projectId,
    }),
    ({ active, authorizing, projectId }) => {
      if (!active || !authorizing) return;
      let refreshing = false;
      const timer = setInterval(() => {
        if (refreshing || busy() || loading() || document.visibilityState !== "visible") return;
        refreshing = true;
        void commands.load(projectId, true).finally(() => {
          refreshing = false;
        });
      }, 2_000);
      return () => clearInterval(timer);
    },
  );

  function open(item: MCPEntry) {
    scroll = gallery?.scrollTop ?? 0;
    setFilters(false);
    setSelected(item.id);
    setDetail((prev) => state.resetMCPDetailInteraction(prev, item.connection?.allowedTools ?? []));
    setActivity((prev) => ({ ...prev, error: "" }));
    requestAnimationFrame(() => detailHeading?.focus({ preventScroll: true }));
  }
  function close() {
    const id = selected();
    setSelected(undefined);
    setDetail((prev) => state.clearMCPAuthorization({ ...prev, token: "" }));
    requestAnimationFrame(() => {
      gallery?.scrollTo(0, scroll);
      document.getElementById(`mcp-open-${id}`)?.focus({ preventScroll: true });
    });
  }
  function edit(content?: MCPDefinition, item?: MCPEntry) {
    if (setupBlocked()) return;
    setDraftState((prev) =>
      state.openMCPDraft(prev, {
        content,
        item,
        monitoringSetup: Boolean(props.monitoringSetup),
        projectId: props.projectId,
        projectName: props.projectName,
      }),
    );
    setEditor(true);
    requestAnimationFrame(() => editorHeading?.focus());
  }

  return (
    <div
      class="skill-library mcp-library"
      data-detail={entry() ? "true" : "false"}
      data-monitoring={props.monitoringSetup ? "true" : undefined}
    >
      <MCPMonitoringSetupBanner
        setup={props.monitoringSetup}
        setupHere={setupHere()}
        hasView={Boolean(view())}
        canManageProject={Boolean(view()?.canManageProject)}
        busy={busy()}
        onHeadingRef={(element) => {
          setupHeading = element;
        }}
        onReturn={() => props.onMonitoringReturn?.()}
      />
      <MCPLibraryHeader
        hidden={Boolean(entry()) || editor()}
        monitoringSetup={Boolean(props.monitoringSetup)}
        navigation={props.navigation}
        hasView={Boolean(view())}
        entryCount={entries().length}
        canManageProject={Boolean(view()?.canManageProject)}
        canManageSystem={Boolean(view()?.canManageSystem)}
        scope={scope()}
        busy={busy()}
        setupBlocked={setupBlocked()}
        hasDraft={Boolean(draft())}
        query={query()}
        owner={owner()}
        workType={workType()}
        filtersOpen={filters()}
        activeFilters={activeFilters()}
        filterID={filterID}
        onActionMenuRef={(element) => {
          actionMenu = element;
        }}
        onAddButtonRef={(element) => {
          addButton = element;
        }}
        onFilterRootRef={(element) => {
          filterRoot = element;
        }}
        onFilterButtonRef={(element) => {
          filterButton = element;
        }}
        onToggleManage={() => {
          if (actionMenu) actionMenu.open = false;
          setScope(
            scope() === "personal" ? (view()?.canManageProject ? "project" : "system") : "personal",
          );
          setSelected(undefined);
        }}
        onAdd={() => edit()}
        onQueryInput={setQuery}
        onOwnerChange={setOwner}
        onWorkTypeChange={setWorkType}
        onToggleFilters={() => {
          if (actionMenu) actionMenu.open = false;
          setFilters((open) => !open);
        }}
        onDismissFilters={dismissFilters}
        onClearFilters={() => {
          clearFilters();
          filterButton?.focus();
        }}
      />
      <MCPLibraryFeedback
        readError={activity().readError}
        error={activity().error}
        statusText={state.mcpStatusText(activity())}
        disabled={loading() || busy()}
        onRetry={() => void commands.load(props.projectId)}
      />
      <MCPLibraryEditor
        open={editor()}
        draft={draft()}
        monitoringSetup={Boolean(props.monitoringSetup)}
        draftForMonitoring={draftForMonitoring()}
        projectId={props.projectId}
        canManageProject={Boolean(view()?.canManageProject)}
        canManageSystem={Boolean(view()?.canManageSystem)}
        busy={busy()}
        setupBlocked={setupBlocked()}
        onBack={() => {
          setEditor(false);
          requestAnimationFrame(() => addButton?.focus());
        }}
        onHeadingRef={(element) => {
          editorHeading = element;
        }}
        onUpdateContent={(value) =>
          setDraftState((prev) => state.patchMCPDraftContent(prev, value))
        }
        onChangeScope={(nextScope) =>
          setDraftState((prev) => state.patchMCPDraftScope(prev, nextScope))
        }
        onSubmit={commands.saveDraft}
        onDiscard={() => {
          setDraftState(state.initialMCPDraftState());
          setEditor(false);
          setActivity((prev) => ({ ...prev, error: "" }));
        }}
      />
      <div class="skill-library-browser" hidden={editor()}>
        <Show when={!props.monitoringSetup && !entry() && scope() !== "personal"}>
          <MCPLibraryScopeContext
            scope={scope()}
            projectName={props.projectName}
            canManageProject={Boolean(view()?.canManageProject)}
            canManageSystem={Boolean(view()?.canManageSystem)}
            onChangeScope={setScope}
          />
        </Show>
        <div class="skill-library-layout">
          <MCPLibraryGallery
            hidden={Boolean(entry())}
            monitoringSetup={Boolean(props.monitoringSetup)}
            scope={scope()}
            hasView={Boolean(view())}
            proposals={view()?.proposals ?? []}
            entries={entries()}
            hasActiveSearchOrFilters={Boolean(query() || owner() !== "all" || workType() !== "all")}
            busy={busy()}
            setupBlocked={setupBlocked()}
            hasDraft={Boolean(draft())}
            onGalleryRef={(element) => {
              gallery = element;
            }}
            onAcceptProposal={commands.acceptProposal}
            onOpenEntry={open}
            onClearFilters={clearFilters}
            onSelectRecommendation={(suggestion) => edit(suggestion)}
          />
          <Show when={entry()}>
            {(item) => (
              <MCPLibraryDetail
                item={item()}
                scope={scope()}
                choices={view()?.choices ?? []}
                projectId={props.projectId}
                projectName={props.projectName}
                monitoringSetup={Boolean(props.monitoringSetup)}
                busy={busy()}
                setupBlocked={setupBlocked()}
                hasDraft={Boolean(draft())}
                token={detail().token}
                allowed={detail().allowed}
                confirmed={detail().confirmed}
                authorization={state.mcpAuthorizationUrl(detail())}
                shareTarget={detail().shareTarget}
                onHeadingRef={(element) => {
                  detailHeading = element;
                }}
                onClose={close}
                onEdit={edit}
                onSaveCover={commands.saveCover}
                onTokenInput={(token) => setDetail((prev) => ({ ...prev, token }))}
                onConnect={() => void commands.connect()}
                onDisconnect={commands.disconnect}
                onRefreshStatus={commands.refreshStatus}
                onToggleTool={(toolName, checked) =>
                  setDetail((prev) => state.toggleMCPToolSelection(prev, toolName, checked))
                }
                onConfirmedChange={(confirmed) => setDetail((prev) => ({ ...prev, confirmed }))}
                onApproveTools={commands.approveTools}
                onToggleProjectGrant={commands.toggleProjectGrant}
                onUseForInput={(connectionId) => props.onMonitoringReturn?.(connectionId)}
                onChoose={(targetItem, role, nextState) =>
                  void commands.choose(targetItem, role, nextState)
                }
                onShareTargetChange={(shareTarget) =>
                  setDetail((prev) => ({ ...prev, shareTarget }))
                }
                onProposeShare={commands.proposeShare}
              />
            )}
          </Show>
        </div>
      </div>
    </div>
  );
}
