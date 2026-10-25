import { children, createEffect, createMemo, createSignal, For, Show } from "solid-js";
import type { JSX } from "@solidjs/web";
import { z } from "zod";
import {
  type MCPLibraryView,
  resolveMCPChoice,
} from "../../../../packages/conversation-domain/src/mcp-library";
import {
  defaultInputInstructions,
  monitoringSave,
  type monitoringChange,
  monitoringView,
} from "../../../../packages/conversation-domain/src/monitoring";
import { APIRequestError } from "../api-client";
import { serverCall } from "../server-functions/result";
import { getMCPLibrary } from "../server-functions/mcp";
import {
  getProjectInputs,
  saveProjectInput,
  disableProjectInput,
  rotateProjectInput,
} from "../server-functions/inputs";
import { Icon } from "../icon";
import { bindPopoverKeyboard } from "../popover-keyboard";
import { CopyButton } from "../ui/feedback";
import { WorkspaceActionBar } from "../ui/workspace-actions";
import { monitoringSourceAvailable } from "./sources";
import "./settings.css";

type View = z.infer<typeof monitoringView>;
type Hook = View["hooks"][number];
type Draft = { projectId: string; projectName: string; input: z.infer<typeof monitoringSave> };
type Operation = {
  projectId: string;
  projectName: string;
  notice: string;
} & (
  | { action: "save"; input: z.output<typeof monitoringSave> }
  | { action: "disable" | "rotate"; id: string; input: z.output<typeof monitoringChange> }
);
const stateLabel: Record<View["incidents"][number]["state"], string> = {
  queued: "Queued",
  diagnosing: "Preparing requirements",
  prepared: "Ticket prepared",
  "insufficient-context": "More context needed",
  "not-application-defect": "No application fix",
  implementing: "Fix in progress",
  delivered: "Delivered",
  blocked: "Needs attention",
  uncertain: "Outcome unknown",
};
const payloadExample = JSON.stringify(
  {
    id: "request-42",
    title: "Make invoice exports easier to find",
    description: "People cannot find the export action from the invoice list.",
    context: { source: "Product feedback" },
  },
  null,
  2,
);

function InputActions(props: { name: string; children: JSX.Element }) {
  const content = children(() => props.children);
  const [open, setOpen] = createSignal(false);
  let root!: HTMLDetailsElement;
  let opener!: HTMLElement;
  let panel!: HTMLDivElement;
  const close = () => {
    root.open = false;
    setOpen(false);
  };
  createEffect(
    () => undefined,
    () => {
      const keydown = (event: KeyboardEvent) => {
        if (event.key === "ArrowDown") {
          event.preventDefault();
          root.open = true;
          setOpen(true);
        } else if (event.key === "Escape") {
          event.preventDefault();
          close();
        }
      };
      opener.addEventListener("keydown", keydown);
      return () => opener.removeEventListener("keydown", keydown);
    },
  );
  createEffect(open, (shown) => {
    if (!shown) return;
    const position = () => {
      const bounds = root.closest(".settings-content")?.getBoundingClientRect();
      const anchor = opener.getBoundingClientRect();
      const below = (bounds?.bottom ?? innerHeight) - anchor.bottom - 8;
      const above = anchor.top - (bounds?.top ?? 0) - 8;
      const opensAbove = below < panel.scrollHeight && above > below;
      panel.style.top = opensAbove ? "auto" : "calc(100% + 4px)";
      panel.style.bottom = opensAbove ? "calc(100% + 4px)" : "auto";
      panel.style.maxHeight = `${Math.max(44, opensAbove ? above : below)}px`;
    };
    position();
    window.addEventListener("resize", position);
    window.addEventListener("scroll", position, true);
    const outside = (event: PointerEvent) => {
      if (!root.contains(event.target as Node)) close();
    };
    const choose = (event: MouseEvent) => {
      if ((event.target as HTMLElement).closest("button:not(:disabled)")) {
        close();
        opener.focus({ preventScroll: true });
      }
    };
    document.addEventListener("pointerdown", outside);
    panel.addEventListener("click", choose);
    const dispose = bindPopoverKeyboard(panel, opener, close);
    return () => {
      document.removeEventListener("pointerdown", outside);
      panel.removeEventListener("click", choose);
      window.removeEventListener("resize", position);
      window.removeEventListener("scroll", position, true);
      dispose();
    };
  });
  return (
    <details
      class="input-row-menu"
      ref={root}
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary
        class="workspace-action workspace-menu-trigger"
        ref={opener}
        aria-label={`Actions for ${props.name}`}
      >
        <Icon name="more" />
      </summary>
      <div ref={panel}>{content()}</div>
    </details>
  );
}

