import { createEffect, createSignal, createUniqueId, For, Show, untrack } from "solid-js";
import type {
  RepositoryMirror,
  RepositoryMirrorProject,
  RepositoryMirrorView,
} from "../../../../packages/project-domain/src/repository-mirror";
import { FreshAuthentication } from "../access/fresh-authentication";
import {
  acknowledgeRepositoryMirrorOperation,
  createRepositoryMirror,
  getRepositoryMirrorProjects,
  getRepositoryMirrors,
  removeRepositoryMirror,
  syncRepositoryMirrors,
} from "../server-functions/repository-mirrors";
import { serverCall } from "../server-functions/result";
import { WorkspaceActionBar } from "../ui/workspace-actions";
import "./settings.css";

export function RepositoryMirrorSettings(props: {
  active: boolean;
  projectID?: string | undefined;
}) {
  const [projects, setProjects] = createSignal<RepositoryMirrorProject[]>();
  const [selected, setSelected] = createSignal("");
  const [error, setError] = createSignal("");
  createEffect(
    () => props.active,
    (active) => {
      if (!active || untrack(projects)) return;
      setError("");
      let disposed = false;
      void serverCall(getRepositoryMirrorProjects({ data: [] })).then(
        (value) => {
          if (disposed) return;
          setProjects(value);
          setSelected(value.find((item) => item.id === props.projectID)?.id ?? value[0]?.id ?? "");
        },
        () => {
          if (!disposed) setError("Projects could not be loaded. Reopen this page to try again.");
        },
      );
      return () => {
        disposed = true;
      };
    },
  );
  return (
    <section class="repository-mirrors" aria-label="Repository mirrors">
      <p>
        Copy pushed branches, tags and history to an external Git repository. Forgejo synchronizes
        after pushes and checks hourly.
      </p>
      <p>
        Git only. Accounts, Tickets, secrets, uploads and unpushed work are not included. Changes
        and deletions also reach the mirror.
      </p>
      <FreshAuthentication active={props.active} />
      <Show when={error()}>
        <p role="alert">{error()}</p>
      </Show>
      <Show when={projects()} fallback={<p role="status">Loading Projects…</p>}>
        {(items) => (
          <Show
            when={items().length}
            fallback={<p>Create a Project before configuring a mirror.</p>}
          >
            <label class="control-field">
              Project
              <select
                value={selected()}
                onChange={(event) => setSelected(event.currentTarget.value)}
              >
                <For each={items()}>{(item) => <option value={item.id}>{item.name}</option>}</For>
              </select>
            </label>
            <Show when={selected()} keyed>
              {(id) => <ProjectMirrors projectID={id} active={props.active} />}
            </Show>
          </Show>
        )}
      </Show>
    </section>
  );
}

