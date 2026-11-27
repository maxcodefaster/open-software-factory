import { type ComponentProps, For, Show } from "solid-js";
import { Icon } from "../icon";
import { SaveFeedback } from "../ui/feedback";
import { WorkspaceActionBar } from "../ui/workspace-actions";

type SaveFeedbackState = ComponentProps<typeof SaveFeedback>["state"];
import type {
  AvailableWorkspace,
  CollaborationState,
  SharingMember,
} from "./workspace-sharing-state";

export function WorkspaceSharingToolbar(props: {
  workspaceID: string | undefined;
  userID: string;
  available: AvailableWorkspace[];
  collaboration: CollaborationState | undefined;
  statusText: string;
  busy: boolean;
  actionUnavailable: string;
  submissionUnavailable: string;
  accessError: string;
  alertMessage: string;
  dialogOpen: boolean;
  submitted: string;
  openerRef: (element: HTMLButtonElement) => void;
  onSelectWorkspace: (workspaceID: string) => void;
  onManage: () => void;
  onEnableCollaboration: () => void;
  onSubmitCheckout: () => void;
}) {
  return (
    <>
      <WorkspaceActionBar
        label="Workspace collaboration"
        leading={
          <label class="workspace-sharing-choice">
            Workspace
            <select
              aria-label="Choose shared Workspace"
              value={props.workspaceID ?? ""}
              disabled={props.busy}
              onChange={(event) => props.onSelectWorkspace(event.currentTarget.value)}
            >
              <option value="" disabled>
                Choose Workspace
              </option>
              <For each={props.available} keyed={(row) => row.workspaceID}>
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
        }
        status={<span class="workspace-sharing-status">{props.statusText}</span>}
      >
        <Show
          when={
            props.workspaceID &&
            props.collaboration?.kind === "personal" &&
            props.collaboration?.ownerID === props.userID
          }
        >
          <button
            ref={props.openerRef}
            type="button"
            class="workspace-action"
            disabled={props.busy}
            onClick={props.onManage}
          >
            Share Workspace
          </button>
        </Show>
        <Show
          when={
            props.workspaceID &&
            !props.collaboration?.collaborative &&
            props.collaboration?.kind === "ticket"
          }
        >
          <button
            type="button"
            class="workspace-action"
            disabled={props.busy || Boolean(props.actionUnavailable)}
            title={props.actionUnavailable || undefined}
            aria-describedby={props.actionUnavailable ? "workspace-action-availability" : undefined}
            onClick={props.onEnableCollaboration}
          >
            Enable shared editing
          </button>
        </Show>
        <Show when={props.workspaceID && props.collaboration?.kind === "ticket"}>
          <button
            type="button"
            class="workspace-action"
            disabled={props.busy || Boolean(props.submissionUnavailable)}
            title={props.submissionUnavailable || undefined}
            aria-describedby={
              props.submissionUnavailable ? "workspace-action-availability" : undefined
            }
            onClick={props.onSubmitCheckout}
          >
            Submit saved checkout
          </button>
        </Show>
      </WorkspaceActionBar>
      <Show
        when={
          props.workspaceID &&
          (!props.collaboration || props.collaboration?.kind === "ticket") &&
          (props.actionUnavailable || props.submissionUnavailable)
        }
      >
        <p
          id="workspace-action-availability"
          role="status"
          aria-label="Workspace action availability"
          class="workspace-sharing-error"
        >
          {props.actionUnavailable || props.submissionUnavailable}
          <Show when={props.accessError}> {props.accessError}</Show>
        </p>
      </Show>
      <Show when={props.alertMessage && !props.dialogOpen}>
        <p role="alert" class="workspace-sharing-error">
          {props.alertMessage}
        </p>
      </Show>
      <Show when={props.submitted}>
        <p role="status" class="workspace-sharing-error">
          {props.submitted}
        </p>
      </Show>
    </>
  );
}

export function WorkspaceSharingDialog(props: {
  members: SharingMember[];
  busy: boolean;
  saveStatus: SaveFeedbackState;
  alertMessage: string;
  dialogRef: (element: HTMLDialogElement) => void;
  onClose: () => void;
  onDecide: (member: SharingMember, permission: "observe" | "collaborate" | null) => void;
}) {
  return (
    <dialog
      ref={props.dialogRef}
      class="workspace-sharing-dialog"
      aria-labelledby="workspace-sharing-title"
      onCancel={(event) => {
        event.preventDefault();
        props.onClose();
      }}
    >
      <header class="window-heading">
        <div>
          <p>Personal Workspace</p>
          <h2 id="workspace-sharing-title">Share Workspace</h2>
        </div>
        <button
          type="button"
          class="bare-icon"
          aria-label="Close Share Workspace"
          title="Close Share Workspace"
          onClick={props.onClose}
        >
          <Icon name="close" />
        </button>
      </header>
      <div class="workspace-sharing-body">
        <p>
          Invite current Project Developers to observe or collaborate. You share one Workspace, its
          files, processes and native environment.
        </p>
        <p>
          Removing access does not stop code they already started. Cancel individual commands or
          pause shared compute separately.
        </p>
        <Show when={props.alertMessage}>
          <p role="alert">{props.alertMessage}</p>
        </Show>
        <Show
          when={props.members.length}
          fallback={<p>No other current Project Developers are available.</p>}
        >
          <For each={props.members} keyed={(member) => member.userID}>
            {(member) => (
              <label class="control-field workspace-sharing-member">
                <span>{member().name}</span>
                <select
                  aria-label={`Access for ${member().name}`}
                  data-member-id={member().userID}
                  value={member().permission ?? "private"}
                  disabled={props.busy}
                  onChange={(event) =>
                    props.onDecide(
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
          <SaveFeedback state={props.saveStatus} />
          <button type="button" class="quiet-button" onClick={props.onClose}>
            Done
          </button>
        </div>
      </div>
    </dialog>
  );
}
