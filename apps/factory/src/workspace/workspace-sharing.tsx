import { createEffect, createSignal, untrack } from "solid-js";
import { plainErrorMessage } from "../command-error";
import { serverCall } from "../server-functions/result";
import { getRuntimeAttempts } from "../server-functions/runtime";
import {
  enableWorkspaceCollaboration,
  getAvailableWorkspaces,
  getWorkspaceCollaboration,
  getWorkspaceSharing,
  getWorkspaceSource,
  inspectWorkspaceSubmission,
  shareWorkspace,
  submitWorkspace,
} from "../server-functions/workspaces";
import { getChangeWriterStatus } from "../server-functions/writer";
import type { ComponentProps } from "solid-js";
import type { SaveFeedback } from "../ui/feedback";

type SaveFeedbackState = ComponentProps<typeof SaveFeedback>["state"];
import { WorkspaceSharingDialog, WorkspaceSharingToolbar } from "./workspace-sharing-dialog";
import {
  type AvailableWorkspace,
  accessErrorFromAccess,
  actionUnavailableReason,
  beginClosedDialogAction,
  beginMemberDecision,
  closeSharingDialog,
  collaborationFromAccess,
  finishMemberDecision,
  INITIAL_SHARING_DIALOG_STATE,
  isSharingBusy,
  isSharingOpen,
  openSharingDialog,
  type PendingWorkspaceSubmission,
  refreshWorkspaceAccess,
  type SharingDialogState,
  type SharingMember,
  settleDialogIdle,
  sharingMembers,
  submissionUnavailableReason,
  type WorkspaceAccessSnapshot,
  workspaceStatusText,
} from "./workspace-sharing-state";
import "./workspace-sharing.css";

