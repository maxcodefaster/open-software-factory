import type { JSX } from "@solidjs/web";
import { children, createEffect, createSignal, For, Show, untrack } from "solid-js";
import type { EnvironmentSettingsView, ProjectEnvironment } from "#project-domain/environment";
import {
  EnvironmentActionsMenu,
  type EnvironmentActionsMenuHandle,
  EnvironmentFilterToolbar,
  EnvironmentHeader,
  EnvironmentSaveBar,
  EnvironmentStatusNotices,
} from "./controls";
import { EnvironmentImportPanel } from "./import-panel";
import {
  runDiscardEnvironmentSave,
  runLoadEnvironment,
  runSaveEnvironment,
} from "./settings-actions";
import {
  type ActionMenuState,
  defaultVariableFilters,
  type EnvImportState,
  type EnvironmentPhase,
  type EnvironmentVariable,
  environmentError,
  environmentNotice,
  filterAndSortVariables,
  isEnvironmentBusy,
  isEnvironmentDirty,
  isVariableChanged,
  mergeImportedVariables,
  pendingEnvironmentRetry,
  previewEnvironmentImport,
  type VariableEditorState,
  type VariableFilters,
} from "./settings-state";
import { EnvironmentVariableList } from "./variable-row";
import "./settings.css";

type EnvironmentSettingsProps = { projectID: string; navigation?: JSX.Element };

export function EnvironmentSettings(props: EnvironmentSettingsProps) {
  const [environment, setEnvironment] = createSignal<ProjectEnvironment>("development");
  const [sort, setSort] = createSignal("name-asc");
  return (
    <For
      each={[{ projectID: props.projectID, environment: environment() }]}
      keyed={(scope) => `${scope.projectID}:${scope.environment}`}
    >
      {(scope) => (
        <EnvironmentDocument
          projectID={scope().projectID}
          environment={scope().environment}
          navigation={props.navigation}
          onEnvironmentChange={setEnvironment}
          sort={sort()}
          onSortChange={setSort}
        />
      )}
    </For>
  );
}

