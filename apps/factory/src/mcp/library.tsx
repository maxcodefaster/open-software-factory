import type { JSX } from "@solidjs/web";
import { createEffect, createSignal, For, Show, untrack } from "solid-js";
import type { z } from "zod";
import {
  type MCPChoice,
  type MCPDefinition,
  type MCPLibraryView,
  type MCPRole,
  mcpDefinition,
  type mcpSaveInput,
  recommendedMCPs,
  resolveMCPChoice,
} from "../../../../packages/conversation-domain/src/mcp-library";
import { Icon } from "../icon";
import { monitoringSourceAvailable } from "../monitoring/sources";
import {
  acceptMCPSharing,
  connectMCP,
  disconnectMCP,
  getMCPLibrary,
  grantMCPProject,
  proposeMCPSharing,
  reviewMCPAccess,
  saveMCPChoice,
  saveMCPCover,
  saveMCPDefinition,
} from "../server-functions/mcp";
import { serverCall } from "../server-functions/result";
import { WorkspaceActionBar } from "../ui/workspace-actions";
import "../skills/library.css";
import "./library.css";
import type { LibraryCover } from "../../../../packages/conversation-domain/src/library-covers";
import { libraryCoverURL } from "../library-covers/catalog";
import { LibraryCoverPicker } from "../library-covers/picker";
import { createMCPNavigation } from "./navigation";

type Scope = "personal" | "project" | "system";
type Entry = MCPLibraryView["entries"][number];
const cover = (provider: string, selected?: LibraryCover | null) =>
  selected
    ? libraryCoverURL(selected.key, "mcp")
    : `/art/mcp/${provider === "sentry" || provider === "datadog" ? provider : "custom"}.webp`;
const endpointHost = (endpoint: string | undefined) => (endpoint ? new URL(endpoint).host : "");
const scopeLabel = (scope: Scope) =>
  scope === "personal" ? "Personal" : scope === "project" ? "Project" : "Factory";
const roleLabel = (role: MCPRole) => (role === "planning" ? "Investigate & Plan" : "Build");
const stateLabel = (state: string | undefined) =>
  ({
    disconnected: "Not connected",
    authorizing: "Finish authorization",
    review: "Review read-only access",
    ready: "Connected",
    reconnect: "Reconnect required",
    revoked: "Disconnected",
  })[state ?? "disconnected"] ?? "Not connected";