function ProjectMirrors(props: { projectID: string; active: boolean }) {
  const [view, setView] = createSignal<RepositoryMirrorView>();
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal("");
  const [notice, setNotice] = createSignal("");
  const [target, setTarget] = createSignal("");
  const [username, setUsername] = createSignal("");
  const [token, setToken] = createSignal("");
  const [confirmed, setConfirmed] = createSignal(false);
  const [removing, setRemoving] = createSignal<string>();
  const [adding, setAdding] = createSignal(false);
  const tokenHelpID = `mirror-token-${createUniqueId()}`;
  let targetInput: HTMLInputElement | undefined;
  let addButton: HTMLButtonElement | undefined;
  let syncButton: HTMLButtonElement | undefined;
  let disposed = false;
  createEffect(
    () => props.active,
    (active) => {
      if (!active) setToken("");
    },
  );
  async function load() {
    if (busy() || disposed) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const current = await serverCall(getRepositoryMirrors({ data: [props.projectID] }));
      if (!disposed) {
        setView(current);
        if (current.mirrors.length && !adding()) setToken("");
      }
    } catch (cause) {
      if (!disposed)
        setError(cause instanceof Error ? cause.message : "Mirror status is unavailable.");
    } finally {
      if (!disposed) setBusy(false);
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
  async function command(
    run: () => Promise<RepositoryMirrorView>,
    message: string,
    success?: () => void,
  ) {
    if (busy() || disposed) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const result = await run();
      if (!disposed) {
        setView(result);
        setNotice(message);
        setRemoving(undefined);
        success?.();
      }
    } catch (cause) {
      if (!disposed)
        setError(cause instanceof Error ? cause.message : "Mirror operation is unconfirmed.");
    } finally {
      // Do not retain a credential in a hidden or failed form.
      setToken("");
      if (!disposed) setBusy(false);
    }
  }
  function closeForm() {
    setAdding(false);
    setTarget("");
    setUsername("");
    setToken("");
    setConfirmed(false);
  }
  function create(event: SubmitEvent) {
    event.preventDefault();
    const secret = token();
    if (!secret || !confirmed()) return;
    void command(
      () =>
        serverCall(
          createRepositoryMirror({
            data: [
              props.projectID,
              {
                commandID: crypto.randomUUID(),
                targetURL: target(),
                username: username(),
                token: secret,
                confirmOverwrite: true,
              },
            ],
          }),
        ),
      "Mirror configured. Use Sync now to confirm the first transfer.",
      () => {
        closeForm();
        queueMicrotask(() => syncButton?.focus());
      },
    );
  }
  const timestamp = (value: string | null) =>
    value ? new Date(value).toLocaleString() : "No attempt observed";
  return (
    <>
      <WorkspaceActionBar label="Repository mirror actions">
        <Show when={view()?.mirrors.length && !adding()}>
          <button
            ref={addButton}
            type="button"
            class="workspace-action"
            disabled={busy() || Boolean(view()?.pending)}
            onClick={() => {
              setAdding(true);
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
          data-primary={!adding() ? "true" : undefined}
          disabled={busy() || adding() || !view()?.mirrors.length || Boolean(view()?.pending)}
          onClick={() =>
            void command(
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
                      void command(
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
                    <section
                      class="repository-mirror-target"
                      aria-label={`Mirror ${mirror.targetURL}`}
                    >
                      <p class="repository-mirror-url">{mirror.targetURL}</p>
                      <p role="status">
                        {mirror.lastAttempt
                          ? mirror.failed
                            ? "Last attempt failed. Check the target's access and protection rules."
                            : "Last observed attempt succeeded."
                          : "No successful synchronization confirmed yet."}
                      </p>
                      <dl>
                        <dt>Last attempt</dt>
                        <dd>{timestamp(mirror.lastAttempt)}</dd>
                        <dt>After pushes</dt>
                        <dd>{mirror.syncOnCommit ? "Enabled" : "Disabled"}</dd>
                        <dt>Interval</dt>
                        <dd>{mirror.interval === "1h0m0s" ? "Every hour" : mirror.interval}</dd>
                        <dt>Branches</dt>
                        <dd>{mirror.branchFilter || "All branches and tags"}</dd>
                      </dl>
                      <Show
                        when={removing() === mirror.remoteName}
                        fallback={
                          <button
                            type="button"
                            class="quiet-button"
                            disabled={busy()}
                            onClick={() => setRemoving(mirror.remoteName)}
                          >
                            Remove mirror…
                          </button>
                        }
                      >
                        <p>
                          Stop future pushes to this target. The external repository and its code
                          are not deleted.
                        </p>
                        <div class="control-actions">
                          <button
                            type="button"
                            class="quiet-button"
                            disabled={busy()}
                            onClick={() => setRemoving(undefined)}
                          >
                            Keep mirror
                          </button>
                          <button
                            type="button"
                            class="danger-button"
                            disabled={busy()}
                            onClick={() => void remove(mirror)}
                          >
                            Confirm removal
                          </button>
                        </div>
                      </Show>
                    </section>
                  )}
                </For>
              </div>
            </Show>
            <Show when={!current().mirrors.length || adding()}>
              <form class="repository-mirror-form" aria-label="Add a mirror" onSubmit={create}>
                <h3>Add a mirror</h3>
                <p>
                  Create a private, dedicated repository first and disable its automation. Use a
                  token limited to that repository with Git write access.
                </p>
                <label class="control-field">
                  Target Git URL
                  <input
                    ref={targetInput}
                    type="url"
                    required
                    autocomplete="off"
                    placeholder="https://github.com/team/project.git"
                    value={target()}
                    disabled={busy()}
                    onInput={(event) => {
                      setTarget(event.currentTarget.value);
                      setConfirmed(false);
                    }}
                  />
                </label>
                <div class="repository-mirror-access">
                  <label class="control-field">
                    Git username
                    <input
                      required
                      autocomplete="off"
                      value={username()}
                      disabled={busy()}
                      onInput={(event) => setUsername(event.currentTarget.value)}
                    />
                  </label>
                  <label class="control-field">
                    Access token
                    <input
                      type="password"
                      required
                      autocomplete="new-password"
                      spellcheck={false}
                      aria-describedby={tokenHelpID}
                      value={token()}
                      disabled={busy()}
                      onInput={(event) => setToken(event.currentTarget.value)}
                    />
                  </label>
                </div>
                <p id={tokenHelpID} class="repository-mirror-help">
                  Forgejo stores the token in the source repository's Git configuration, not in
                  OpenBao. Forgejo does not encrypt it. Protect its storage and backups.
                </p>
                <label class="control-check">
                  <input
                    type="checkbox"
                    required
                    checked={confirmed()}
                    disabled={busy()}
                    onChange={(event) => setConfirmed(event.currentTarget.checked)}
                  />
                  This target is a dedicated mirror. Factory may overwrite and delete its Git refs.
                </label>
                <div class="control-actions">
                  <Show when={current().mirrors.length}>
                    <button
                      type="button"
                      class="quiet-button"
                      disabled={busy()}
                      onClick={() => {
                        closeForm();
                        queueMicrotask(() => addButton?.focus());
                      }}
                    >
                      Cancel
                    </button>
                  </Show>
                  <button
                    type="submit"
                    class="primary-button"
                    disabled={busy() || Boolean(current().pending) || !token() || !confirmed()}
                  >
                    Add mirror
                  </button>
                </div>
              </form>
            </Show>
          </>
        )}
      </Show>
    </>
  );
  function remove(mirror: RepositoryMirror) {
    return command(
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
}
