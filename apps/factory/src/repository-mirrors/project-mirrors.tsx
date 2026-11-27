import { createEffect, createSignal, For, Show, untrack } from "solid-js";
import type { RepositoryMirror, RepositoryMirrorView } from "#project-domain/repository-mirror";
import { plainErrorMessage } from "../command-error";
import {
  acknowledgeRepositoryMirrorOperation,
  createRepositoryMirror,
  getRepositoryMirrors,
  removeRepositoryMirror,
  syncRepositoryMirrors,
} from "../server-functions/repository-mirrors";
import { serverCall } from "../server-functions/result";
import { WorkspaceActionBar } from "../ui/workspace-actions";
import { MirrorAddForm, MirrorTargetCard } from "./mirror-form";
import {
  clearMirrorToken,
  confirmingRemoteName,
  emptyMirrorDraft,
  isMirrorBusy,
  type MirrorActionState,
  type MirrorDraftState,
  mirrorActionError,
  mirrorActionNotice,
} from "./mirror-state";

export function ProjectMirrors(props: { projectID: string; active: boolean }) {
  const [view, setView] = createSignal<RepositoryMirrorView>();
  const [action, setAction] = createSignal<MirrorActionState>({ kind: "idle" });
  const [draft, setDraft] = createSignal<MirrorDraftState>(emptyMirrorDraft());
  let targetInput: HTMLInputElement | undefined;
  let addButton: HTMLButtonElement | undefined;
  let syncButton: HTMLButtonElement | undefined;
  let disposed = false;

  const busy = () => isMirrorBusy(action());
  const error = () => mirrorActionError(action());
  const notice = () => mirrorActionNotice(action());

  createEffect(
    () => props.active,
    (active) => {
      if (!active) setDraft(clearMirrorToken);
    },
  );

  async function load() {
    if (busy() || disposed) return;
    setAction({ kind: "loading" });
    try {
      const current = await serverCall(getRepositoryMirrors({ data: [props.projectID] }));
      if (!disposed) {
        setView(current);
        if (current.mirrors.length && !draft().open) setDraft(clearMirrorToken);
        setAction({ kind: "idle" });
      }
    } catch (cause) {
      if (!disposed)
        setAction({
          kind: "idle",
          error:
            cause instanceof Error
              ? plainErrorMessage(cause.message)
              : "Mirror status is unavailable.",
        });
    }
  }

  createEffect(
    () => true,
    () => {
      void untrack(load);
      return () => {
        disposed = true;
      };
    },
  );

  async function runCommand(
    pendingState: Extract<
      MirrorActionState,
      { kind: "syncing" | "acknowledging" | "adding" | "removing" }
    >,
    run: () => Promise<RepositoryMirrorView>,
    message: string,
    onSuccess?: () => void,
  ) {
    if (busy() || disposed) return;
    setAction(pendingState);
    try {
      const result = await run();
      if (!disposed) {
        setView(result);
        setAction({ kind: "idle", notice: message });
        onSuccess?.();
      }
    } catch (cause) {
      if (!disposed) {
        const messageText =
          cause instanceof Error
            ? plainErrorMessage(cause.message)
            : "Mirror operation is unconfirmed.";
        setAction(
          pendingState.kind === "removing"
            ? {
                kind: "confirming-remove",
                remoteName: pendingState.remoteName,
                error: messageText,
              }
            : { kind: "idle", error: messageText },
        );
      }
    } finally {
      // Do not retain a credential in a hidden or failed form.
      setDraft(clearMirrorToken);
    }
  }

  function create(event: SubmitEvent) {
    event.preventDefault();
    const current = draft();
    if (!current.token || !current.confirmed) return;
    void runCommand(
      { kind: "adding" },
      () =>
        serverCall(
          createRepositoryMirror({
            data: [
              props.projectID,
              {
                commandID: crypto.randomUUID(),
                targetURL: current.target,
                username: current.username,
                token: current.token,
                confirmOverwrite: true,
              },
            ],
          }),
        ),
      "Mirror configured. Use Sync now to confirm the first transfer.",
      () => {
        setDraft(emptyMirrorDraft(false));
        queueMicrotask(() => syncButton?.focus());
      },
    );
  }

  function remove(mirror: RepositoryMirror) {
    return runCommand(
      { kind: "removing", remoteName: mirror.remoteName },
      () =>
        serverCall(
          removeRepositoryMirror({
            data: [
              props.projectID,
              {
                commandID: crypto.randomUUID(),
                remoteName: mirror.remoteName,
                targetURL: mirror.targetURL,
              },
            ],
          }),
        ),
      "Mirror removed. The external repository was not deleted.",
    );
  }

  return (
    <>
      <WorkspaceActionBar label="Repository mirror actions">
        <Show when={view()?.mirrors.length && !draft().open}>
          <button
            ref={addButton}
            type="button"
            class="workspace-action"
            disabled={busy() || Boolean(view()?.pending)}
            onClick={() => {
              setDraft((current) => ({ ...current, open: true }));
              queueMicrotask(() => targetInput?.focus());
            }}
          >
            Add mirror
          </button>
        </Show>
        <button
          type="button"
          class="workspace-action"
          disabled={busy()}
          onClick={() => void load()}
        >
          Refresh status
        </button>
        <button
          ref={syncButton}
          type="button"
          class="workspace-action"
          data-primary={!draft().open ? "true" : undefined}
          disabled={busy() || draft().open || !view()?.mirrors.length || Boolean(view()?.pending)}
          onClick={() =>
            void runCommand(
              { kind: "syncing" },
              () =>
                serverCall(
                  syncRepositoryMirrors({
                    data: [props.projectID, { commandID: crypto.randomUUID() }],
                  }),
                ),
              "Forgejo confirmed synchronization of this Project's mirror targets.",
            )
          }
        >
          {busy() ? "Working…" : "Sync now"}
        </button>
      </WorkspaceActionBar>
      <Show when={error()}>
        <p role="alert">{error()}</p>
      </Show>
      <Show when={notice()}>
        <p role="status">{notice()}</p>
      </Show>
      <Show
        when={view()}
        fallback={
          <p role="status">{busy() ? "Loading mirrors…" : "Refresh to load mirror status."}</p>
        }
      >
        {(current) => (
          <>
            <Show when={current().pending}>
              {(pending) => (
                <div>
                  <p role="status">
                    A mirror operation is unconfirmed. Refresh to observe its result. Factory will
                    not repeat it automatically.
                  </p>
                  <p>
                    After checking Forgejo, keep the observed configuration and dismiss this
                    uncertainty. This does not retry the operation.
                  </p>
                  <button
                    type="button"
                    class="quiet-button"
                    disabled={busy()}
                    onClick={() =>
                      void runCommand(
                        { kind: "acknowledging" },
                        () =>
                          serverCall(
                            acknowledgeRepositoryMirrorOperation({
                              data: [props.projectID, { commandID: pending().commandID }],
                            }),
                          ),
                        "Uncertainty acknowledged. The operation was not repeated.",
                      )
                    }
                  >
                    Keep observed configuration
                  </button>
                </div>
              )}
            </Show>
            <Show
              when={current().mirrors.length}
              fallback={<p>No external mirror configured for this Project.</p>}
            >
              <div class="repository-mirror-list">
                <For each={current().mirrors}>
                  {(mirror) => (
                    <MirrorTargetCard
                      mirror={mirror}
                      confirming={confirmingRemoteName(action()) === mirror.remoteName}
                      busy={busy()}
                      onStartRemove={() =>
                        setAction((state) => ({
                          kind: "confirming-remove",
                          remoteName: mirror.remoteName,
                          notice: mirrorActionNotice(state) || undefined,
                          error: mirrorActionError(state) || undefined,
                        }))
                      }
                      onCancelRemove={() =>
                        setAction((state) => ({
                          kind: "idle",
                          notice: mirrorActionNotice(state) || undefined,
                          error: mirrorActionError(state) || undefined,
                        }))
                      }
                      onConfirmRemove={() => void remove(mirror)}
                    />
                  )}
                </For>
              </div>
            </Show>
            <Show when={!current().mirrors.length || draft().open}>
              <MirrorAddForm
                draft={draft()}
                busy={busy()}
                pending={Boolean(current().pending)}
                canCancel={Boolean(current().mirrors.length)}
                targetRef={(element) => {
                  targetInput = element;
                }}
                onChange={(patch) => setDraft((state) => ({ ...state, ...patch }))}
                onCancel={() => {
                  setDraft(emptyMirrorDraft(false));
                  queueMicrotask(() => addButton?.focus());
                }}
                onSubmit={create}
              />
            </Show>
          </>
        )}
      </Show>
    </>
  );
}