export function MCPLibrary(props: {
  active?: boolean | undefined;
  navigation?: JSX.Element;
  projectId?: string | undefined;
  projectName?: string | undefined;
  monitoringSetup?: { id: string; projectId: string; projectName: string } | undefined;
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
  const [draft, setDraft] = createSignal<{
    content: MCPDefinition;
    scope: Scope;
    projectId?: string;
    projectName?: string;
    entry?: Entry;
  }>();
  const editor = () => navigation.editor() && Boolean(draft());
  const [busy, setBusy] = createSignal(false);
  const [loading, setLoading] = createSignal(false);
  const [readError, setReadError] = createSignal("");
  const [error, setError] = createSignal("");
  const [message, setMessage] = createSignal("");
  const [token, setToken] = createSignal("");
  const [allowed, setAllowed] = createSignal<string[]>([]);
  const [confirmed, setConfirmed] = createSignal(false);
  const [authorization, setAuthorization] = createSignal<string>();
  const [shareTarget, setShareTarget] = createSignal<"project" | "system">("project");
  let sequence = 0;
  let pendingSave: { basis: string; input: z.input<typeof mcpSaveInput> } | undefined;
  let heading: HTMLHeadingElement | undefined;
  let addButton: HTMLButtonElement | undefined;
  let gallery: HTMLDivElement | undefined;
  let actionMenu: HTMLDetailsElement | undefined;
  let filterRoot: HTMLDivElement | undefined;
  let filterButton: HTMLButtonElement | undefined;
  let setupHeading: HTMLHeadingElement | undefined;
  const filterID = `mcp-filters-${crypto.randomUUID()}`;
  const activeFilters = () => [owner(), workType()].filter((value) => value !== "all").length;
  let scroll = 0;
  const setupHere = () =>
    Boolean(props.monitoringSetup && props.monitoringSetup.projectId === props.projectId);
  const setupBlocked = () =>
    Boolean(props.monitoringSetup && (!setupHere() || !view()?.canManageProject));
  const draftForMonitoring = () =>
    draft()?.scope === "project" && draft()?.projectId === props.monitoringSetup?.projectId;
  const entry = () => view()?.entries.find((item) => item.id === selected());
  const latest = () => entry()?.revisions[0];
  const entries = () =>
    (view()?.entries ?? []).filter((item) => {
      const content = item.revisions[0]?.content;
      return (
        content &&
        `${content.name} ${content.description} ${content.endpoint}`
          .toLowerCase()
          .includes(query().toLowerCase()) &&
        (owner() === "all" || item.scope === owner()) &&
        (workType() === "all" || content.roles.includes(workType() as MCPRole)) &&
        (scope() === "personal" || item.scope !== "personal") &&
        (!props.monitoringSetup || item.scope !== "personal")
      );
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
  async function load(projectId: string | undefined, quiet = false) {
    const current = ++sequence;
    if (!quiet) setLoading(true);
    try {
      const result = await serverCall(
        projectId ? getMCPLibrary({ data: [projectId] }) : getMCPLibrary({ data: [] }),
      );
      if (current !== sequence) return;
      setReadError("");
      const previousEntry = view()?.entries.find((item) => item.id === selected());
      const nextEntry = result.entries.find((item) => item.id === selected());
      if (
        previousEntry &&
        (previousEntry.revisions[0]?.id !== nextEntry?.revisions[0]?.id ||
          previousEntry.connection?.version !== nextEntry?.connection?.version ||
          previousEntry.connection?.state !== nextEntry?.connection?.state)
      ) {
        setConfirmed(false);
        setAllowed(nextEntry?.connection?.allowedTools ?? []);
      }
      if (JSON.stringify(view()) !== JSON.stringify(result)) setView(result);
      if (
        result.entries.find((item) => item.id === selected())?.connection?.state !== "authorizing"
      )
        setAuthorization(undefined);
      if (
        (scope() === "system" && !result.canManageSystem) ||
        (scope() === "project" && !result.canManageProject)
      )
        setScope("personal");
      return result;
    } catch (cause) {
      if (current === sequence)
        setReadError(cause instanceof Error ? cause.message : "Could not load connections.");
    } finally {
      if (current === sequence && !quiet) setLoading(false);
    }
  }
  async function mutate(action: () => Promise<unknown>, text: string) {
    if (busy()) return false;
    setBusy(true);
    setError("");
    setMessage("");
    try {
      await action();
      setMessage(text);
      await load(props.projectId);
      return true;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The MCP action failed. Try again.");
      return false;
    } finally {
      setBusy(false);
    }
  }
  createEffect(
    () => ({ active: props.active, projectId: props.projectId }),
    ({ active, projectId }) => {
      setReadError("");
      if (active !== false) void load(projectId);
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
      if (!id) {
        setAllowed(untrack(() => entry()?.connection?.allowedTools ?? []));
        setToken("");
        setAuthorization(undefined);
        setConfirmed(false);
        setError("");
        setMessage("");
        return;
      }
      setError("");
      setMessage("");
      setToken("");
      setConfirmed(false);
      setAuthorization(undefined);
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
        void load(projectId, true).finally(() => {
          refreshing = false;
        });
      }, 2_000);
      return () => clearInterval(timer);
    },
  );
  function open(item: Entry) {
    scroll = gallery?.scrollTop ?? 0;
    setFilters(false);
    setSelected(item.id);
    setAllowed(item.connection?.allowedTools ?? []);
    setConfirmed(false);
    setToken("");
    setAuthorization(undefined);
    setError("");
    requestAnimationFrame(() => heading?.focus({ preventScroll: true }));
  }
  function close() {
    const id = selected();
    setSelected(undefined);
    setToken("");
    setAuthorization(undefined);
    requestAnimationFrame(() => {
      gallery?.scrollTo(0, scroll);
      document.getElementById(`mcp-open-${id}`)?.focus({ preventScroll: true });
    });
  }
  function edit(content?: MCPDefinition, item?: Entry) {
    if (setupBlocked()) return;
    if (!draft())
      setDraft({
        content: content ?? {
          name: "",
          description: "",
          endpoint: "",
          provider: "custom",
          authentication: "oauth",
          roles: ["planning", "build"],
        },
        scope: item?.scope ?? (props.monitoringSetup ? "project" : "personal"),
        ...(props.projectId ? { projectId: props.projectId } : {}),
        ...(props.projectName ? { projectName: props.projectName } : {}),
        ...(item ? { entry: item } : {}),
      });
    setEditor(true);
    requestAnimationFrame(() => heading?.focus());
  }
  function update(value: Partial<MCPDefinition>) {
    setDraft((current) =>
      current ? { ...current, content: { ...current.content, ...value } } : current,
    );
  }
  async function saveDraft(event: SubmitEvent) {
    event.preventDefault();
    const current = draft();
    if (!current || setupBlocked() || (props.monitoringSetup && !draftForMonitoring())) return;
    const parsed = mcpDefinition.safeParse(current.content);
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? "Check the MCP definition");
      return;
    }
    const basis = JSON.stringify({
      libraryId: current.entry?.id ?? null,
      expectedRevision: current.entry?.revisions[0]?.revision ?? 0,
      scope: current.scope,
      projectId: current.scope === "project" ? current.projectId : null,
      content: parsed.data,
    });
    if (!pendingSave || pendingSave.basis !== basis)
      pendingSave = {
        basis,
        input: {
          libraryId: current.entry?.id ?? crypto.randomUUID(),
          revisionId: crypto.randomUUID(),
          expectedRevision: current.entry?.revisions[0]?.revision ?? 0,
          scope: current.scope,
          ...(current.scope === "project" && current.projectId
            ? { projectId: current.projectId }
            : {}),
          content: parsed.data,
        },
      };
    const submitted = pendingSave;
    const libraryId = submitted.input.libraryId;
    await mutate(
      async () => {
        await serverCall(saveMCPDefinition({ data: [submitted.input] }));
        pendingSave = undefined;
        setDraft(undefined);
        setEditor(false);
        setSelected(libraryId);
        setScope(current.scope);
        setAllowed([]);
        setConfirmed(false);
        requestAnimationFrame(() => heading?.focus());
      },
      props.monitoringSetup
        ? "Project connection saved. Connect and review read-only access to continue."
        : "MCP definition saved. Connect and review access before enabling it.",
    );
  }
  async function choose(item: Entry, role: MCPRole, state: MCPChoice["state"]) {
    const revision = item.revisions[0];
    if (!revision) {
      setError("This MCP definition has no saved version. Reload before continuing.");
      return;
    }
    const current = view()?.choices.find(
      (choice) => choice.libraryId === item.id && choice.role === role && choice.scope === scope(),
    );
    await mutate(
      () =>
        serverCall(
          saveMCPChoice({
            data: [
              {
                libraryId: item.id,
                revisionId: revision.id,
                scope: scope(),
                role,
                state,
                expectedVersion: current?.version ?? 0,
                ...(scope() !== "system" && props.projectId ? { projectId: props.projectId } : {}),
              },
            ],
          }),
        ),
      "MCP choice saved for new work.",
    );
  }
  async function connect() {
    const item = entry();
    if (!item || setupBlocked()) return;
    const revision = item.revisions[0];
    if (!revision) {
      setError("This MCP definition has no saved version. Reload before continuing.");
      return;
    }
    setAuthorization(undefined);
    await mutate(async () => {
      const result = await serverCall(
        connectMCP({
          data: [
            item.id,
            {
              commandId: crypto.randomUUID(),
              revisionId: revision.id,
              expectedVersion: item.connection?.version ?? 0,
              ...(latest()?.content.authentication === "bearer" ? { token: token() } : {}),
            },
          ],
        }),
      );
      setToken("");
      setAllowed([]);
      setConfirmed(false);
      setAuthorization(result.authorizationUrl ?? undefined);
    }, "Continue sign-in if requested, then review read-only access.");
  }
  return (
    <div
      class="skill-library mcp-library"
      data-detail={entry() ? "true" : "false"}
      data-monitoring={props.monitoringSetup ? "true" : undefined}
    >
      <Show when={props.monitoringSetup}>
        {(setup) => (
          <section class="mcp-monitoring-setup" aria-label="Input connection setup">
            <button
              type="button"
              class="quiet-button skill-back"
              disabled={busy()}
              onClick={() => props.onMonitoringReturn?.()}
            >
              <Icon name="chevron" />
              Back to inputs
            </button>
            <h2
              tabindex="-1"
              ref={(element) => {
                setupHeading = element;
              }}
            >
              Connect a source for {setup().projectName}
            </h2>
            <p>
              Connect a read-only source for this Input. Its task and webhook stay in Inputs.
              Connecting alone starts no work.
            </p>
            <Show when={!setupHere()}>
              <p role="alert">
                This setup belongs to {setup().projectName}. Return to that Project to continue, or
                go back to Inputs for the current Project. Your draft has not moved.
              </p>
            </Show>
            <Show when={setupHere() && view() && !view()?.canManageProject}>
              <p role="alert">Project management access is required to connect a shared source.</p>
            </Show>
          </section>
        )}
      </Show>
      <header class="skill-library-heading workspace-heading" hidden={Boolean(entry()) || editor()}>
        <div class="skill-library-title workspace-heading-title">
          <h2>{props.monitoringSetup ? "Choose a source" : "MCP connections"}</h2>
          <span class="skill-result-count">
            {view() ? `${entries().length} ${entries().length === 1 ? "source" : "sources"}` : ""}
          </span>
        </div>
        <WorkspaceActionBar
          label="MCP library actions"
          leading={props.monitoringSetup ? undefined : props.navigation}
        >
          <Show
            when={!props.monitoringSetup && (view()?.canManageProject || view()?.canManageSystem)}
          >
            <details
              class="skill-action-menu"
              ref={(element) => {
                actionMenu = element;
              }}
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  event.preventDefault();
                  event.stopPropagation();
                  if (actionMenu) actionMenu.open = false;
                  actionMenu?.querySelector("summary")?.focus();
                }
              }}
            >
              <summary
                class="workspace-action workspace-menu-trigger"
                aria-label="MCP library actions"
              >
                <Icon name="more" />
              </summary>
              <div class="skill-action-options">
                <button
                  type="button"
                  class="quiet-button"
                  onClick={() => {
                    if (actionMenu) actionMenu.open = false;
                    setScope(
                      scope() === "personal"
                        ? view()?.canManageProject
                          ? "project"
                          : "system"
                        : "personal",
                    );
                    setSelected(undefined);
                  }}
                >
                  {scope() === "personal" ? "Manage" : "Browse connections"}
                </button>
              </div>
            </details>
          </Show>
          <button
            ref={(element) => {
              addButton = element;
            }}
            type="button"
            class="workspace-action"
            data-primary="true"
            disabled={busy() || setupBlocked()}
            onClick={() => edit()}
          >
            {draft() ? "Resume draft" : props.monitoringSetup ? "Other service" : "Add MCP"}
          </button>
        </WorkspaceActionBar>
        <Show when={!props.monitoringSetup}>
          <p class="mcp-library-subtitle workspace-heading-meta">
            Connect external tools and context to Project work.
          </p>
        </Show>
        <div class="skill-library-tools workspace-heading-meta">
          <label class="skill-search">
            <Icon name="search" />
            <input
              type="search"
              aria-label="Search MCP connections"
              placeholder="Find a connection"
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
              aria-expanded={filters() ? "true" : "false"}
              aria-controls={filterID}
              onKeyDown={dismissFilters}
              onClick={() => {
                if (actionMenu) actionMenu.open = false;
                setFilters((open) => !open);
              }}
            >
              Filter{activeFilters() ? ` · ${activeFilters()}` : ""}
            </button>
            <div class="skill-filter-options" id={filterID} hidden={!filters()}>
              <label>
                Ownership
                <select
                  value={owner()}
                  onChange={(event) => setOwner(event.currentTarget.value)}
                  onKeyDown={dismissFilters}
                >
                  <option value="all">All owners</option>
                  <Show when={!props.monitoringSetup}>
                    <option value="personal">Only me</option>
                  </Show>
                  <option value="project">Project</option>
                  <option value="system">Factory</option>
                </select>
              </label>
              <label>
                Work type
                <select
                  value={workType()}
                  onChange={(event) => setWorkType(event.currentTarget.value)}
                  onKeyDown={dismissFilters}
                >
                  <option value="all">All work types</option>
                  <option value="planning">Investigate &amp; Plan</option>
                  <option value="build">Build</option>
                </select>
              </label>
              <Show when={query() || activeFilters()}>
                <button
                  type="button"
                  class="quiet-button"
                  onKeyDown={dismissFilters}
                  onClick={() => {
                    clearFilters();
                    filterButton?.focus();
                  }}
                >
                  Clear filters
                </button>
              </Show>
            </div>
          </div>
        </div>
      </header>
      <Show when={readError()}>
        <div class="skill-library-error" role="alert">
          <span>{readError()}</span>
          <button
            type="button"
            class="quiet-button"
            disabled={loading() || busy()}
            onClick={() => void load(props.projectId)}
          >
            Retry loading
          </button>
        </div>
      </Show>
      <Show when={error()}>
        <p class="skill-library-error" role="alert">
          {error()}
        </p>
      </Show>
      <p class="skill-library-status" role="status">
        {loading() ? "Loading connections…" : message()}
      </p>
      <div class="skill-editor-screen" hidden={!editor()}>
        <Show when={draft()}>
          {(current) => (
            <form class="skill-editor mcp-editor" onSubmit={(event) => void saveDraft(event)}>
              <button
                type="button"
                class="quiet-button skill-back"
                onClick={() => {
                  setEditor(false);
                  requestAnimationFrame(() => addButton?.focus());
                }}
              >
                <Icon name="chevron" />
                Back to library
              </button>
              <h3
                tabindex="-1"
                ref={(element) => {
                  heading = element;
                }}
              >
                {props.monitoringSetup && draftForMonitoring()
                  ? `Set up ${current().content.name || "a source"}`
                  : current().entry
                    ? "Edit MCP definition"
                    : "Add MCP definition"}
              </h3>
              <p>
                {props.monitoringSetup && draftForMonitoring()
                  ? "Save this Project connection, then sign in and review its read-only access."
                  : "Start with a remote HTTPS endpoint. Saving a definition does not connect or enable it."}
              </p>
              <Show when={props.monitoringSetup && !draftForMonitoring()}>
                <p role="alert">
                  You already have a draft outside this Project setup. It has not been changed.
                  Discard it to start this connection, or return to the MCP library to finish it.
                </p>
              </Show>
              <Show when={current().scope === "project" && current().projectId !== props.projectId}>
                <p>
                  This draft still belongs to {current().projectName ?? "its original Project"}.
                  Switching Projects does not retarget it.
                </p>
              </Show>
              <label>
                Name
                <input
                  required
                  maxlength="100"
                  value={current().content.name}
                  onInput={(event) => update({ name: event.currentTarget.value })}
                />
              </label>
              <details
                class="mcp-definition-settings"
                open={!props.monitoringSetup || current().content.provider === "custom"}
              >
                <summary hidden={!props.monitoringSetup}>Connection settings</summary>
                <label>
                  When to use
                  <textarea
                    rows="3"
                    maxlength="2000"
                    value={current().content.description}
                    onInput={(event) => update({ description: event.currentTarget.value })}
                  />
                </label>
                <label>
                  MCP endpoint
                  <input
                    required
                    type="url"
                    placeholder="https://example.com/mcp"
                    value={current().content.endpoint}
                    onInput={(event) => update({ endpoint: event.currentTarget.value })}
                  />
                </label>
                <p class="skill-help">
                  Public HTTPS only. Never put credentials in the endpoint URL.
                </p>
                <label>
                  Authentication
                  <select
                    value={current().content.authentication}
                    onChange={(event) =>
                      update({
                        authentication: event.currentTarget
                          .value as MCPDefinition["authentication"],
                      })
                    }
                  >
                    <option value="oauth">Connect with OAuth</option>
                    <option value="bearer">Read-only access token</option>
                    <option value="none">No authentication</option>
                  </select>
                </label>
              </details>
              <Show when={!props.monitoringSetup || current().entry}>
                <fieldset>
                  <legend>Available for</legend>
                  <For each={["planning", "build"] as const}>
                    {(role) => (
                      <label class="mcp-checkbox">
                        <input
                          type="checkbox"
                          checked={current().content.roles.includes(role)}
                          onChange={(event) =>
                            update({
                              roles: event.currentTarget.checked
                                ? [...current().content.roles, role]
                                : current().content.roles.filter((item) => item !== role),
                            })
                          }
                        />
                        {roleLabel(role)}
                      </label>
                    )}
                  </For>
                </fieldset>
              </Show>
              <Show when={!props.monitoringSetup || !draftForMonitoring()}>
                <label>
                  Save in
                  <select
                    value={current().scope}
                    disabled={Boolean(current().entry) || Boolean(props.monitoringSetup)}
                    onChange={(event) =>
                      setDraft({ ...current(), scope: event.currentTarget.value as Scope })
                    }
                  >
                    <option value="personal">Personal library</option>
                    <Show when={view()?.canManageProject && current().projectId}>
                      <option value="project">{current().projectName ?? "Project"} library</option>
                    </Show>
                    <Show when={view()?.canManageSystem}>
                      <option value="system">Factory library</option>
                    </Show>
                  </select>
                </label>
              </Show>
              <Show when={props.monitoringSetup && draftForMonitoring()}>
                <p>
                  Shared with {current().projectName ?? "this Project"} for clarification and
                  implementation. Other work stays unchanged.
                </p>
              </Show>
              <div class="mcp-actions">
                <button
                  type="submit"
                  class="primary-button"
                  disabled={
                    busy() ||
                    setupBlocked() ||
                    Boolean(props.monitoringSetup && !draftForMonitoring())
                  }
                >
                  {props.monitoringSetup && draftForMonitoring()
                    ? "Save connection"
                    : "Save definition"}
                </button>
                <button
                  type="button"
                  class="quiet-button"
                  disabled={busy()}
                  onClick={() => {
                    setDraft(undefined);
                    setEditor(false);
                    setError("");
                  }}
                >
                  Discard draft
                </button>
              </div>
            </form>
          )}
        </Show>
      </div>
      <div class="skill-library-browser" hidden={editor()}>
        <Show when={!props.monitoringSetup && !entry() && scope() !== "personal"}>
          <div class="skill-library-context">
            <button type="button" class="quiet-button" onClick={() => setScope("personal")}>
              Browse connections
            </button>
            <label>
              Manage defaults for
              <select
                value={scope()}
                onChange={(event) => setScope(event.currentTarget.value as Scope)}
              >
                <Show when={view()?.canManageProject}>
                  <option value="project">{props.projectName ?? "Project"}</option>
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
            hidden={Boolean(entry())}
            ref={(element) => {
              gallery = element;
            }}
          >
            <Show when={!props.monitoringSetup && scope() !== "personal"}>
              <section class="skill-proposals" aria-label="MCP sharing review queue">
                <h3>Sharing review</h3>
                <For each={view()?.proposals.filter((proposal) => proposal.target === scope())}>
                  {(proposal) => (
                    <section class="skill-proposal">
                      <h4>
                        {proposal.revision.content.name} · v{proposal.revision.revision}
                      </h4>
                      <p>{proposal.revision.content.description}</p>
                      <p class="mcp-endpoint">{proposal.revision.content.endpoint}</p>
                      <p>
                        Acceptance copies only this definition. No credentials, connection or
                        enabled defaults are shared.
                      </p>
                      <button
                        type="button"
                        class="quiet-button"
                        disabled={busy() || setupBlocked()}
                        onClick={() =>
                          void mutate(async () => {
                            const result = await serverCall(
                              acceptMCPSharing({ data: [proposal.id] }),
                            );
                            setSelected(result.libraryId);
                          }, "Definition added to the shared library. Connect it separately.")
                        }
                      >
                        Add to shared library
                      </button>
                    </section>
                  )}
                </For>
                <Show when={!view()?.proposals.some((proposal) => proposal.target === scope())}>
                  <p>No sharing proposals awaiting review.</p>
                </Show>
              </section>
            </Show>
            <section class="skill-gallery mcp-gallery" aria-label="MCP gallery">
              <For each={entries()}>
                {(item) => (
                  <article
                    class="skill-gallery-card mcp-gallery-card"
                    aria-label={item.revisions[0]?.content.name}
                  >
                    <button
                      id={`mcp-open-${item.id}`}
                      type="button"
                      class="skill-tile"
                      aria-label={`Inspect ${item.revisions[0]?.content.name}`}
                      onClick={() => open(item)}
                    >
                      <img
                        class="mcp-cover"
                        src={cover(item.revisions[0]?.content.provider ?? "custom", item.cover)}
                        width="768"
                        height="512"
                        alt=""
                        loading="lazy"
                      />
                      <span class="skill-tile-caption">
                        <span class="skill-tile-title">{item.revisions[0]?.content.name}</span>
                        <span class="mcp-service-endpoint">
                          {endpointHost(item.revisions[0]?.content.endpoint)}
                        </span>
                        <span class="skill-tile-description">
                          {item.revisions[0]?.content.description}
                        </span>
                      </span>
                    </button>
                    <div class="mcp-card-meta">
                      <span
                        class="mcp-connection-state"
                        data-state={item.connection?.state ?? "disconnected"}
                      >
                        <Icon name="link" />
                        {stateLabel(item.connection?.state)}
                      </span>
                      <span>{scopeLabel(item.scope)}</span>
                    </div>
                  </article>
                )}
              </For>
            </section>
            <Show
              when={
                view() &&
                !entries().length &&
                (query() || owner() !== "all" || workType() !== "all")
              }
            >
              <div class="skill-library-empty">
                <h3>No matching connections</h3>
                <p>Try another search or clear the filters.</p>
                <button type="button" class="quiet-button" onClick={clearFilters}>
                  Clear filters
                </button>
              </div>
            </Show>
            <section class="mcp-recommendations" aria-label="Recommended MCP connections">
              <Show when={props.monitoringSetup || entries().length}>
                <h3>
                  {props.monitoringSetup ? "Connect a service" : "Recommended starting points"}
                </h3>
              </Show>
              <Show when={props.monitoringSetup}>
                <p>
                  Choose a service below, or use Other service for a different remote MCP endpoint.
                </p>
              </Show>
              <div class="skill-gallery mcp-gallery">
                <For each={recommendedMCPs}>
                  {(suggestion) => (
                    <article class="skill-gallery-card">
                      <button
                        type="button"
                        class="skill-tile"
                        disabled={Boolean(draft()) || setupBlocked()}
                        aria-label={`Set up ${suggestion.name}`}
                        onClick={() => edit(suggestion)}
                      >
                        <img
                          class="mcp-cover"
                          src={cover(suggestion.provider)}
                          width="768"
                          height="512"
                          alt=""
                          loading="lazy"
                        />
                        <span class="skill-tile-caption">
                          <span class="skill-tile-title">{suggestion.name}</span>
                          <span class="mcp-service-endpoint">
                            {endpointHost(suggestion.endpoint)}
                          </span>
                          <span class="skill-tile-description">{suggestion.description}</span>
                        </span>
                      </button>
                    </article>
                  )}
                </For>
              </div>
            </section>
          </div>
          <Show when={entry()}>
            {(item) => (
              <section
                class="skill-gallery-detail"
                aria-label="MCP details"
                onKeyDown={(event) => {
                  if (event.key === "Escape" && !(event.target instanceof HTMLSelectElement)) {
                    event.preventDefault();
                    event.stopPropagation();
                    close();
                  }
                }}
              >
                <header class="skill-detail-heading mcp-detail-heading">
                  <img
                    class="mcp-cover"
                    src={cover(latest()?.content.provider ?? "custom", item().cover)}
                    width="768"
                    height="512"
                    alt=""
                  />
                  <div class="skill-detail-introduction">
                    <div class="workspace-heading">
                      <h3
                        class="workspace-heading-title"
                        tabindex="-1"
                        ref={(element) => {
                          heading = element;
                        }}
                      >
                        {latest()?.content.name}
                      </h3>
                      <WorkspaceActionBar label="MCP actions">
                        <button type="button" class="workspace-action" onClick={close}>
                          Back to library
                        </button>
                        <Show
                          when={
                            item().editable &&
                            (!props.monitoringSetup || item().scope === "project")
                          }
                        >
                          <button
                            type="button"
                            class="workspace-action"
                            data-primary="true"
                            disabled={busy() || setupBlocked() || Boolean(draft())}
                            onClick={() => {
                              const revision = latest();
                              if (revision) edit(revision.content, item());
                            }}
                          >
                            Edit definition
                          </button>
                        </Show>
                      </WorkspaceActionBar>
                    </div>
                    <p>{latest()?.content.description}</p>
                    <p class="skill-detail-origin">
                      {scopeLabel(item().scope)} library · Definition v{latest()?.revision}
                    </p>
                  </div>
                </header>
                <Show when={item().editable && !setupBlocked()}>
                  <LibraryCoverPicker
                    kind="mcp"
                    cover={item().cover}
                    busy={busy()}
                    onSave={(key, expectedVersion) =>
                      mutate(
                        () =>
                          serverCall(
                            saveMCPCover({
                              data: [{ libraryId: item().id, key, expectedVersion }],
                            }),
                          ),
                        "Cover saved. Connection access is unchanged.",
                      )
                    }
                  />
                </Show>
                <section class="mcp-connection" aria-label="MCP connection">
                  <h4>{stateLabel(item().connection?.state)}</h4>
                  <p class="mcp-endpoint">{latest()?.content.endpoint}</p>
                  <Show when={item().connection && item().connection?.revisionId !== latest()?.id}>
                    <p>
                      The saved definition is newer than the connected version. Reconnect and review
                      it before adopting it for new work. Existing choices have not changed.
                    </p>
                  </Show>
                  <Show when={item().connection}>
                    <details open={!props.monitoringSetup}>
                      <summary hidden={!props.monitoringSetup}>Changing account access</summary>
                      <p class="skill-help">
                        Reconnect replaces the account authorization
                        {item().scope === "system" ? " and requires new Project grants" : ""}. Work
                        admitted with the old connection cannot perform further lookups. Disconnect
                        blocks new lookups here; revoke or rotate the provider credential separately
                        when needed.
                      </p>
                    </details>
                  </Show>
                  <Show
                    when={item().editable}
                    fallback={
                      <p>
                        Ask the connection manager to authorize and grant access. Credentials are
                        never shown here.
                      </p>
                    }
                  >
                    <Show when={latest()?.content.authentication === "bearer"}>
                      <label>
                        Read-only access token
                        <input
                          type="password"
                          autocomplete="off"
                          value={token()}
                          onInput={(event) => setToken(event.currentTarget.value)}
                        />
                      </label>
                    </Show>
                    <div class="mcp-actions">
                      <button
                        type="button"
                        class={
                          props.monitoringSetup && item().connection?.state === "ready"
                            ? "quiet-button"
                            : "primary-button"
                        }
                        disabled={busy() || setupBlocked()}
                        onClick={() => void connect()}
                      >
                        {item().connection ? "Reconnect" : "Connect"}
                      </button>
                      <Show when={item().connection && item().connection?.state !== "revoked"}>
                        <button
                          type="button"
                          class="quiet-button"
                          disabled={busy() || setupBlocked()}
                          onClick={() =>
                            void mutate(
                              () => serverCall(disconnectMCP({ data: [item().id] })),
                              "Connection disconnected. Further MCP lookups are blocked.",
                            )
                          }
                        >
                          Disconnect
                        </button>
                      </Show>
                    </div>
                    <Show when={authorization()}>
                      {(url) => (
                        <p>
                          <a href={url()} target="_blank" rel="noopener noreferrer">
                            Continue sign-in
                          </a>{" "}
                          ·{" "}
                          <button
                            type="button"
                            class="quiet-button"
                            onClick={() =>
                              void mutate(
                                () => load(props.projectId),
                                "Connection status refreshed.",
                              )
                            }
                          >
                            Refresh status
                          </button>
                        </p>
                      )}
                    </Show>
                    <Show when={item().connection?.state === "authorizing"}>
                      <p>Finish sign-in in the provider tab, then return here to review access.</p>
                    </Show>
                  </Show>
                </section>
                <Show
                  when={
                    item().editable &&
                    item().connection &&
                    ["review", "ready"].includes(item().connection?.state ?? "") &&
                    (!props.monitoringSetup || item().connection?.state === "review")
                  }
                >
                  <section class="mcp-tool-review" aria-label="Read-only tool review">
                    <h4>Review read-only access</h4>
                    <p>
                      Approve only tools you have checked. Server hints are suggestions, not proof.
                      Use a provider account whose permissions are limited to reading.
                    </p>
                    <For each={item().connection?.tools}>
                      {(tool) => (
                        <div class="mcp-tool">
                          <label class="mcp-checkbox">
                            <input
                              type="checkbox"
                              checked={allowed().includes(tool.name)}
                              onChange={(event) => {
                                setAllowed(
                                  event.currentTarget.checked
                                    ? [...allowed(), tool.name]
                                    : allowed().filter((name) => name !== tool.name),
                                );
                                setConfirmed(false);
                              }}
                            />
                            {tool.name}
                          </label>
                          <p>{tool.description}</p>
                          <small>
                            {tool.readOnlyHint
                              ? "Server declares read-only"
                              : "No read-only declaration"}
                          </small>
                          <details>
                            <summary>Input schema</summary>
                            <pre>{JSON.stringify(tool.inputSchema, null, 2)}</pre>
                          </details>
                        </div>
                      )}
                    </For>
                    <label class="mcp-checkbox">
                      <input
                        type="checkbox"
                        checked={confirmed()}
                        onChange={(event) => setConfirmed(event.currentTarget.checked)}
                      />
                      I verified the selected tools and provider access are read-only.
                    </label>
                    <button
                      type="button"
                      class="primary-button"
                      disabled={busy() || setupBlocked() || !confirmed() || !allowed().length}
                      onClick={() => {
                        const selected = item();
                        const connection = selected.connection;
                        if (!connection) return;
                        void mutate(
                          () =>
                            serverCall(
                              reviewMCPAccess({
                                data: [
                                  selected.id,
                                  {
                                    expectedVersion: connection.version,
                                    confirmReadOnlyAccess: true,
                                    tools: connection.tools
                                      .filter((tool) => allowed().includes(tool.name))
                                      .map(({ name, digest }) => ({ name, digest })),
                                  },
                                ],
                              }),
                            ),
                          props.monitoringSetup
                            ? "Read-only access approved. Continue to the Input."
                            : "Read-only access approved. Choose where to enable this connection.",
                        );
                      }}
                    >
                      Approve read-only access
                    </button>
                  </section>
                </Show>
                <Show
                  when={
                    item().editable &&
                    item().scope === "system" &&
                    item().connection &&
                    props.projectId
                  }
                >
                  <section class="mcp-grants" aria-label="Project connection access">
                    <h4>Access for {props.projectName ?? "this Project"}</h4>
                    <p>
                      Granting access permits this Project to read the data available to this
                      connection. It does not copy credentials.
                    </p>
                    <button
                      type="button"
                      class="quiet-button"
                      disabled={
                        busy() ||
                        setupBlocked() ||
                        (item().connection?.state !== "ready" &&
                          !item().connection?.projectGrants.includes(props.projectId ?? ""))
                      }
                      onClick={() => {
                        const selected = item();
                        const connection = selected.connection;
                        const projectId = props.projectId;
                        if (!connection || !projectId) return;
                        void mutate(
                          () =>
                            serverCall(
                              grantMCPProject({
                                data: [
                                  selected.id,
                                  {
                                    projectId,
                                    expectedVersion: connection.version,
                                    enabled: !connection.projectGrants.includes(projectId),
                                  },
                                ],
                              }),
                            ),
                          "Project connection access updated.",
                        );
                      }}
                    >
                      {item().connection?.projectGrants.includes(props.projectId ?? "")
                        ? "Revoke Project access"
                        : "Grant Project access"}
                    </button>
                  </section>
                </Show>
                <Show when={props.monitoringSetup}>
                  <section class="mcp-monitoring-next" aria-label="Continue Input setup">
                    <h4>Continue setting up your Input</h4>
                    <Show when={item().connection?.state === "ready"}>
                      <p>Read-only access approved.</p>
                    </Show>
                    <p>
                      This connection supplies context for incoming requests and their
                      implementation. The Input's task and approval settings remain separate.
                    </p>
                    <Show
                      when={
                        !latest()?.content.roles.includes("planning") ||
                        !latest()?.content.roles.includes("build")
                      }
                    >
                      <p>
                        This source must be available for both Investigate &amp; Plan and Build.
                      </p>
                    </Show>
                    <Show
                      when={
                        item().scope === "system" &&
                        !item().connection?.projectGrants.includes(props.projectId ?? "")
                      }
                    >
                      <p>Grant this Project access above before continuing.</p>
                    </Show>
                    <button
                      type="button"
                      class="primary-button"
                      disabled={
                        busy() ||
                        setupBlocked() ||
                        !monitoringSourceAvailable(item(), props.projectId ?? "")
                      }
                      onClick={() => props.onMonitoringReturn?.(item().id)}
                    >
                      Use for Input
                    </button>
                  </section>
                </Show>
                <section
                  class="skill-availability"
                  aria-label="MCP availability"
                  hidden={Boolean(props.monitoringSetup)}
                >
                  <h4>
                    {scope() === "personal"
                      ? `For you${props.projectName ? ` in ${props.projectName}` : ""}`
                      : scope() === "project"
                        ? `Defaults for ${props.projectName ?? "this Project"}`
                        : "Defaults for everyone in Factory"}
                  </h4>
                  <Show when={!props.projectId && scope() !== "system"}>
                    <p>
                      Select a Project to enable connections. Your personal library spans Projects.
                    </p>
                  </Show>
                  <For each={latest()?.content.roles}>
                    {(role) => {
                      const effective = () =>
                        resolveMCPChoice(view()?.choices ?? [], item().id, role);
                      const own = () =>
                        view()?.choices.find(
                          (choice) =>
                            choice.libraryId === item().id &&
                            choice.role === role &&
                            choice.scope === scope(),
                        );
                      const locked = () =>
                        effective()?.state === "required" && effective()?.scope !== scope();
                      const choiceLabel = () => {
                        const choice = effective();
                        if (!choice) return "Off until enabled";
                        return locked()
                          ? `Required by ${scopeLabel(choice.scope)} policy`
                          : `${choice.state === "disable" ? "Off" : "Enabled"} by ${scopeLabel(choice.scope)} choice`;
                      };
                      const activationBlock = () => {
                        if (item().connection?.state !== "ready")
                          return "Connect and approve read-only access before enabling.";
                        if (item().connection?.revisionId !== latest()?.id)
                          return "Connect and review this definition version before enabling.";
                        if (
                          scope() !== "system" &&
                          item().scope === "system" &&
                          props.projectId &&
                          !item().connection?.projectGrants.includes(props.projectId)
                        )
                          return "Grant this Project access before enabling.";
                        return "";
                      };
                      return (
                        <div class="skill-choice">
                          <label>
                            {roleLabel(role)} choice
                            <select
                              aria-label={`${latest()?.content.name} ${roleLabel(role)} choice`}
                              disabled={
                                busy() || locked() || (!props.projectId && scope() !== "system")
                              }
                              value={own()?.state ?? "inherit"}
                              onChange={(event) =>
                                void choose(
                                  item(),
                                  role,
                                  event.currentTarget.value as MCPChoice["state"],
                                )
                              }
                            >
                              <option value="inherit">Inherit</option>
                              <option value="enable" disabled={Boolean(activationBlock())}>
                                Enable
                              </option>
                              <option value="disable">Disable</option>
                              <Show when={scope() !== "personal"}>
                                <option value="required" disabled={Boolean(activationBlock())}>
                                  Required
                                </option>
                              </Show>
                            </select>
                            <small>{choiceLabel()}</small>
                            <Show when={activationBlock()}>
                              <small>{activationBlock()}</small>
                            </Show>
                          </label>
                          <Show
                            when={
                              !locked() &&
                              effective() &&
                              effective()?.revisionId !== latest()?.id &&
                              item().connection?.revisionId === latest()?.id &&
                              item().connection?.state === "ready"
                            }
                          >
                            <button
                              type="button"
                              class="quiet-button"
                              disabled={busy() || Boolean(activationBlock())}
                              onClick={() =>
                                void choose(
                                  item(),
                                  role,
                                  scope() !== "personal" && own()?.state === "required"
                                    ? "required"
                                    : "enable",
                                )
                              }
                            >
                              Use connected v{latest()?.revision} for new work
                            </button>
                          </Show>
                        </div>
                      );
                    }}
                  </For>
                  <p class="skill-help">
                    Choices apply to new work. Access revocation takes effect immediately. Personal
                    results used here become visible in shared Project work.
                  </p>
                </section>
                <Show when={item().revisions.length > 1}>
                  <details class="skill-version-history">
                    <summary>Definition history</summary>
                    <For each={item().revisions}>
                      {(revision) => (
                        <section>
                          <h4>
                            v{revision.revision} · {revision.content.name}
                          </h4>
                          <p>{revision.content.description}</p>
                          <p class="mcp-endpoint">{revision.content.endpoint}</p>
                          <p>
                            {revision.content.authentication} ·{" "}
                            {revision.content.roles.map(roleLabel).join(", ")}
                          </p>
                        </section>
                      )}
                    </For>
                  </details>
                </Show>
                <Show
                  when={
                    !props.monitoringSetup && item().scope === "personal" && scope() === "personal"
                  }
                >
                  <details class="skill-sharing">
                    <summary>Share this MCP definition</summary>
                    <p>
                      Propose the displayed version for manager review. Your credentials and other
                      private versions stay private.
                    </p>
                    <label>
                      Share with
                      <select
                        value={props.projectId ? shareTarget() : "system"}
                        onChange={(event) =>
                          setShareTarget(event.currentTarget.value as "project" | "system")
                        }
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
                      disabled={busy()}
                      onClick={() => {
                        const revision = latest();
                        if (!revision) return;
                        void mutate(
                          () =>
                            serverCall(
                              proposeMCPSharing({
                                data: [
                                  {
                                    id: crypto.randomUUID(),
                                    revisionId: revision.id,
                                    target: props.projectId ? shareTarget() : "system",
                                    ...(props.projectId && shareTarget() === "project"
                                      ? { projectId: props.projectId }
                                      : {}),
                                  },
                                ],
                              }),
                            ),
                          "Definition proposed for manager review. No credentials were shared.",
                        );
                      }}
                    >
                      Propose shared definition
                    </button>
                  </details>
                </Show>
              </section>
            )}
          </Show>
        </div>
      </div>
    </div>
  );
}
