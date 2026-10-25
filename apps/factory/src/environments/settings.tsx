import type { JSX } from "@solidjs/web";
import { children, createEffect, createSignal, For, Show } from "solid-js";
import {
  type EnvironmentSettingsView,
  type EnvironmentWrite,
  type ProjectEnvironment,
  parseEnvironmentPaste,
} from "../../../../packages/project-domain/src/environment";
import { Icon } from "../icon";
import { bindPopoverKeyboard } from "../popover-keyboard";
import {
  discardEnvironmentSave,
  getEnvironment,
  saveEnvironment,
} from "../server-functions/environments";
import { serverCall } from "../server-functions/result";
import { WorkspaceActionBar } from "../ui/workspace-actions";
import "./settings.css";

const grants = ["runtime", "build", "verification"] as const;
const grantLabels = { runtime: "Runtime", build: "Image build", verification: "Verification" };

export function EnvironmentSettings(props: { projectID: string; navigation?: JSX.Element }) {
  const navigation = children(() => props.navigation);
  const [environment, setEnvironment] = createSignal<ProjectEnvironment>("development");
  const [view, setView] = createSignal<EnvironmentSettingsView>();
  const [variables, setVariables] = createSignal<EnvironmentWrite["variables"]>([]);
  const [registries, setRegistries] = createSignal<EnvironmentWrite["registries"]>([]);
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal("");
  const [notice, setNotice] = createSignal("");
  const [paste, setPaste] = createSignal("");
  const [preview, setPreview] = createSignal<Array<{ name: string; value: string }>>([]);
  const [pasteError, setPasteError] = createSignal("");
  const [importOpen, setImportOpen] = createSignal(false);
  const importID = `environment-import-${crypto.randomUUID()}`;
  const variableAccessID = `environment-access-${crypto.randomUUID()}`;
  const [editingRegistry, setEditingRegistry] = createSignal<number>();
  const [search, setSearch] = createSignal("");
  const [usage, setUsage] = createSignal("all");
  const [state, setState] = createSignal("all");
  const [sort, setSort] = createSignal("name-asc");
  const [filtersOpen, setFiltersOpen] = createSignal(false);
  const filtersID = `environment-filters-${crypto.randomUUID()}`;
  const activeOptions = () =>
    [usage() !== "all", state() !== "all", sort() !== "name-asc"].filter(Boolean).length;
  const [editing, setEditing] = createSignal<number>();
  const [editingSort, setEditingSort] = createSignal({ name: "", changed: false });
  const [actions, setActions] = createSignal<number>();
  const [menuOpen, setMenuOpen] = createSignal(false);
  let menu!: HTMLDivElement;
  let opener: HTMLButtonElement | undefined;
  let addButton: HTMLButtonElement | undefined;
  let importButton: HTMLButtonElement | undefined;
  let addRegistryButton: HTMLButtonElement | undefined;
  let generation = 0;
  let retry: EnvironmentWrite | undefined;
  const editable = () =>
    view()?.canManage === true &&
    view()?.storeConfigured === true &&
    !busy() &&
    (!view()?.pending || Boolean(retry));
  const canEditDraft = () => editable() && !retry;
  const changed = (variable: EnvironmentWrite["variables"][number]) => {
    const saved = view()?.variables.find((item) => item.name === variable.name);
    return (
      !saved ||
      variable.value !== undefined ||
      grants.some((grant) => saved[grant] !== variable[grant])
    );
  };
  const dirty = () => {
    const saved = view();
    return Boolean(
      saved &&
        (variables().length !== saved.variables.length ||
          variables().some(changed) ||
          registries().length !== saved.registries.length ||
          registries().some((registry) => {
            const original = saved.registries.find((item) => item.host === registry.host);
            return (
              !original ||
              registry.password !== undefined ||
              registry.certificate !== undefined ||
              registry.username !== original.username ||
              registry.verification !== original.verification
            );
          })),
    );
  };
  const visibleVariables = () =>
    variables()
      .map((variable, index) => ({ variable, index }))
      .filter(
        ({ variable, index }) =>
          editing() === index ||
          (variable.name.toLowerCase().includes(search().trim().toLowerCase()) &&
            (usage() === "all" || variable[usage() as (typeof grants)[number]]) &&
            (state() === "all" || (state() === "draft" ? changed(variable) : !changed(variable)))),
      )
      .sort((left, right) => {
        // Keep the active editor in place while its name or value changes.
        const a =
          editing() === left.index
            ? editingSort()
            : { name: left.variable.name, changed: changed(left.variable) };
        const b =
          editing() === right.index
            ? editingSort()
            : { name: right.variable.name, changed: changed(right.variable) };
        if (sort() === "draft-first" && a.changed !== b.changed) return a.changed ? -1 : 1;
        const names = a.name.localeCompare(b.name);
        return sort() === "name-desc" ? -names : names;
      });
  function editVariable(index: number) {
    const variable = variables()[index];
    if (!canEditDraft() || !variable) return;
    setEditingSort({ name: variable.name, changed: changed(variable) });
    setEditing(index);
  }
  function clearFilters() {
    setSearch("");
    setUsage("all");
    setState("all");
  }
  function addVariable() {
    if (!canEditDraft()) return;
    clearFilters();
    const index = variables().length;
    setEditingSort({ name: "", changed: true });
    setEditing(index);
    setVariables((items) => [
      ...items,
      { name: "", value: "", runtime: true, build: false, verification: false },
    ]);
    setNotice("");
  }
  function removeVariable(index: number) {
    if (!canEditDraft()) return;
    menu.hidePopover();
    setEditing(undefined);
    setVariables((items) => items.filter((_, position) => position !== index));
    setNotice("Variable removed from draft. Save environment to apply.");
    addButton?.focus({ preventScroll: true });
  }
  function positionMenu() {
    if (!opener) return;
    const anchor = opener.getBoundingClientRect();
    const gap = 8;
    const width = menu.offsetWidth;
    const height = menu.offsetHeight;
    Object.assign(menu.style, {
      left: `${Math.max(gap, Math.min(anchor.right - width, innerWidth - width - gap))}px`,
      top: `${Math.max(gap, anchor.bottom + height + gap > innerHeight ? anchor.top - height - gap : anchor.bottom + gap)}px`,
    });
  }
  createEffect(menuOpen, (open) => {
    if (!open) return;
    positionMenu();
    const dispose = bindPopoverKeyboard(menu, opener, () => menu.hidePopover());
    window.addEventListener("resize", positionMenu);
    window.addEventListener("scroll", positionMenu, true);
    return () => {
      dispose();
      window.removeEventListener("resize", positionMenu);
      window.removeEventListener("scroll", positionMenu, true);
    };
  });
  function publish(value: EnvironmentSettingsView) {
    menu?.hidePopover();
    setEditing(undefined);
    setEditingRegistry(undefined);
    setView(value);
    setVariables(value.variables.map((item) => ({ ...item })));
    setRegistries(
      value.registries.map(
        ({ hasPassword: _password, hasCertificate: _certificate, ...item }) => item,
      ),
    );
  }
  function changeVariable(index: number, patch: Partial<EnvironmentWrite["variables"][number]>) {
    if (retry) return;
    retry = undefined;
    setVariables((items) =>
      items.map((item, position) => (position === index ? { ...item, ...patch } : item)),
    );
    setNotice("");
  }
  function changeRegistry(index: number, patch: Partial<EnvironmentWrite["registries"][number]>) {
    if (retry) return;
    retry = undefined;
    setRegistries((items) =>
      items.map((item, position) => (position === index ? { ...item, ...patch } : item)),
    );
    setNotice("");
  }
  async function discardPending() {
    const commandID = view()?.pendingCommandID ?? retry?.commandID;
    if (!commandID || !view()?.canManage || busy()) return;
    const epoch = generation;
    setBusy(true);
    setError("");
    try {
      const value = await serverCall(
        discardEnvironmentSave(props.projectID, environment(), commandID),
      );
      if (epoch !== generation) return;
      retry = undefined;
      publish(value);
      setNotice("Pending save discarded. Existing settings are unchanged.");
    } catch {
      if (epoch === generation)
        setError("Could not discard the pending save. Reload to check its result.");
    } finally {
      if (epoch === generation) setBusy(false);
    }
  }
  async function save(event: SubmitEvent) {
    event.preventDefault();
    const current = view();
    if (!editable() || !current || (!dirty() && !retry)) return;
    const epoch = generation;
    const input = retry ?? {
      commandID: crypto.randomUUID(),
      version: current.version,
      variables: variables(),
      registries: registries(),
    };
    retry = input;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const value = await serverCall(saveEnvironment(props.projectID, environment(), input));
      if (epoch !== generation) return;
      retry = undefined;
      publish(value);
      setNotice("Saved. New starts use these settings; restart existing compute to apply.");
    } catch (cause) {
      if (epoch === generation) {
        const latest = await serverCall(getEnvironment(props.projectID, environment())).catch(
          () => undefined,
        );
        if (epoch !== generation) return;
        if (latest) {
          setView(latest);
          if (!latest.pending || latest.pendingCommandID !== input.commandID) retry = undefined;
        }
        setError(cause instanceof Error ? cause.message : "Could not save environment");
      }
    } finally {
      if (epoch === generation) setBusy(false);
    }
  }
  function previewPaste() {
    try {
      setPreview(parseEnvironmentPaste(paste()));
      setPasteError("");
    } catch {
      setPreview([]);
      setPasteError("Check the pasted variable names, quotes and duplicate entries.");
    }
  }
  function closeImport() {
    setImportOpen(false);
    setPaste("");
    setPreview([]);
    setPasteError("");
    importButton?.focus({ preventScroll: true });
  }
  function importPaste() {
    setVariables((items) => {
      const result = [...items];
      for (const entry of preview()) {
        const index = result.findIndex((item) => item.name === entry.name);
        if (index < 0) result.push({ ...entry, runtime: true, build: false, verification: false });
        else {
          const existing = result[index];
          if (existing) result[index] = { ...existing, value: entry.value };
        }
      }
      return result;
    });
    retry = undefined;
    closeImport();
    clearFilters();
    setNotice("Variables added to draft. Save environment to apply.");
  }
  createEffect(
    () => [props.projectID, environment()] as const,
    () => {
      const epoch = ++generation;
      setView(undefined);
      setVariables([]);
      setRegistries([]);
      setPaste("");
      setPreview([]);
      setPasteError("");
      setImportOpen(false);
      setEditingRegistry(undefined);
      clearFilters();
      setFiltersOpen(false);
      setEditing(undefined);
      menu?.hidePopover();
      setError("");
      setNotice("");
      setBusy(true);
      retry = undefined;
      void serverCall(getEnvironment(props.projectID, environment()))
        .then((value) => {
          if (epoch === generation) publish(value);
        })
        .catch((cause) => {
          if (epoch === generation)
            setError(cause instanceof Error ? cause.message : "Could not load environment");
        })
        .finally(() => {
          if (epoch === generation) setBusy(false);
        });
      return () => {
        generation += 1;
        retry = undefined;
      };
    },
  );
  return (
    <section class="environment-settings model-settings-body" aria-label="Project environment">
      <header class="environment-heading workspace-heading">
        <div class="workspace-heading-title">
          <h2 class="environment-wide-title">Environments</h2>
          <Show when={navigation()}>
            <div class="workspace-action-leading">{navigation()}</div>
          </Show>
        </div>
        <WorkspaceActionBar label="Environment actions">
          <Show when={view()?.canManage}>
            <button
              ref={importButton}
              type="button"
              class="workspace-action"
              aria-controls={importID}
              aria-expanded={importOpen() ? "true" : "false"}
              disabled={!canEditDraft()}
              onClick={() => setImportOpen(true)}
            >
              Import .env
            </button>
            <button
              ref={addButton}
              type="button"
              class="workspace-action"
              data-primary="true"
              disabled={!canEditDraft()}
              onClick={addVariable}
            >
              Add variable
            </button>
          </Show>
        </WorkspaceActionBar>
        <div class="workspace-heading-meta">
          <p class="model-settings-note">
            Variables are separate for each environment. Saved values stay hidden.
          </p>
        </div>
      </header>
      <nav class="environment-tabs" aria-label="Environment">
        <For each={["development", "main-preview"] as const}>
          {(item) => (
            <button
              type="button"
              disabled={busy()}
              aria-pressed={environment() === item ? "true" : "false"}
              onClick={() => setEnvironment(item)}
            >
              {item === "development" ? "Development" : "Main-Preview"}
            </button>
          )}
        </For>
      </nav>
      <Show
        when={view()}
        fallback={
          <p role="status">{busy() ? "Loading environment…" : "Environment unavailable."}</p>
        }
      >
        {(current) => (
          <>
            <Show when={current().preparation}>
              <p class="model-settings-note" role="status">
                {current().preparation === "succeeded"
                  ? "Development image ready for new starts."
                  : current().preparation === "pending" || current().preparation === "running"
                    ? "Preparing the development image. Editing is available independently."
                    : "Using normal Dev Container startup. No compatible prepared image is available."}
              </p>
            </Show>
            <Show when={!current().storeConfigured}>
              <p role="status">
                Connect OpenBao to manage protected values. Existing editing remains available.
              </p>
            </Show>
            <Show when={current().pending || retry}>
              <p role="status">
                A save is unconfirmed. Retry the same save, or discard it to keep existing settings.
              </p>
              <Show when={current().canManage}>
                <button
                  type="button"
                  class="quiet-button"
                  disabled={busy()}
                  onClick={() => void discardPending()}
                >
                  Discard pending save
                </button>
              </Show>
            </Show>
            <search class="environment-toolbar" aria-label="Filter environment variables">
              <label class="environment-search">
                <Icon name="search" />
                <input
                  type="search"
                  aria-label="Search variables"
                  placeholder="Search variables…"
                  value={search()}
                  onInput={(event) => setSearch(event.currentTarget.value)}
                />
              </label>
              <button
                type="button"
                class="workspace-action"
                aria-label="Filter and sort variables"
                aria-controls={filtersID}
                aria-expanded={filtersOpen() ? "true" : "false"}
                onClick={() => setFiltersOpen((open) => !open)}
              >
                Filter & sort
                <Show when={activeOptions() > 0}> · {activeOptions()}</Show>
              </button>
              <fieldset
                id={filtersID}
                class="environment-filter-fields"
                aria-label="Variable filters"
                hidden={!filtersOpen()}
              >
                <select
                  aria-label="Filter by usage"
                  value={usage()}
                  onChange={(event) => setUsage(event.currentTarget.value)}
                >
                  <option value="all">All uses</option>
                  <For each={grants}>
                    {(grant) => <option value={grant}>{grantLabels[grant]}</option>}
                  </For>
                </select>
                <select
                  aria-label="Filter by saved state"
                  value={state()}
                  onChange={(event) => setState(event.currentTarget.value)}
                >
                  <option value="all">All variables</option>
                  <option value="saved">Saved variables</option>
                  <option value="draft">Unsaved changes</option>
                </select>
                <select
                  aria-label="Sort variables"
                  value={sort()}
                  onChange={(event) => setSort(event.currentTarget.value)}
                >
                  <option value="name-asc">Name A to Z</option>
                  <option value="name-desc">Name Z to A</option>
                  <option value="draft-first">Unsaved first</option>
                </select>
              </fieldset>
            </search>
            <form onSubmit={(event) => void save(event)}>
              <Show when={current().canManage && importOpen()}>
                <fieldset
                  id={importID}
                  class="environment-import"
                  aria-label="Import environment variables"
                  disabled={!canEditDraft()}
                  onKeyDown={(event) => {
                    if (event.key !== "Escape" || !canEditDraft()) return;
                    event.preventDefault();
                    event.stopPropagation();
                    closeImport();
                  }}
                >
                  <h3>Import .env</h3>
                  <label>
                    Paste .env contents
                    <textarea
                      ref={(element) =>
                        queueMicrotask(() => {
                          if (element.isConnected) element.focus();
                        })
                      }
                      aria-label="Paste environment variables"
                      rows="4"
                      autocomplete="off"
                      spellcheck={false}
                      value={paste()}
                      onInput={(event) => {
                        setPaste(event.currentTarget.value);
                        setPreview([]);
                        setPasteError("");
                      }}
                    />
                  </label>
                  <Show when={preview().length > 0}>
                    <p class="model-settings-note">
                      {preview()
                        .map((item) => item.name)
                        .join(", ")}{" "}
                      · values hidden
                    </p>
                  </Show>
                  <Show when={pasteError()}>
                    <p role="alert" class="model-settings-error">
                      {pasteError()}
                    </p>
                  </Show>
                  <div class="environment-inline-actions">
                    <button
                      type="button"
                      class="quiet-button"
                      disabled={!paste().trim()}
                      onClick={previewPaste}
                    >
                      Preview import
                    </button>
                    <Show when={preview().length > 0}>
                      <button type="button" class="quiet-button" onClick={importPaste}>
                        Apply to draft
                      </button>
                    </Show>
                    <button type="button" class="quiet-button" onClick={closeImport}>
                      Cancel import
                    </button>
                  </div>
                </fieldset>
              </Show>
              <fieldset class="environment-variable-list" aria-label="Variables">
                <For each={visibleVariables()} keyed={(entry) => entry.index}>
                  {(entry) => (
                    <article
                      class="environment-variable"
                      aria-label={entry().variable.name || "New variable"}
                      data-editing={editing() === entry().index ? "true" : undefined}
                    >
                      <div class="environment-variable-summary">
                        <div class="environment-variable-identity">
                          <span class="environment-variable-name">
                            {entry().variable.name || "New variable"}
                          </span>
                          <Show when={changed(entry().variable)}>
                            <span class="environment-variable-state">Unsaved</span>
                          </Show>
                        </div>
                        <span class="environment-masked-value" role="img" aria-label="Value hidden">
                          <span aria-hidden="true">••••••••••••</span>
                        </span>
                        <span class="environment-variable-uses">
                          {grants
                            .filter((grant) => entry().variable[grant])
                            .map((grant) => grantLabels[grant])
                            .join(" · ") || "No access"}
                        </span>
                        <Show when={current().canManage}>
                          <button
                            type="button"
                            class="bare-icon environment-actions-trigger"
                            aria-label={`Actions for ${entry().variable.name || "new variable"}`}
                            aria-haspopup="menu"
                            aria-expanded={
                              menuOpen() && actions() === entry().index ? "true" : "false"
                            }
                            disabled={!canEditDraft()}
                            onClick={(event) => {
                              opener = event.currentTarget;
                              setActions(entry().index);
                              menu.showPopover();
                              positionMenu();
                            }}
                          >
                            <Icon name="more" />
                          </button>
                        </Show>
                      </div>
                      <Show when={editing() === entry().index}>
                        <fieldset
                          class="environment-variable-editor"
                          disabled={!canEditDraft()}
                          aria-label="Edit variable"
                        >
                          <label>
                            Name
                            <input
                              ref={(element) =>
                                queueMicrotask(() => {
                                  if (element.isConnected) element.focus();
                                })
                              }
                              aria-label={`Variable ${entry().index + 1} name`}
                              autocomplete="off"
                              spellcheck={false}
                              value={entry().variable.name}
                              onInput={(event) =>
                                changeVariable(entry().index, { name: event.currentTarget.value })
                              }
                            />
                          </label>
                          <label>
                            {current().variables.some((item) => item.name === entry().variable.name)
                              ? "Replace value"
                              : "Value"}
                            <textarea
                              rows="2"
                              aria-label={`Value for ${entry().variable.name || "new variable"}`}
                              autocomplete="off"
                              spellcheck={false}
                              placeholder={
                                current().variables.some(
                                  (item) => item.name === entry().variable.name,
                                )
                                  ? "Leave unchanged or enter a replacement"
                                  : "Enter value"
                              }
                              value={entry().variable.value ?? ""}
                              onInput={(event) =>
                                changeVariable(entry().index, { value: event.currentTarget.value })
                              }
                            />
                          </label>
                          <fieldset class="environment-grants" aria-describedby={variableAccessID}>
                            <legend>Available to</legend>
                            <For each={grants}>
                              {(grant) => (
                                <label>
                                  <input
                                    type="checkbox"
                                    checked={entry().variable[grant]}
                                    onChange={(event) =>
                                      changeVariable(entry().index, {
                                        [grant]: event.currentTarget.checked,
                                      })
                                    }
                                  />
                                  {grantLabels[grant]}
                                </label>
                              )}
                            </For>
                          </fieldset>
                          <p
                            id={variableAccessID}
                            class="environment-access-note model-settings-note"
                          >
                            Runtime values can be read by your application and its coding agent.
                            Build values require repository-owned BuildKit secret mounts from
                            /run/factory-build-secrets/NAME. Verification access is opt-in. Never
                            pass protected values through build args.
                          </p>
                          <button
                            type="button"
                            class="quiet-button environment-editor-done"
                            onClick={() => {
                              setEditing(undefined);
                              addButton?.focus({ preventScroll: true });
                            }}
                          >
                            Done editing
                          </button>
                        </fieldset>
                      </Show>
                    </article>
                  )}
                </For>
                <Show when={variables().length === 0}>
                  <div class="environment-empty">
                    <p>
                      No variables in{" "}
                      {environment() === "development" ? "Development" : "Main-Preview"}.
                    </p>
                    <p class="model-settings-note">
                      {current().canManage
                        ? "Add a variable or paste a .env file to get started."
                        : "Project managers can add variables here."}
                    </p>
                  </div>
                </Show>
                <Show when={variables().length > 0 && visibleVariables().length === 0}>
                  <div class="environment-empty">
                    <p>No variables match these filters.</p>
                    <button type="button" class="quiet-button" onClick={clearFilters}>
                      Clear filters
                    </button>
                  </div>
                </Show>
              </fieldset>
              <section
                class="environment-section environment-private-images"
                aria-label="Private container images"
              >
                <header class="environment-section-heading">
                  <h3>Private container images</h3>
                  <Show when={current().canManage}>
                    <button
                      ref={addRegistryButton}
                      type="button"
                      class="workspace-action"
                      disabled={!canEditDraft()}
                      onClick={() => {
                        setEditingRegistry(registries().length);
                        setRegistries((items) => [
                          ...items,
                          { host: "", username: "", password: "", verification: false },
                        ]);
                        setNotice("");
                      }}
                    >
                      Add credentials
                    </button>
                  </Show>
                </header>
                <p class="model-settings-note">
                  Credentials for private image downloads during environment preparation and
                  startup.
                </p>
                <For each={registries()} keyed={false}>
                  {(registry, index) => (
                    <article class="environment-image-connection">
                      <div class="environment-image-summary">
                        <div class="environment-image-identity">
                          <span class="environment-image-name">
                            {registry().host || "New image credentials"}
                          </span>
                          <Show when={registry().username}>
                            <span class="model-settings-note">{registry().username}</span>
                          </Show>
                          <Show when={registry().verification}>
                            <span class="model-settings-note">Verification</span>
                          </Show>
                        </div>
                        <Show when={current().canManage}>
                          <button
                            type="button"
                            class="workspace-action"
                            aria-label={`Edit image credentials for ${registry().host || "new registry"}`}
                            disabled={!canEditDraft()}
                            onClick={() => setEditingRegistry(index)}
                          >
                            Edit
                          </button>
                        </Show>
                      </div>
                      <Show when={editingRegistry() === index}>
                        <fieldset
                          class="environment-registry"
                          aria-label="Edit image credentials"
                          disabled={!canEditDraft()}
                        >
                          <p class="environment-registry-note model-settings-note">
                            Choose images in your repository's Dev Container configuration. Use a
                            read-only token limited to the images this Project needs.
                          </p>
                          <label>
                            Registry address
                            <input
                              ref={(element) =>
                                queueMicrotask(() => {
                                  if (element.isConnected) element.focus();
                                })
                              }
                              aria-label={`Registry ${index + 1} host`}
                              placeholder="registry.example.com"
                              value={registry().host}
                              onInput={(event) =>
                                changeRegistry(index, { host: event.currentTarget.value })
                              }
                            />
                          </label>
                          <label>
                            Username
                            <input
                              value={registry().username}
                              onInput={(event) =>
                                changeRegistry(index, { username: event.currentTarget.value })
                              }
                            />
                          </label>
                          <label>
                            Replace password or token
                            <input
                              type="password"
                              autocomplete="new-password"
                              placeholder="Enter to replace"
                              value={registry().password ?? ""}
                              onInput={(event) =>
                                changeRegistry(index, { password: event.currentTarget.value })
                              }
                            />
                          </label>
                          <details>
                            <summary>Certificate and Verification access</summary>
                            <label>
                              Registry CA certificate
                              <textarea
                                rows="3"
                                placeholder="PEM certificate · enter to replace"
                                value={registry().certificate ?? ""}
                                onInput={(event) =>
                                  changeRegistry(index, { certificate: event.currentTarget.value })
                                }
                              />
                            </label>
                            <label class="environment-check">
                              <input
                                type="checkbox"
                                checked={registry().verification}
                                onChange={(event) =>
                                  changeRegistry(index, {
                                    verification: event.currentTarget.checked,
                                  })
                                }
                              />
                              Allow image pulls during Verification
                            </label>
                          </details>
                          <div class="environment-inline-actions">
                            <button
                              type="button"
                              class="quiet-button"
                              onClick={() => {
                                setEditingRegistry(undefined);
                                addRegistryButton?.focus({ preventScroll: true });
                              }}
                            >
                              Done editing credentials
                            </button>
                            <button
                              type="button"
                              class="quiet-button"
                              aria-label={`Remove registry ${registry().host || index + 1}`}
                              onClick={() => {
                                retry = undefined;
                                setEditingRegistry(undefined);
                                setRegistries((items) =>
                                  items.filter((_, position) => position !== index),
                                );
                                setNotice("");
                                addRegistryButton?.focus({ preventScroll: true });
                              }}
                            >
                              Remove
                            </button>
                          </div>
                        </fieldset>
                      </Show>
                    </article>
                  )}
                </For>
                <Show when={registries().length === 0}>
                  <p class="model-settings-note">
                    No private credentials. Public images need none.
                  </p>
                </Show>
              </section>
              <Show when={current().canManage && (dirty() || retry || current().pending)}>
                <footer class="environment-savebar">
                  <span class="model-settings-note">
                    {retry || current().pending ? "Save unconfirmed" : "Unsaved changes"}
                  </span>
                  <button type="submit" class="primary-button" disabled={!editable()}>
                    {busy() ? "Saving…" : retry ? "Retry save" : "Save environment"}
                  </button>
                </footer>
              </Show>
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
      <div
        ref={menu}
        class="environment-actions-menu"
        popover="auto"
        role="menu"
        aria-label="Variable actions"
        onToggle={(event) => setMenuOpen(event.newState === "open")}
      >
        <button
          type="button"
          role="menuitem"
          disabled={!canEditDraft()}
          onClick={() => {
            menu.hidePopover();
            const index = actions();
            if (index !== undefined) editVariable(index);
          }}
        >
          Edit variable
        </button>
        <button
          type="button"
          role="menuitem"
          class="danger-link"
          disabled={!canEditDraft()}
          onClick={() => {
            const index = actions();
            if (index !== undefined) removeVariable(index);
          }}
        >
          Remove variable
        </button>
      </div>
    </section>
  );
}