function EnvironmentDocument(
  props: EnvironmentSettingsProps & {
    environment: ProjectEnvironment;
    onEnvironmentChange(scope: ProjectEnvironment): void;
    sort: string;
    onSortChange(value: string): void;
  },
) {
  const navigation = children(() => props.navigation);
  const environment = () => props.environment;
  const [view, setView] = createSignal<EnvironmentSettingsView>();
  const [variables, setVariables] = createSignal<EnvironmentVariable[]>([]);
  const [phase, setPhase] = createSignal<EnvironmentPhase>({ kind: "loading" });
  const [retryingLoadError, setRetryingLoadError] = createSignal("");
  const [importState, setImportState] = createSignal<EnvImportState>({ kind: "closed" });
  const [filters, setFilters] = createSignal<VariableFilters>(defaultVariableFilters());
  const [editor, setEditor] = createSignal<VariableEditorState>({ kind: "idle" });
  const [menuState, setMenuState] = createSignal<ActionMenuState>({
    open: false,
    index: undefined,
  });
  const importID = `environment-import-${crypto.randomUUID()}`;
  const variableAccessID = `environment-access-${crypto.randomUUID()}`;
  const filtersID = `environment-filters-${crypto.randomUUID()}`;
  let menuHandle: EnvironmentActionsMenuHandle | undefined;
  let addButton: HTMLButtonElement | undefined;
  let importButton: HTMLButtonElement | undefined;
  let generation = 0;

  const busy = () => isEnvironmentBusy(phase());
  const saving = () => phase().kind === "saving";
  const retry = () => pendingEnvironmentRetry(phase());
  const unconfirmed = () => !saving() && (Boolean(retry()) || Boolean(view()?.pending));
  const error = () => environmentError(phase()) || retryingLoadError();
  const notice = () => environmentNotice(phase());
  const editable = () =>
    view()?.canManage === true &&
    view()?.storeConfigured === true &&
    !busy() &&
    (!view()?.pending || Boolean(retry()));
  const canEditDraft = () => editable() && !retry();
  const dirty = () => isEnvironmentDirty(variables(), view());
  const visibleVariables = () =>
    filterAndSortVariables(variables(), view(), filters(), props.sort, editor());

  function setDraftNotice(message: string, clearRetry = false) {
    setPhase((current) =>
      current.kind === "ready"
        ? {
            ...current,
            pendingRetry: clearRetry ? undefined : current.pendingRetry,
            notice: message,
          }
        : current,
    );
  }
  function clearFilters() {
    setFilters((current) => defaultVariableFilters(current.open));
  }
  function editVariable(index: number) {
    const variable = variables()[index];
    if (!canEditDraft() || !variable) return;
    setEditor({
      kind: "editing",
      index,
      sortAnchor: { name: variable.name, changed: isVariableChanged(variable, view()) },
    });
  }
  function addVariable() {
    if (!canEditDraft()) return;
    clearFilters();
    const index = variables().length;
    setEditor({ kind: "editing", index, sortAnchor: { name: "", changed: true } });
    setVariables((items) => [
      ...items,
      { name: "", value: "", runtime: true, verification: false },
    ]);
    setDraftNotice("");
  }
  function removeVariable(index: number) {
    if (!canEditDraft()) return;
    menuHandle?.close();
    setEditor({ kind: "idle" });
    setVariables((items) => items.filter((_, position) => position !== index));
    setDraftNotice("Variable removed from draft. Save environment to apply.");
    addButton?.focus({ preventScroll: true });
  }
  function changeVariable(index: number, patch: Partial<EnvironmentVariable>) {
    if (retry()) return;
    setVariables((items) =>
      items.map((item, position) => (position === index ? { ...item, ...patch } : item)),
    );
    setDraftNotice("");
  }
  function publish(value: EnvironmentSettingsView) {
    menuHandle?.close();
    setEditor({ kind: "idle" });
    setView(value);
    setVariables(value.variables.map((item) => ({ ...item })));
  }
  async function load(projectID = props.projectID, scope = environment()) {
    const epoch = generation;
    const current = untrack(phase);
    setRetryingLoadError(current.kind === "load-error" ? current.message : "");
    setPhase({ kind: "loading" });
    const outcome = await runLoadEnvironment(projectID, scope);
    if (epoch !== generation) return;
    setRetryingLoadError("");
    if (outcome.ok) publish(outcome.value);
    setPhase(outcome.phase);
  }
  async function discardPending() {
    const currentRetry = retry();
    const commandID = view()?.pendingCommandID ?? currentRetry?.commandID;
    if (!commandID || !view()?.canManage || busy()) return;
    const epoch = generation;
    setPhase({ kind: "discarding", pendingRetry: currentRetry });
    const outcome = await runDiscardEnvironmentSave(
      props.projectID,
      environment(),
      commandID,
      currentRetry,
    );
    if (epoch !== generation) return;
    if (outcome.ok) publish(outcome.value);
    setPhase(outcome.phase);
  }
  async function save(event: SubmitEvent) {
    event.preventDefault();
    const current = view();
    const currentRetry = retry();
    if (!editable() || !current || (!dirty() && !currentRetry)) return;
    const epoch = generation;
    const input = currentRetry ?? {
      commandID: crypto.randomUUID(),
      version: current.version,
      variables: variables(),
    };
    setPhase({ kind: "saving", retry: input });
    const outcome = await runSaveEnvironment(props.projectID, environment(), input);
    if (epoch !== generation) return;
    if (outcome.ok) publish(outcome.value);
    else if (outcome.latest) setView(outcome.latest);
    setPhase(outcome.phase);
  }
  function closeImport() {
    setImportState({ kind: "closed" });
    importButton?.focus({ preventScroll: true });
  }
  function applyImport(entries: Array<{ name: string; value: string }>) {
    setVariables((items) => mergeImportedVariables(items, entries));
    closeImport();
    clearFilters();
    setDraftNotice("Variables added to draft. Save environment to apply.", true);
  }
  createEffect(
    () => [props.projectID, environment()] as const,
    ([projectID, scope]) => {
      ++generation;
      setView(undefined);
      setVariables([]);
      setRetryingLoadError("");
      setImportState({ kind: "closed" });
      setFilters(defaultVariableFilters(false));
      setEditor({ kind: "idle" });
      menuHandle?.close();
      void load(projectID, scope);
      return () => {
        generation += 1;
      };
    },
  );
  return (
    <section class="environment-settings model-settings-body" aria-label="Project environment">
      <EnvironmentHeader
        navigation={navigation()}
        environment={environment()}
        canManage={Boolean(view()?.canManage)}
        canEditDraft={canEditDraft()}
        busy={busy()}
        importID={importID}
        importOpen={importState().kind === "open"}
        importButtonRef={(button) => {
          importButton = button;
        }}
        addButtonRef={(button) => {
          addButton = button;
        }}
        onOpenImport={() =>
          setImportState({ kind: "open", text: "", shown: false, result: { kind: "idle" } })
        }
        onAddVariable={addVariable}
        onEnvironmentChange={props.onEnvironmentChange}
      />
      <Show
        when={view()}
        fallback={
          <>
            <p role="status">{busy() ? "Loading environment…" : "Environment unavailable."}</p>
            <Show when={error()}>
              <button
                type="button"
                class="quiet-button"
                disabled={busy()}
                onClick={() => void load()}
              >
                Retry loading
              </button>
            </Show>
          </>
        }
      >
        {(current) => (
          <>
            <EnvironmentStatusNotices
              current={saving() ? { ...current(), pending: false } : current()}
              hasRetry={Boolean(retry()) && !saving()}
              busy={busy()}
              onDiscardPending={() => void discardPending()}
            />
            <EnvironmentFilterToolbar
              filtersID={filtersID}
              filters={filters()}
              sort={props.sort}
              onFiltersChange={setFilters}
              onSortChange={props.onSortChange}
            />
            <form onSubmit={(event) => void save(event)}>
              <Show
                when={
                  current().canManage && importState().kind === "open"
                    ? (importState() as Extract<EnvImportState, { kind: "open" }>)
                    : undefined
                }
              >
                {(openImport) => (
                  <EnvironmentImportPanel
                    id={importID}
                    state={openImport()}
                    canEditDraft={canEditDraft()}
                    onTextChange={(text) =>
                      setImportState((s) =>
                        s.kind === "open" ? { ...s, text, result: { kind: "idle" } } : s,
                      )
                    }
                    onShownChange={(shown) =>
                      setImportState((s) => (s.kind === "open" ? { ...s, shown } : s))
                    }
                    onPreview={() => setImportState(previewEnvironmentImport)}
                    onApply={applyImport}
                    onClose={closeImport}
                  />
                )}
              </Show>
              <EnvironmentVariableList
                environment={environment()}
                current={current()}
                totalCount={variables().length}
                visibleVariables={visibleVariables()}
                editor={editor()}
                menuState={menuState()}
                canEditDraft={canEditDraft()}
                variableAccessID={variableAccessID}
                onOpenMenu={(index, button) => {
                  setMenuState((m) => ({ ...m, index }));
                  menuHandle?.open(button);
                }}
                onChangeVariable={changeVariable}
                onDoneEditing={() => {
                  setEditor({ kind: "idle" });
                  addButton?.focus({ preventScroll: true });
                }}
                onClearFilters={clearFilters}
              />
              <EnvironmentSaveBar
                visible={current().canManage && (dirty() || Boolean(retry()) || current().pending)}
                unconfirmed={unconfirmed()}
                editable={editable()}
                busy={busy()}
                hasRetry={Boolean(retry()) && !saving()}
              />
            </form>
          </>
        )}
      </Show>
      <Show when={error()}>
        <p role="alert" class="model-settings-error">
          {error()}
        </p>
      </Show>
      <Show when={notice()}>
        <p role="status">{notice()}</p>
      </Show>
      <EnvironmentActionsMenu
        open={menuState().open}
        canEditDraft={canEditDraft()}
        ref={(handle) => {
          menuHandle = handle;
        }}
        onToggle={(open) => setMenuState((m) => ({ ...m, open }))}
        onEdit={() => {
          const index = menuState().index;
          if (index !== undefined) editVariable(index);
        }}
        onRemove={() => {
          const index = menuState().index;
          if (index !== undefined) removeVariable(index);
        }}
      />
    </section>
  );
}