export function MonitoringSettings(props: {
  active: boolean;
  project: { id: string; name: string } | undefined;
  onOpenMCP(): void;
  navigation?: JSX.Element;
  sourceRequest?: { id: string; projectId: string; connectionId: string } | undefined;
  onOpenTicket?: ((id: string, projectId: string) => void) | undefined;
}) {
  const isActive = createMemo(() => props.active);
  const [loaded, setLoaded] = createSignal<{
    projectId: string;
    view: View;
    sources: MCPLibraryView;
  }>();
  const [draft, setDraft] = createSignal<Draft>();
  const [confirmed, setConfirmed] = createSignal("");
  const [busy, setBusy] = createSignal(false);
  const [loading, setLoading] = createSignal(false);
  const [readError, setReadError] = createSignal("");
  const [error, setError] = createSignal("");
  const [notice, setNotice] = createSignal("");
  const [pending, setPending] = createSignal<Operation>();
  const [rotation, setRotation] = createSignal<Hook>();
  const [secret, setSecret] = createSignal<{ projectId: string; url: string; rotated: boolean }>();
  const [revealed, setRevealed] = createSignal(false);
  const [picking, setPicking] = createSignal(false);
  let reads = 0;
  let heading: HTMLHeadingElement | undefined;
  let setupHeading: HTMLHeadingElement | undefined;
  let rotationHeading: HTMLHeadingElement | undefined;
  let addButton: HTMLButtonElement | undefined;
  const sourcesHelpId = `input-sources-${crypto.randomUUID()}`;
  const view = () => (loaded()?.projectId === props.project?.id ? loaded()?.view : undefined);
  const sources = () =>
    loaded()?.projectId === props.project?.id ? (loaded()?.sources.entries ?? []) : [];
  const available = () =>
    sources().filter((entry) => monitoringSourceAvailable(entry, props.project?.id ?? ""));
  const inherited = () =>
    available().filter((entry) => {
      const choice = resolveMCPChoice(loaded()?.sources.choices ?? [], entry.id, "planning", false);
      return (
        choice && choice.state !== "disable" && choice.revisionId === entry.connection?.revisionId
      );
    });
  const selectedIds = () => draft()?.input.connectionIds ?? [];
  const selected = () =>
    selectedIds().length
      ? available().filter((source) => selectedIds().includes(source.id))
      : inherited();
  const automatic = () => draft()?.input.delegation === "application-fix-and-delivery";
  const basis = () =>
    JSON.stringify({
      project: draft()?.projectId,
      input: draft()?.input,
      sources: selected().map((source) => [source.id, source.connection?.version]),
    });
  const draftHere = () => draft()?.projectId === props.project?.id;
  const editable = () => Boolean(view()?.canManage && !busy() && !pending() && draftHere());
  const canSave = () =>
    editable() &&
    Boolean(draft()?.input.name.trim()) &&
    Boolean(draft()?.input.instructions.trim()) &&
    selectedIds().every((id) => available().some((source) => source.id === id)) &&
    (!automatic() || Boolean(view()?.canDelegate && selected().length && confirmed() === basis()));
  const sourceName = (id: string) => {
    const source = sources().find((entry) => entry.id === id);
    return (
      source?.revisions.find((revision) => revision.id === source.connection?.revisionId)?.content
        .name ??
      source?.revisions[0]?.content.name ??
      "Unavailable source"
    );
  };
  const blocked = () => busy() || Boolean(pending());

  async function load(quiet = false) {
    const project = props.project;
    if (!project || !isActive()) return;
    const sequence = ++reads;
    if (!quiet) setLoading(true);
    try {
      const [view, sources] = await Promise.all([
        serverCall(getProjectInputs(project.id)),
        serverCall(getMCPLibrary(project.id)),
      ]);
      if (sequence !== reads || project.id !== props.project?.id || !isActive()) return;
      const next = { projectId: project.id, view, sources };
      if (JSON.stringify(loaded()) !== JSON.stringify(next)) setLoaded(next);
      setReadError("");
    } catch (cause) {
      if (sequence === reads && project.id === props.project?.id && isActive())
        setReadError(cause instanceof Error ? cause.message : "Inputs could not load.");
    } finally {
      if (sequence === reads) setLoading(false);
    }
  }
  createEffect(
    () => ({ id: props.project?.id, active: isActive() }),
    ({ active }) => {
      setRotation(undefined);
      setSecret(undefined);
      setRevealed(false);
      setNotice("");
      reads++;
      if (!active) return;
      setError("");
      setReadError("");
      void load();
      let refreshing = false;
      const timer = setInterval(() => {
        if (refreshing || busy() || document.visibilityState !== "visible") return;
        refreshing = true;
        void load(true).finally(() => {
          refreshing = false;
        });
      }, 2_000);
      return () => {
        reads++;
        clearInterval(timer);
      };
    },
  );
  let handledSource: string | undefined;
  createEffect(
    () => ({
      request: props.sourceRequest,
      active: props.active,
      projectId: props.project?.id,
      ready: available().some((entry) => entry.id === props.sourceRequest?.connectionId),
      canManage: view()?.canManage,
      blocked: blocked(),
    }),
    ({ request, active, projectId, ready, canManage, blocked }) => {
      if (
        !request ||
        request.id === handledSource ||
        !active ||
        request.projectId !== projectId ||
        !ready ||
        !canManage ||
        blocked
      )
        return;
      handledSource = request.id;
      if (!draftHere()) edit();
      change({ connectionIds: [...new Set([...selectedIds(), request.connectionId])] });
      setPicking(false);
      requestAnimationFrame(() => heading?.focus({ preventScroll: true }));
    },
  );
  function edit(hook?: Hook) {
    const project = props.project;
    if (!project || !view()?.canManage || blocked()) return;
    setError("");
    setNotice("");
    setRotation(undefined);
    setConfirmed("");
    setPicking(false);
    setDraft({
      projectId: project.id,
      projectName: project.name,
      input: {
        commandId: crypto.randomUUID(),
        id: hook?.id ?? crypto.randomUUID(),
        expectedVersion: hook?.version ?? 0,
        name: hook?.name ?? "",
        instructions: hook?.instructions ?? defaultInputInstructions,
        connectionIds: hook?.connectionIds ?? [],
        enabled: true,
        delegation: hook?.delegation ?? "prepare-ticket",
      },
    });
    requestAnimationFrame(() => heading?.focus({ preventScroll: true }));
  }
  function change(patch: Partial<Draft["input"]>) {
    if (!editable()) return;
    setDraft((current) =>
      current
        ? { ...current, input: { ...current.input, ...patch, commandId: crypto.randomUUID() } }
        : current,
    );
    setConfirmed("");
  }
  function toggleSource(id: string) {
    change({
      connectionIds: selectedIds().includes(id)
        ? selectedIds().filter((value) => value !== id)
        : [...selectedIds(), id],
    });
  }
  function cancel() {
    setDraft(undefined);
    setConfirmed("");
    setPicking(false);
    requestAnimationFrame(() => addButton?.focus());
  }
  async function execute(operation: Operation) {
    if (busy() || operation.projectId !== props.project?.id) return;
    setBusy(true);
    setError("");
    setNotice("");
    setPending(operation);
    try {
      const value = await serverCall(
        operation.action === "save"
          ? saveProjectInput(operation.projectId, operation.input)
          : operation.action === "disable"
            ? disableProjectInput(operation.projectId, operation.id, operation.input)
            : rotateProjectInput(operation.projectId, operation.id, operation.input),
      );
      setPending(undefined);
      if (operation.projectId !== props.project?.id) return;
      setDraft(undefined);
      setRotation(undefined);
      setConfirmed("");
      setSecret(
        value.url
          ? {
              projectId: operation.projectId,
              url: value.url,
              rotated: operation.action === "rotate",
            }
          : undefined,
      );
      setRevealed(false);
      setNotice(operation.notice);
      await load();
      requestAnimationFrame(() => setupHeading?.focus({ preventScroll: true }));
    } catch (cause) {
      if (cause instanceof APIRequestError && cause.status < 500) setPending(undefined);
      if (operation.projectId === props.project?.id) {
        setError(
          cause instanceof Error ? cause.message : "The Input command could not be confirmed.",
        );
        await load(true);
      }
    } finally {
      setBusy(false);
    }
  }
  function save(event: SubmitEvent) {
    event.preventDefault();
    const current = draft();
    if (!current || !canSave()) return;
    void execute({
      projectId: current.projectId,
      projectName: current.projectName,
      action: "save",
      input: monitoringSave.parse(current.input),
      notice: "Input enabled for new requests. Earlier work is not resumed.",
    });
  }
  function act(hook: Hook, action: "disable" | "rotate") {
    const project = props.project;
    if (!project || !view()?.canDisable || blocked()) return;
    void execute({
      projectId: project.id,
      projectName: project.name,
      action,
      id: hook.id,
      input: { commandId: crypto.randomUUID(), expectedVersion: hook.version },
      notice:
        action === "rotate"
          ? "Key rotated and Input disabled. Update the sender, then review and enable this Input."
          : "Input disabled. Pending automatic work is stopped; retained Tickets are unchanged.",
    });
  }
  const lastEvent = (id: string) => view()?.incidents.find((event) => event.hookId === id);
  const time = (value: string) =>
    new Date(value).toLocaleString(undefined, {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  return (
    <section
      class="input-settings model-settings-body"
      aria-label="Project inputs"
      aria-busy={loading() || busy() ? "true" : "false"}
    >
      <Show when={readError()}>
        <div class="input-message input-error" role="alert">
          <p>{readError()}</p>
          <button
            type="button"
            class="workspace-action"
            disabled={blocked()}
            onClick={() => void load()}
          >
            Retry loading inputs
          </button>
        </div>
      </Show>
      <Show when={error()}>
        <p class="input-message input-error" role="alert">
          {error()}
        </p>
      </Show>
      <Show when={busy() || notice()}>
        <p class="input-message input-help" role="status">
          {busy() ? "Saving Input…" : notice()}
        </p>
      </Show>
      <Show when={!busy() && pending()}>
        {(operation) => (
          <div class="input-confirmation">
            <p>
              The result is unconfirmed. Retry the same command in {operation().projectName}; do not
              create a replacement.
            </p>
            <button
              type="button"
              class="workspace-action"
              disabled={operation().projectId !== props.project?.id}
              onClick={() => void execute(operation())}
            >
              Retry same command
            </button>
          </div>
        )}
      </Show>
      <Show when={loading() && !view()}>
        <p role="status">Loading inputs…</p>
      </Show>
      <Show when={secret()?.projectId === props.project?.id && props.active && secret()}>
        {(value) => (
          <section class="input-setup-result" aria-label="New webhook URL">
            <h3
              tabindex="-1"
              ref={(element) => {
                setupHeading = element;
              }}
            >
              {value().rotated
                ? "New key created. Your Input is disabled."
                : "Your Input is ready to receive requests"}
            </h3>
            <p>
              Copy this private URL into your sender's webhook settings. Its key is shown only now.
            </p>
            <div class="input-webhook">
              <label>
                Webhook URL
                <input
                  type={revealed() ? "text" : "password"}
                  readonly
                  value={value().url}
                  autocomplete="off"
                  spellcheck={false}
                />
              </label>
              <div class="input-actions">
                <button
                  type="button"
                  class="workspace-action"
                  onClick={() => setRevealed(!revealed())}
                >
                  {revealed() ? "Hide URL" : "Reveal URL"}
                </button>
                <CopyButton
                  class="workspace-action input-copy-action"
                  label="Copy URL"
                  value={value().url}
                  scope={value().projectId}
                  successMessage="Webhook URL copied. Keep it private."
                  errorMessage="Reveal the URL and copy it manually."
                />
              </div>
            </div>
            <p class="input-help">
              {value().rotated
                ? "Update the sender, then edit this Input to review and enable it. Earlier work is not resumed."
                : "Waiting for the first request. Creating an Input does not call a model; incoming requests do."}
            </p>
            <button
              type="button"
              class="workspace-action"
              onClick={() => {
                setSecret(undefined);
                requestAnimationFrame(() => addButton?.focus({ preventScroll: true }));
              }}
            >
              Back to inputs
            </button>
          </section>
        )}
      </Show>
      <Show when={!secret() && draft()}>
        {(current) => (
          <form class="input-editor" aria-label="Input configuration" onSubmit={save}>
            <header>
              <WorkspaceActionBar
                label="Input editor navigation"
                status={
                  <h3
                    tabindex="-1"
                    ref={(element) => {
                      heading = element;
                    }}
                  >
                    {current().input.expectedVersion ? "Edit input" : "New input"}
                  </h3>
                }
              >
                <button
                  type="button"
                  class="workspace-action"
                  disabled={blocked()}
                  onClick={cancel}
                >
                  Back to inputs
                </button>
              </WorkspaceActionBar>
              <p>
                Give this webhook a task. Factory will clarify incoming requests and prepare
                requirements automatically.
              </p>
            </header>
            <Show when={!draftHere()}>
              <p role="alert">
                This draft belongs to {current().projectName}. Return to that Project to save it.
              </p>
            </Show>
            <fieldset disabled={!editable()}>
              <label>
                Name
                <input
                  required
                  maxlength={100}
                  value={current().input.name}
                  placeholder="Product feedback"
                  onInput={(event) => change({ name: event.currentTarget.value })}
                />
              </label>
              <label>
                Task
                <textarea
                  required
                  rows={5}
                  maxlength={6000}
                  value={current().input.instructions}
                  onInput={(event) => change({ instructions: event.currentTarget.value })}
                />
              </label>
              <fieldset class="input-sources" aria-describedby={sourcesHelpId}>
                <legend>Connected sources</legend>
                <div class="input-chips">
                  <For each={selectedIds()}>
                    {(id) => (
                      <button
                        type="button"
                        class="input-chip"
                        aria-label={`Remove ${sourceName(id)}`}
                        onClick={() => toggleSource(id)}
                      >
                        {sourceName(id)}
                        <Icon name="close" />
                      </button>
                    )}
                  </For>
                  <button
                    type="button"
                    class="workspace-action"
                    aria-expanded={picking() ? "true" : "false"}
                    onClick={() => setPicking(!picking())}
                  >
                    Add source
                  </button>
                </div>
                <Show when={picking()}>
                  <fieldset class="input-source-picker" aria-label="Available shared sources">
                    <For each={available()}>
                      {(source) => (
                        <label>
                          <input
                            type="checkbox"
                            checked={selectedIds().includes(source.id)}
                            onChange={() => toggleSource(source.id)}
                          />
                          <span>
                            {sourceName(source.id)}
                            <small>
                              {source.scope === "system" ? "Factory" : "Project"} connection
                            </small>
                          </span>
                        </label>
                      )}
                    </For>
                    <Show when={!available().length}>
                      <p>No connected shared sources yet.</p>
                    </Show>
                    <button type="button" class="workspace-action" onClick={props.onOpenMCP}>
                      Connect a service
                    </button>
                  </fieldset>
                </Show>
                <p class="input-help" id={sourcesHelpId}>
                  {selectedIds().length
                    ? "Selected sources must be consulted before a Ticket is prepared. They remain available during Build."
                    : inherited().length
                      ? `Following shared Project sources: ${inherited()
                          .map((source) => sourceName(source.id))
                          .join(", ")}.`
                      : "Following shared Project defaults. No external sources are enabled; the payload and Project knowledge supply context."}
                </p>
                <Show
                  when={selectedIds().some((id) => !available().some((source) => source.id === id))}
                >
                  <p class="input-error">
                    A selected source is unavailable. Reconnect it or remove its chip before saving.
                  </p>
                </Show>
              </fieldset>
              <details class="input-advanced" open={automatic()}>
                <summary>Automatic implementation</summary>
                <p>
                  By default, prepared Tickets wait for human approval. You can explicitly delegate
                  bounded application fixes and Delivery.
                </p>
                <label class="input-checkbox">
                  <input
                    type="checkbox"
                    checked={automatic()}
                    disabled={!view()?.canDelegate && !automatic()}
                    onChange={(event) =>
                      change({
                        delegation: event.currentTarget.checked
                          ? "application-fix-and-delivery"
                          : "prepare-ticket",
                      })
                    }
                  />
                  <span>Enable application Autofix and Delivery</span>
                </label>
                <Show when={automatic()}>
                  <p>
                    Only source-grounded application defects are eligible. Verification and
                    independent review remain required. Delivery merges into the configured default
                    branch; it does not deploy to production.
                  </p>
                  <Show when={!selected().length}>
                    <p class="input-error">Connect a read-only source before enabling Autofix.</p>
                  </Show>
                  <label class="input-checkbox">
                    <input
                      type="checkbox"
                      checked={confirmed() === basis()}
                      onChange={(event) => setConfirmed(event.currentTarget.checked ? basis() : "")}
                    />
                    <span>
                      I authorize Factory to implement eligible fixes and deliver them automatically
                      after checks and independent review.
                    </span>
                  </label>
                </Show>
                <Show when={!view()?.canDelegate}>
                  <p>Autofix requires Project management and Developer access.</p>
                </Show>
              </details>
            </fieldset>
            <footer class="input-form-actions">
              <button type="button" class="workspace-action" disabled={blocked()} onClick={cancel}>
                Cancel
              </button>
              <button type="submit" class="primary-button" disabled={!canSave()}>
                {current().input.expectedVersion ? "Save & enable" : "Create input"}
              </button>
            </footer>
          </form>
        )}
      </Show>
      <Show when={!draft() && !secret() && view()}>
        {(current) => (
          <>
            <header class="input-overview-heading workspace-heading">
              <div class="workspace-heading-title">
                <h2 class="input-wide-title">Inputs</h2>
                <div class="workspace-action-leading">{props.navigation}</div>
              </div>
              <WorkspaceActionBar label="Input actions">
                <Show when={current().canManage}>
                  <button
                    ref={(element) => {
                      addButton = element;
                    }}
                    type="button"
                    class="workspace-action"
                    data-primary="true"
                    disabled={blocked()}
                    onClick={() => edit()}
                  >
                    Add input
                  </button>
                </Show>
              </WorkspaceActionBar>
              <div class="workspace-heading-meta">
                <p>
                  Turn external requests into grounded Tickets. Sources and tasks stay scoped to
                  this Project.
                </p>
              </div>
            </header>
            <Show when={!current().canManage}>
              <p class="input-help">
                Project managers configure Inputs. You can inspect received requests and prepared
                Tickets.
              </p>
            </Show>
            <section class="input-list" aria-label="Configured inputs">
              <Show when={!current().hooks.length}>
                <div class="input-empty">
                  <h3>Give external requests a place to land</h3>
                  <p>
                    Create a named webhook for feedback, monitoring alerts or your own agent.
                    Factory clarifies requests; implementation still requires approval unless
                    explicitly delegated.
                  </p>
                </div>
              </Show>
              <For each={current().hooks} keyed={(hook) => hook.id}>
                {(hook) => (
                  <article class="input-row" aria-label={`${hook().name} input`}>
                    <div class="input-row-main">
                      <div>
                        <div class="input-row-title">
                          <h3>{hook().name}</h3>
                          <span
                            class="input-state"
                            data-state={
                              !hook().enabled
                                ? "disabled"
                                : hook().delegationCurrent
                                  ? "enabled"
                                  : "attention"
                            }
                          >
                            {!hook().enabled
                              ? "Disabled"
                              : hook().delegationCurrent
                                ? "Enabled"
                                : "Needs attention"}
                          </span>
                        </div>
                        <p class="input-help">
                          {hook().sourceIds.length
                            ? hook().sourceIds.map(sourceName).join(" · ")
                            : "Project context"}
                          {" · "}
                          {hook().delegation === "prepare-ticket"
                            ? "Human approval to implement"
                            : "Autofix & Delivery delegated"}
                        </p>
                        <p class="input-help">
                          {lastEvent(hook().id)
                            ? `Last received ${time(lastEvent(hook().id)!.lastSeenAt)}`
                            : "Waiting for the first request"}
                        </p>
                      </div>
                      <Show when={current().canDisable}>
                        <InputActions name={hook().name}>
                          <Show when={current().canManage}>
                            <button
                              type="button"
                              class="quiet-button"
                              disabled={blocked()}
                              onClick={() => edit(hook())}
                            >
                              Edit input
                            </button>
                          </Show>
                          <button
                            type="button"
                            class="quiet-button"
                            disabled={!hook().enabled || blocked()}
                            onClick={() => act(hook(), "disable")}
                          >
                            Disable input
                          </button>
                          <button
                            type="button"
                            class="quiet-button"
                            disabled={blocked()}
                            onClick={() => {
                              setRotation(hook());
                              requestAnimationFrame(() => rotationHeading?.focus());
                            }}
                          >
                            Rotate key…
                          </button>
                        </InputActions>
                      </Show>
                    </div>
                    <Show when={hook().enabled && !hook().delegationCurrent}>
                      <p class="input-error">
                        Source access or authority changed. Review this Input before enabling new
                        work.
                      </p>
                    </Show>
                    <details class="input-row-details">
                      <summary>
                        <Icon name="chevron" />
                        Task & webhook details
                      </summary>
                      <div class="input-detail-content">
                        <section>
                          <h4>Task</h4>
                          <p class="input-task">{hook().instructions}</p>
                          <p class="input-help">
                            {hook().delegation === "prepare-ticket"
                              ? "Prepared Tickets require human implementation approval."
                              : "Bounded Autofix and Delivery are explicitly delegated."}
                          </p>
                        </section>
                        <section class="input-payload">
                          <h4>What to send</h4>
                          <p>
                            POST a JSON object to the private URL. Use a stable id or fingerprint
                            for repeated deliveries. Remove secrets and personal data before
                            sending.
                          </p>
                          <pre>
                            <code>{payloadExample}</code>
                          </pre>
                          <p>
                            Native alert JSON is also accepted. This receives requests, not an
                            OpenTelemetry stream. URL keys authorize work and must stay out of logs
                            and repositories.
                          </p>
                        </section>
                      </div>
                    </details>
                    <Show when={rotation()?.id === hook().id}>
                      <div class="input-confirmation">
                        <h4
                          tabindex="-1"
                          ref={(element) => {
                            rotationHeading = element;
                          }}
                        >
                          Rotate key for {hook().name}?
                        </h4>
                        <p>
                          The old URL will stop working. Rotation disables this Input and stops
                          pending automatic work. Retained Tickets and accepted merges are not
                          undone.
                        </p>
                        <div class="input-actions">
                          <button
                            type="button"
                            class="workspace-action"
                            disabled={busy()}
                            onClick={(event) => {
                              const opener = event.currentTarget
                                .closest(".input-row")
                                ?.querySelector<HTMLElement>(".input-row-menu > summary");
                              setRotation(undefined);
                              opener?.focus({ preventScroll: true });
                            }}
                          >
                            Cancel rotation
                          </button>
                          <button
                            type="button"
                            class="danger-button"
                            disabled={blocked()}
                            onClick={() => act(hook(), "rotate")}
                          >
                            Rotate key and disable
                          </button>
                        </div>
                      </div>
                    </Show>
                  </article>
                )}
              </For>
            </section>
            <section class="input-events" aria-label="Recent input activity">
              <header class="input-section-heading">
                <h3>Recent requests</h3>
              </header>
              <Show when={!current().incidents.length}>
                <p class="input-help">Received requests and their outcomes will appear here.</p>
              </Show>
              <For each={current().incidents} keyed={(event) => event.id}>
                {(event) => (
                  <details class="input-event">
                    <summary>
                      <Icon name="chevron" />
                      <span>
                        <strong>{event().title}</strong>
                        <small>
                          {current().hooks.find((hook) => hook.id === event().hookId)?.name ??
                            "Input"}{" "}
                          · {event().occurrences}{" "}
                          {event().occurrences === 1 ? "delivery" : "deliveries"}
                        </small>
                      </span>
                      <span class="input-state" data-state={event().state}>
                        {stateLabel[event().state]}
                      </span>
                      <time datetime={event().lastSeenAt}>{time(event().lastSeenAt)}</time>
                    </summary>
                    <div class="input-event-content">
                      <Show when={event().reason}>
                        <p>{event().reason}</p>
                      </Show>
                      <Show when={event().ticketId && props.onOpenTicket}>
                        <button
                          type="button"
                          class="workspace-action"
                          onClick={() => {
                            const ticketId = event().ticketId;
                            if (ticketId && props.project)
                              props.onOpenTicket?.(ticketId, props.project.id);
                          }}
                        >
                          Open Ticket
                        </button>
                      </Show>
                      <Show when={event().state === "uncertain"}>
                        <p class="input-help">No automatic model retry was started.</p>
                      </Show>
                    </div>
                  </details>
                )}
              </For>
            </section>
          </>
        )}
      </Show>
    </section>
  );
}
