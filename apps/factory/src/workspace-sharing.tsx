import { createEffect, createSignal, For, Show, untrack } from "solid-js";
import type { WriterView } from "./agent/contracts";
import { plainErrorMessage } from "./command-error";
import { serverCall } from "./server-functions/result";
import { getRuntimeAttempts } from "./server-functions/runtime";
import {
  enableWorkspaceCollaboration,
  getAvailableWorkspaces,
  getWorkspaceCollaboration,
  getWorkspaceSharing,
  getWorkspaceSource,
  inspectWorkspaceSubmission,
  shareWorkspace,
  submitWorkspace,
} from "./server-functions/workspaces";
import { getChangeWriterStatus } from "./server-functions/writer";
import { WorkspaceActionBar } from "./ui/workspace-actions";
import { WindowHeading } from "./workspace-chrome";
import { writerStatusText } from "./writer-status-label";
import "./workspace-sharing.css";

type Available = {
  workspaceID: string;
  ownerID: string | null;
  name: string;
  kind: string;
  collaborative: boolean;
};
type Sharing = {
  workspaceID: string;
  members: {
    userID: string;
    name: string;
    permission: "observe" | "collaborate" | null;
    version: number;
  }[];
};
export function WorkspaceSharingBar(props: {
  projectID: string | undefined;
  workspaceID: string | undefined;
  userID: string;
  onOpen(workspace: Available): Promise<void>;
}) {
  const [available, setAvailable] = createSignal<Available[]>([]);
  const [state, setState] = createSignal<{
    ownerID: string | null;
    kind: string;
    collaborative: boolean;
    participants: { participantID: string; name: string; kind: string }[];
  }>();
  const [sharing, setSharing] = createSignal<Sharing>();
  const [source, setSource] = createSignal<{ state: string; failure: string | null }>();
  const [writer, setWriter] = createSignal<WriterView>();
  const [computeState, setComputeState] = createSignal<string>();
  const [accessError, setAccessError] = createSignal("");
  const [error, setError] = createSignal("");
  const [busy, setBusy] = createSignal(false);
  const [open, setOpen] = createSignal(false);
  const [submitted, setSubmitted] = createSignal("");
  let accessGeneration = 0;
  let accessRead = 0;
  const actionUnavailable = () => {
    if (!props.workspaceID) return "Choose a Workspace to check file access.";
    if (!state()) return "Workspace access is not confirmed. Writing authority has not changed.";
    if (state()?.kind !== "ticket") return "";
    const current = writer();
    if (!current) return "Editing status unavailable. Writing authority has not changed.";
    if (current.stopPending) return "Agent Stop is unconfirmed. Check Stop in this Ticket.";
    if (current.state === "agent" || current.state === "agent-preparing")
      return `${writerStatusText(current)}. Shared editing and submission need a confirmed human writer.`;
    if (current.state === "handoff")
      return "Editing handoff is not confirmed. Writing authority has not changed.";
    if (current.state !== "human" || !current.canWrite)
      return "Take over editing in this Ticket before enabling shared editing or submitting saved source.";
    if (!source())
      return "File access is unavailable. Keep your editor buffer and retry the file access check.";
    if (source()?.state !== "ready" || source()?.failure)
      return computeState() === "starting" || computeState() === "resuming"
        ? "Compute is starting or resuming. File access is not ready; keep your editor buffer."
        : "File access is not ready. The current Source may still be starting or unreachable; keep your editor buffer.";
    return "";
  };
  const submissionUnavailable = () =>
    actionUnavailable() ||
    (computeState() !== "ready"
      ? "The Ticket Workspace must be running before submitting saved source. Starting compute is a separate action."
      : "");
  let submission:
    | {
        requestID: string;
        workspaceID: string;
        expectedHead: string;
        expectedRemoteHead: string;
        message: string;
      }
    | undefined;
  let dialog: HTMLDialogElement | undefined, opener: HTMLButtonElement | undefined;
  async function refresh() {
    const [projectID, workspaceID] = untrack(() => [props.projectID, props.workspaceID] as const);
    const generation = accessGeneration;
    const read = ++accessRead;
    const current = () =>
      generation === accessGeneration &&
      read === accessRead &&
      untrack(() => props.projectID === projectID && props.workspaceID === workspaceID);
    const signal = AbortSignal.timeout(4_000);
    const availableRead = projectID
      ? serverCall(getAvailableWorkspaces({ signal, data: [projectID] }))
          .then((value) => {
            if (current()) setAvailable(value);
          })
          .catch((cause) => {
            if (current())
              setError(
                cause instanceof Error
                  ? plainErrorMessage(cause.message)
                  : "Workspace listing is unavailable.",
              );
          })
      : Promise.resolve();
    if (workspaceID) {
      try {
        const value = await serverCall(getWorkspaceCollaboration({ signal, data: [workspaceID] }));
        if (value.workspaceID !== workspaceID)
          throw new Error("Workspace access changed. Check the selected Workspace again.");
        if (current()) setState(value);
        if (value.kind === "ticket") {
          if (!projectID) throw new Error("Select the Ticket Project to check writing authority.");
          const [files, attempts] = await Promise.all([
            serverCall(getWorkspaceSource({ signal, data: [workspaceID] })).catch((cause) => {
              if (current())
                setAccessError(
                  cause instanceof Error
                    ? plainErrorMessage(cause.message)
                    : "File access is unavailable.",
                );
              return undefined;
            }),
            serverCall(getRuntimeAttempts({ signal, data: [projectID] })),
          ]);
          const attempt = attempts.attempts.find(
            (row) => row.workspaceId === workspaceID && row.projectId === projectID,
          );
          if (!attempt?.changeId) throw new Error("Ticket writing authority is unavailable.");
          const editing = await serverCall(
            getChangeWriterStatus({ signal, data: [attempt.changeId] }),
          );
          if (current()) {
            setSource(files?.workspaceID === workspaceID ? files : undefined);
            setWriter(editing);
            setComputeState(attempt.state);
            if (files)
              setAccessError(
                files.workspaceID === workspaceID
                  ? ""
                  : "File access returned a different Workspace.",
              );
          }
        } else if (current()) setAccessError("");
      } catch (cause) {
        if (current()) {
          setSource(undefined);
          setWriter(undefined);
          setComputeState(undefined);
          setAccessError(
            cause instanceof Error
              ? plainErrorMessage(cause.message)
              : "Workspace access is unavailable.",
          );
        }
      }
    }
    await availableRead;
  }
  createEffect(
    () => [props.projectID, props.workspaceID] as const,
    () => {
      accessGeneration++;
      accessRead++;
      setOpen(false);
      setSharing(undefined);
      setState(undefined);
      setSource(undefined);
      setWriter(undefined);
      setComputeState(undefined);
      setAccessError("");
      setSubmitted("");
      setError("");
      let active = true;
      const read = () => {
        if (active)
          void refresh().catch((cause) => {
            if (active)
              setError(
                cause instanceof Error
                  ? plainErrorMessage(cause.message)
                  : "Workspace access is unavailable",
              );
          });
      };
      read();
      const timer = setInterval(read, 5000);
      return () => {
        active = false;
        accessGeneration++;
        clearInterval(timer);
      };
    },
  );
  createEffect(
    () => open(),
    (value) => {
      if (value) dialog?.showModal();
      else dialog?.close();
    },
  );
  function close() {
    dialog?.close();
    setOpen(false);
    opener?.focus();
  }
  async function manage() {
    const workspaceID = props.workspaceID;
    if (!workspaceID) return;
    setBusy(true);
    setError("");
    try {
      const value = await serverCall(getWorkspaceSharing({ data: [workspaceID] }));
      if (props.workspaceID === workspaceID) {
        setSharing(value);
        setOpen(true);
      }
    } catch (cause) {
      setError(
        cause instanceof Error ? plainErrorMessage(cause.message) : "Sharing could not open",
      );
    } finally {
      setBusy(false);
    }
  }
  async function decide(
    member: Sharing["members"][number],
    permission: "observe" | "collaborate" | null,
  ) {
    const workspaceID = props.workspaceID;
    if (!workspaceID || busy()) return;
    const focused = document.activeElement;
    setBusy(true);
    setError("");
    try {
      await serverCall(
        shareWorkspace({
          data: [
            {
              commandID: crypto.randomUUID(),
              workspaceID,
              userID: member.userID,
              permission,
              expectedVersion: member.version,
            },
          ],
        }),
      );
      const value = await serverCall(getWorkspaceSharing({ data: [workspaceID] }));
      if (props.workspaceID === workspaceID) {
        setSharing(value);
        requestAnimationFrame(() => {
          if (focused && !focused.isConnected)
            dialog
              ?.querySelector<HTMLSelectElement>(`select[data-member-id="${member.userID}"]`)
              ?.focus();
        });
      }
      await refresh();
    } catch (cause) {
      setError(
        cause instanceof Error
          ? plainErrorMessage(cause.message)
          : "Sharing outcome is unconfirmed. Reopen sharing to see its recorded state.",
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <div class="workspace-sharing-controls">
      <WorkspaceActionBar
        label="Workspace collaboration"
        status={
          <span>
            {!state()
              ? "Checking Workspace access…"
              : state()?.kind === "ticket" && !writer()
                ? "Editing status unavailable"
                : state()?.collaborative
                  ? state()
                      ?.participants.map((peer) => peer.name)
                      .join(", ") || "Shared editing enabled"
                  : "Private editing"}
          </span>
        }
      >
        <label class="workspace-sharing-choice">
          Workspace
          <select
            aria-label="Choose shared Workspace"
            value={props.workspaceID ?? ""}
            disabled={busy()}
            onChange={(event) => {
              const selected = available().find(
                (row) => row.workspaceID === event.currentTarget.value,
              );
              if (selected) void props.onOpen(selected).catch((cause) => setError(String(cause)));
            }}
          >
            <option value="" disabled>
              Choose Workspace
            </option>
            <For each={available()} keyed={(row) => row.workspaceID}>
              {(row) => (
                <option
                  value={row().workspaceID}
                  selected={row().workspaceID === props.workspaceID}
                >
                  {row().kind === "ticket"
                    ? row().name
                    : row().ownerID === props.userID
                      ? "My workspace"
                      : `${row().name}'s workspace`}
                </option>
              )}
            </For>
          </select>
        </label>
        <Show
          when={
            props.workspaceID && state()?.kind === "personal" && state()?.ownerID === props.userID
          }
        >
          <button
            ref={opener}
            type="button"
            class="workspace-action"
            disabled={busy()}
            onClick={() => void manage()}
          >
            Share Workspace
          </button>
        </Show>
        <Show when={props.workspaceID && !state()?.collaborative && state()?.kind === "ticket"}>
          <button
            type="button"
            class="workspace-action"
            disabled={busy() || Boolean(actionUnavailable())}
            title={actionUnavailable() || undefined}
            aria-describedby={actionUnavailable() ? "workspace-action-availability" : undefined}
            onClick={() => {
              const id = props.workspaceID;
              if (!id || busy() || actionUnavailable()) return;
              setBusy(true);
              void serverCall(enableWorkspaceCollaboration({ data: [id, crypto.randomUUID()] }))
                .then(refresh)
                .catch((cause) => setError(String(cause)))
                .finally(() => setBusy(false));
            }}
          >
            Enable shared editing
          </button>
        </Show>
        <Show when={props.workspaceID && state()?.kind === "ticket"}>
          <button
            type="button"
            class="workspace-action"
            disabled={busy() || Boolean(submissionUnavailable())}
            title={submissionUnavailable() || undefined}
            aria-describedby={submissionUnavailable() ? "workspace-action-availability" : undefined}
            onClick={() => {
              const id = props.workspaceID;
              if (!id || busy() || submissionUnavailable()) return;
              setBusy(true);
              setError("");
              void (async () => {
                if (!submission || submission.workspaceID !== id) {
                  const observed = await serverCall(inspectWorkspaceSubmission({ data: [id] }));
                  if (
                    !window.confirm(
                      `Submit the saved shared checkout with ${observed.files.length} changed files for Verification and independent review? This does not save anyone's unsent editor buffer or approve Delivery.`,
                    )
                  )
                    return;
                  submission = {
                    requestID: crypto.randomUUID(),
                    workspaceID: id,
                    expectedHead: observed.head,
                    expectedRemoteHead: observed.remoteHead,
                    message: "Submit shared Ticket Workspace",
                  };
                }
                const result = await serverCall(submitWorkspace({ data: [submission] }));
                if (result.state === "succeeded" || result.state === "failed")
                  submission = undefined;
                setSubmitted(
                  result.state === "succeeded"
                    ? "Saved checkout submitted for Verification and independent review."
                    : `Submission recorded as ${result.state}. No Delivery approval was granted.`,
                );
              })()
                .catch((cause) =>
                  setError(
                    cause instanceof Error
                      ? plainErrorMessage(cause.message)
                      : "Submission outcome is unconfirmed. Keep this request identity and observe it.",
                  ),
                )
                .finally(() => setBusy(false));
            }}
          >
            Submit saved checkout
          </button>
        </Show>
      </WorkspaceActionBar>
      <Show
        when={
          props.workspaceID &&
          (!state() || state()?.kind === "ticket") &&
          (actionUnavailable() || submissionUnavailable())
        }
      >
        <p
          id="workspace-action-availability"
          role="status"
          aria-label="Workspace action availability"
          class="workspace-sharing-error"
        >
          {actionUnavailable() || submissionUnavailable()}
          <Show when={accessError()}> {accessError()}</Show>
        </p>
      </Show>
      <Show when={error() && !open()}>
        <p role="alert" class="workspace-sharing-error">
          {error()}
        </p>
      </Show>
      <Show when={submitted()}>
        <p role="status" class="workspace-sharing-error">
          {submitted()}
        </p>
      </Show>
      <dialog
        ref={dialog}
        class="workspace-sharing-dialog"
        aria-labelledby="workspace-sharing-title"
        onCancel={(event) => {
          event.preventDefault();
          close();
        }}
      >
        <WindowHeading
          eyebrow="Personal Workspace"
          title="Share Workspace"
          titleID="workspace-sharing-title"
          onClose={close}
        />
        <div class="workspace-sharing-body">
          <p>
            Invite current Project Developers to observe or collaborate. You share one Dev
            Container, its files, processes and Docker environment.
          </p>
          <p>
            Removing access does not stop code they already started. Cancel commands or stop compute
            separately.
          </p>
          <Show when={error()}>
            <p role="alert">{error()}</p>
          </Show>
          <Show
            when={sharing()?.members.length}
            fallback={<p>No other current Project Developers are available.</p>}
          >
            <For each={sharing()?.members ?? []} keyed={(member) => member.userID}>
              {(member) => (
                <label class="control-field workspace-sharing-member">
                  <span>{member().name}</span>
                  <select
                    aria-label={`Access for ${member().name}`}
                    data-member-id={member().userID}
                    value={member().permission ?? "private"}
                    disabled={busy()}
                    onChange={(event) =>
                      void decide(
                        member(),
                        event.currentTarget.value === "private"
                          ? null
                          : (event.currentTarget.value as "observe" | "collaborate"),
                      )
                    }
                  >
                    <option value="private">No access</option>
                    <option value="observe">Observe</option>
                    <option value="collaborate">Collaborate</option>
                  </select>
                </label>
              )}
            </For>
          </Show>
          <div class="control-actions">
            <button type="button" class="quiet-button" onClick={close}>
              Done
            </button>
          </div>
        </div>
      </dialog>
    </div>
  );
}