export function WorkspaceSharingBar(props: {
  projectID: string | undefined;
  workspaceID: string | undefined;
  userID: string;
  onOpen(workspace: AvailableWorkspace): Promise<void>;
}) {
  const [available, setAvailable] = createSignal<AvailableWorkspace[]>([]);
  const [access, setAccess] = createSignal<WorkspaceAccessSnapshot>({ kind: "loading" });
  const [dialogState, setDialogState] = createSignal<SharingDialogState>(
    INITIAL_SHARING_DIALOG_STATE,
  );
  const [saveStatus, setSaveStatus] = createSignal<SaveFeedbackState>("idle");
  const [listingError, setListingError] = createSignal("");
  let accessGeneration = 0;
  let accessRead = 0;
  let actionGeneration = 0;
  let submission: PendingWorkspaceSubmission | undefined;
  let dialog: HTMLDialogElement | undefined;
  let opener: HTMLButtonElement | undefined;

  const collaboration = () => collaborationFromAccess(access());
  const accessError = () => accessErrorFromAccess(access());
  const busy = () => isSharingBusy(dialogState());
  const open = () => isSharingOpen(dialogState());
  const alertMessage = () => dialogState().error || listingError();
  const actionUnavailable = () => actionUnavailableReason(props.workspaceID, access());
  const submissionUnavailable = () => submissionUnavailableReason(props.workspaceID, access());
  const statusText = () => workspaceStatusText(access());
  const isCurrentAction = (token: number, workspaceID: string) =>
    token === actionGeneration && untrack(() => props.workspaceID === workspaceID);

  const readers = {
    readAvailable: (projectID: string, signal: AbortSignal) =>
      serverCall(getAvailableWorkspaces({ signal, data: [projectID] })),
    readCollaboration: (workspaceID: string, signal: AbortSignal) =>
      serverCall(getWorkspaceCollaboration({ signal, data: [workspaceID] })),
    readSource: (workspaceID: string, signal: AbortSignal) =>
      serverCall(getWorkspaceSource({ signal, data: [workspaceID] })),
    readAttempts: (projectID: string, signal: AbortSignal) =>
      serverCall(getRuntimeAttempts({ signal, data: [projectID] })),
    readWriter: (changeID: string, signal: AbortSignal) =>
      serverCall(getChangeWriterStatus({ signal, data: [changeID] })),
  };

  function refresh() {
    const [projectID, workspaceID] = untrack(() => [props.projectID, props.workspaceID] as const);
    const generation = accessGeneration;
    const read = ++accessRead;
    return refreshWorkspaceAccess({
      projectID,
      workspaceID,
      isCurrent: () =>
        generation === accessGeneration &&
        read === accessRead &&
        untrack(() => props.projectID === projectID && props.workspaceID === workspaceID),
      readers,
      onAvailable: setAvailable,
      onListingError: setListingError,
      onAccess: setAccess,
    });
  }

  createEffect(
    () => [props.projectID, props.workspaceID] as const,
    () => {
      accessGeneration++;
      accessRead++;
      actionGeneration++;
      setDialogState(INITIAL_SHARING_DIALOG_STATE);
      setSaveStatus("idle");
      setAccess({ kind: "loading" });
      setListingError("");
      let active = true;
      const read = () => {
        if (active)
          void refresh().catch((cause) => {
            if (active)
              setDialogState((state) =>
                settleDialogIdle(state, {
                  error:
                    cause instanceof Error
                      ? plainErrorMessage(cause.message)
                      : "Workspace access is unavailable",
                }),
              );
          });
      };
      read();
      const timer = setInterval(read, 5000);
      return () => {
        active = false;
        accessGeneration++;
        actionGeneration++;
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
    setSaveStatus("idle");
    setDialogState((state) => closeSharingDialog(state));
    opener?.focus();
  }

  async function manage() {
    const workspaceID = props.workspaceID;
    if (!workspaceID || busy()) return;
    const token = ++actionGeneration;
    setSaveStatus("idle");
    setDialogState((state) => beginClosedDialogAction(state, "opening"));
    try {
      const value = await serverCall(getWorkspaceSharing({ data: [workspaceID] }));
      if (isCurrentAction(token, workspaceID))
        setDialogState((state) => openSharingDialog(state, value));
    } catch (cause) {
      if (isCurrentAction(token, workspaceID))
        setDialogState((state) =>
          settleDialogIdle(state, {
            error:
              cause instanceof Error ? plainErrorMessage(cause.message) : "Sharing could not open",
          }),
        );
    }
  }

  async function decide(member: SharingMember, permission: "observe" | "collaborate" | null) {
    const workspaceID = props.workspaceID;
    if (!workspaceID || busy()) return;
    const token = ++actionGeneration;
    const focused = document.activeElement;
    setSaveStatus("saving");
    setDialogState((state) => beginMemberDecision(state));
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
      if (!isCurrentAction(token, workspaceID)) return;
      setDialogState((state) => finishMemberDecision(state, value));
      setSaveStatus("saved");
      requestAnimationFrame(() => {
        if (isCurrentAction(token, workspaceID) && focused && !focused.isConnected)
          dialog
            ?.querySelector<HTMLSelectElement>(`select[data-member-id="${member.userID}"]`)
            ?.focus();
      });
      await refresh();
    } catch (cause) {
      if (isCurrentAction(token, workspaceID)) {
        setSaveStatus("idle");
        setDialogState((state) =>
          settleDialogIdle(state, {
            error:
              cause instanceof Error
                ? plainErrorMessage(cause.message)
                : "Sharing outcome is unconfirmed. Reopen sharing to see its recorded state.",
          }),
        );
      }
    }
  }

  async function enableCollaboration() {
    const id = props.workspaceID;
    if (!id || busy() || actionUnavailable()) return;
    const token = ++actionGeneration;
    setDialogState((state) => beginClosedDialogAction(state, "enabling"));
    try {
      await serverCall(enableWorkspaceCollaboration({ data: [id, crypto.randomUUID()] }));
      if (isCurrentAction(token, id)) {
        await refresh();
        if (isCurrentAction(token, id)) setDialogState((state) => settleDialogIdle(state));
      }
    } catch (cause) {
      if (isCurrentAction(token, id))
        setDialogState((state) => settleDialogIdle(state, { error: String(cause) }));
    }
  }

  async function submitCheckout() {
    const id = props.workspaceID;
    if (!id || busy() || submissionUnavailable()) return;
    const token = ++actionGeneration;
    setDialogState((state) => beginClosedDialogAction(state, "submitting"));
    try {
      if (!submission || submission.workspaceID !== id) {
        const observed = await serverCall(inspectWorkspaceSubmission({ data: [id] }));
        if (!isCurrentAction(token, id)) return;
        if (
          !window.confirm(
            `Submit the saved shared checkout with ${observed.files.length} changed files for Verification and independent review? This does not save anyone's unsent editor buffer or approve Delivery.`,
          )
        ) {
          setDialogState((state) => settleDialogIdle(state));
          return;
        }
        submission = {
          requestID: crypto.randomUUID(),
          workspaceID: id,
          expectedHead: observed.head,
          expectedRemoteHead: observed.remoteHead,
          message: "Submit shared Ticket Workspace",
        };
      }
      const result = await serverCall(submitWorkspace({ data: [submission] }));
      if (result.state === "succeeded" || result.state === "failed") submission = undefined;
      if (!isCurrentAction(token, id)) return;
      setDialogState((state) =>
        settleDialogIdle(state, {
          submitted:
            result.state === "succeeded"
              ? "Saved checkout submitted for Verification and independent review."
              : `Submission recorded as ${result.state}. No Delivery approval was granted.`,
        }),
      );
    } catch (cause) {
      if (isCurrentAction(token, id))
        setDialogState((state) =>
          settleDialogIdle(state, {
            error:
              cause instanceof Error
                ? plainErrorMessage(cause.message)
                : "Submission outcome is unconfirmed. Keep this request identity and observe it.",
          }),
        );
    }
  }

  return (
    <div class="workspace-sharing-controls">
      <WorkspaceSharingToolbar
        workspaceID={props.workspaceID}
        userID={props.userID}
        available={available()}
        collaboration={collaboration()}
        statusText={statusText()}
        busy={busy()}
        actionUnavailable={actionUnavailable()}
        submissionUnavailable={submissionUnavailable()}
        accessError={accessError()}
        alertMessage={alertMessage()}
        dialogOpen={open()}
        submitted={dialogState().submitted}
        openerRef={(element) => {
          opener = element;
        }}
        onSelectWorkspace={(workspaceID) => {
          const selected = available().find((row) => row.workspaceID === workspaceID);
          if (selected)
            void props
              .onOpen(selected)
              .catch((cause) =>
                setDialogState((state) => settleDialogIdle(state, { error: String(cause) })),
              );
        }}
        onManage={() => void manage()}
        onEnableCollaboration={() => void enableCollaboration()}
        onSubmitCheckout={() => void submitCheckout()}
      />
      <WorkspaceSharingDialog
        members={sharingMembers(dialogState())}
        busy={busy()}
        saveStatus={saveStatus()}
        alertMessage={alertMessage()}
        dialogRef={(element) => {
          dialog = element;
        }}
        onClose={close}
        onDecide={(member, permission) => void decide(member, permission)}
      />
    </div>
  );
}
