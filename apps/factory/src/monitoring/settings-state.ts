import { createEffect, createMemo, createSignal, untrack } from "solid-js";
import { resolveMCPChoice } from "#conversation-domain/mcp-library";
import { monitoringSave } from "#conversation-domain/monitoring";
import { APIRequestError } from "../api-client";
import { plainErrorMessage } from "../command-error";
import {
  disableProjectInput,
  rotateProjectInput,
  saveProjectInput,
} from "../server-functions/inputs";
import { serverCall } from "../server-functions/result";
import { createInputReads } from "./reads";
import {
  createMonitoringDraft,
  type MonitoringCommandState,
  type MonitoringDraft,
  type MonitoringHook,
  type MonitoringOperation,
  type MonitoringScreen,
  monitoringSaveNotice,
  resolveMonitoringSourceName,
} from "./settings-types";
import { monitoringSourceAvailable } from "./sources";

export function createMonitoringSettingsState(props: {
  active: boolean;
  project: { id: string; name: string } | undefined;
  sourceRequest?: { id: string; projectId: string; connectionId: string } | undefined;
}) {
  const isActive = createMemo(() => props.active);
  const reads = createInputReads(() => props.project?.id, isActive);
  const [screen, setScreen] = createSignal<MonitoringScreen>({ kind: "list" });
  const [command, setCommand] = createSignal<MonitoringCommandState>({ kind: "idle" });

  const refs: {
    editorHeading?: HTMLHeadingElement;
    setupHeading?: HTMLHeadingElement;
    rotationHeading?: HTMLHeadingElement;
    addButton?: HTMLButtonElement;
  } = {};
  let handledSource: string | undefined;

  const view = reads.view;
  const loading = reads.loading;
  const readError = reads.error;
  const load = () => reads.reload();

  const running = () => command().kind === "running";
  const retryable = () => {
    const current = command();
    return current.kind === "failed" ? current.retryable : undefined;
  };
  const blocked = () => running() || Boolean(retryable());
  const error = () => {
    const current = command();
    return current.kind === "failed" ? current.message : "";
  };
  const notice = () => {
    const current = command();
    return current.kind === "idle" ? (current.notice ?? "") : "";
  };

  const editState = () => {
    const current = screen();
    return current.kind === "edit" ? current : undefined;
  };
  const draft = () => editState()?.draft;

  const sources = () => reads.sources()?.entries ?? [];
  const available = () =>
    sources().filter((entry) => monitoringSourceAvailable(entry, props.project?.id ?? ""));
  const inherited = () =>
    available().filter((entry) => {
      const choice = resolveMCPChoice(reads.sources()?.choices ?? [], entry.id, "planning", false);
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
  const editable = () => Boolean(view()?.canManage && !blocked() && draftHere());
  const canSave = () =>
    editable() &&
    Boolean(draft()?.input.name.trim()) &&
    Boolean(draft()?.input.instructions.trim()) &&
    selectedIds().every((id) => available().some((source) => source.id === id)) &&
    (!automatic() ||
      Boolean(view()?.canDelegate && selected().length && editState()?.confirmedBasis === basis()));
  const sourceName = (id: string) => resolveMonitoringSourceName(sources(), id);

  createEffect(
    () => ({ project: props.project, active: isActive() }),
    () => {
      setScreen((current) => (current.kind === "edit" ? current : { kind: "list" }));
      setCommand((current) =>
        current.kind === "running"
          ? current
          : current.kind === "failed" && current.retryable
            ? { kind: "failed", message: "", retryable: current.retryable }
            : { kind: "idle" },
      );
    },
  );

  createEffect(
    () => ({
      request: props.sourceRequest,
      active: props.active,
      projectId: props.project?.id,
      ready: available().some((entry) => entry.id === props.sourceRequest?.connectionId),
      canManage: view()?.canManage,
      blocked: blocked(),
    }),
    ({ request, active, projectId, ready, canManage, blocked: isBlocked }) => {
      if (
        !request ||
        request.id === handledSource ||
        !active ||
        request.projectId !== projectId ||
        !ready ||
        !canManage ||
        isBlocked
      )
        return;
      handledSource = request.id;
      // This explicit return from MCP applies once to the current editable draft.
      untrack(() => {
        if (!draftHere()) {
          edit(undefined, request.connectionId);
        } else {
          change({ connectionIds: [...new Set([...selectedIds(), request.connectionId])] });
          setSourcePickerOpen(false);
        }
      });
      requestAnimationFrame(() => refs.editorHeading?.focus({ preventScroll: true }));
    },
  );

  function edit(hook?: MonitoringHook, connectionId?: string) {
    const project = props.project;
    if (!project || !view()?.canManage || blocked()) return;
    setCommand({ kind: "idle" });
    setScreen({
      kind: "edit",
      confirmedBasis: "",
      sourcePickerOpen: false,
      draft: createMonitoringDraft(project, hook, connectionId),
    });
    requestAnimationFrame(() => refs.editorHeading?.focus({ preventScroll: true }));
  }

  function change(patch: Partial<MonitoringDraft["input"]>) {
    if (!editable()) return;
    setScreen((current) =>
      current.kind === "edit"
        ? {
            ...current,
            confirmedBasis: "",
            draft: {
              ...current.draft,
              input: { ...current.draft.input, ...patch, commandId: crypto.randomUUID() },
            },
          }
        : current,
    );
  }

  function toggleSource(id: string) {
    change({
      connectionIds: selectedIds().includes(id)
        ? selectedIds().filter((value) => value !== id)
        : [...selectedIds(), id],
    });
  }

  function setSourcePickerOpen(open: boolean) {
    setScreen((current) =>
      current.kind === "edit" ? { ...current, sourcePickerOpen: open } : current,
    );
  }

  function setConfirmedBasis(value: string) {
    setScreen((current) =>
      current.kind === "edit" ? { ...current, confirmedBasis: value } : current,
    );
  }

  function cancelEdit() {
    setScreen({ kind: "list" });
    requestAnimationFrame(() => refs.addButton?.focus());
  }

  function openRotation(hook: MonitoringHook) {
    setScreen({ kind: "list", rotatingHook: hook });
    requestAnimationFrame(() => refs.rotationHeading?.focus());
  }

  function closeRotation() {
    setScreen({ kind: "list" });
  }

  function toggleSecretReveal() {
    setScreen((current) =>
      current.kind === "secret" ? { ...current, revealed: !current.revealed } : current,
    );
  }

  function dismissSecret() {
    setScreen({ kind: "list" });
    requestAnimationFrame(() => refs.addButton?.focus({ preventScroll: true }));
  }

  async function execute(operation: MonitoringOperation) {
    if (running() || operation.projectId !== props.project?.id) return;
    setCommand({ kind: "running", operation });
    try {
      const value = await serverCall(
        operation.action === "save"
          ? saveProjectInput({ data: [operation.projectId, operation.input] })
          : operation.action === "disable"
            ? disableProjectInput({ data: [operation.projectId, operation.id, operation.input] })
            : rotateProjectInput({ data: [operation.projectId, operation.id, operation.input] }),
      );
      if (operation.projectId !== props.project?.id) {
        setCommand({ kind: "idle" });
        return;
      }
      setScreen(
        value.url
          ? {
              kind: "secret",
              projectId: operation.projectId,
              url: value.url,
              rotated: operation.action === "rotate",
              revealed: false,
            }
          : { kind: "list" },
      );
      await load();
      setCommand(
        operation.projectId === props.project?.id
          ? { kind: "idle", notice: operation.notice }
          : { kind: "idle" },
      );
      if (value.url) requestAnimationFrame(() => refs.setupHeading?.focus({ preventScroll: true }));
    } catch (cause) {
      const retryableOp =
        cause instanceof APIRequestError && cause.status < 500 ? undefined : operation;
      const message =
        cause instanceof Error
          ? plainErrorMessage(cause.message)
          : "The Input command could not be confirmed.";
      if (operation.projectId === props.project?.id) {
        await load();
        if (operation.projectId === props.project?.id) {
          setCommand({
            kind: "failed",
            message,
            ...(retryableOp ? { retryable: retryableOp } : {}),
          });
          return;
        }
      }
      setCommand(
        retryableOp ? { kind: "failed", message: "", retryable: retryableOp } : { kind: "idle" },
      );
    }
  }

  function save(event: SubmitEvent) {
    event.preventDefault();
    const current = draft();
    if (!current || !canSave()) return;
    const existing = view()?.hooks.find((item) => item.id === current.input.id);
    void execute({
      projectId: current.projectId,
      projectName: current.projectName,
      action: "save",
      input: monitoringSave.parse(current.input),
      notice: monitoringSaveNotice(current.input.expectedVersion, existing?.enabled ?? false),
    });
  }

  function act(hook: MonitoringHook, action: "disable" | "rotate") {
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

  return {
    view,
    loading,
    readError,
    load,
    screen,
    editState,
    running,
    retryable,
    blocked,
    error,
    notice,
    available,
    inherited,
    selectedIds,
    selected,
    automatic,
    basis,
    draftHere,
    editable,
    canSave,
    sourceName,
    edit,
    change,
    toggleSource,
    setSourcePickerOpen,
    setConfirmedBasis,
    cancelEdit,
    openRotation,
    closeRotation,
    toggleSecretReveal,
    dismissSecret,
    execute,
    save,
    act,
    refs,
  };
}

export type MonitoringSettingsState = ReturnType<typeof createMonitoringSettingsState>;
