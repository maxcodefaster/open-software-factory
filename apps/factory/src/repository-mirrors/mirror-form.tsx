import { createUniqueId, Show } from "solid-js";
import type { RepositoryMirror } from "#project-domain/repository-mirror";
import { describeMirrorStatus, formatMirrorTimestamp, type MirrorDraftState } from "./mirror-state";

export function MirrorTargetCard(props: {
  mirror: RepositoryMirror;
  confirming: boolean;
  busy: boolean;
  onStartRemove(): void;
  onCancelRemove(): void;
  onConfirmRemove(): void;
}) {
  return (
    <section class="repository-mirror-target" aria-label={`Mirror ${props.mirror.targetURL}`}>
      <p class="repository-mirror-url">{props.mirror.targetURL}</p>
      <p role="status">{describeMirrorStatus(props.mirror)}</p>
      <dl>
        <dt>Last attempt</dt>
        <dd>{formatMirrorTimestamp(props.mirror.lastAttempt)}</dd>
        <dt>After pushes</dt>
        <dd>{props.mirror.syncOnCommit ? "Enabled" : "Disabled"}</dd>
        <dt>Interval</dt>
        <dd>{props.mirror.interval === "1h0m0s" ? "Every hour" : props.mirror.interval}</dd>
        <dt>Branches</dt>
        <dd>{props.mirror.branchFilter || "All branches and tags"}</dd>
      </dl>
      <Show
        when={props.confirming}
        fallback={
          <button
            type="button"
            class="quiet-button"
            disabled={props.busy}
            onClick={props.onStartRemove}
          >
            Remove mirror…
          </button>
        }
      >
        <p>
          Stop future pushes to this target. The external repository and its code are not deleted.
        </p>
        <div class="control-actions">
          <button
            type="button"
            class="quiet-button"
            disabled={props.busy}
            onClick={props.onCancelRemove}
          >
            Keep mirror
          </button>
          <button
            type="button"
            class="danger-button"
            disabled={props.busy}
            onClick={props.onConfirmRemove}
          >
            Confirm removal
          </button>
        </div>
      </Show>
    </section>
  );
}

export function MirrorAddForm(props: {
  draft: MirrorDraftState;
  busy: boolean;
  pending: boolean;
  canCancel: boolean;
  targetRef(element: HTMLInputElement): void;
  onChange(patch: Partial<MirrorDraftState>): void;
  onCancel(): void;
  onSubmit(event: SubmitEvent): void;
}) {
  const tokenHelpID = `mirror-token-${createUniqueId()}`;
  return (
    <form class="repository-mirror-form" aria-label="Add a mirror" onSubmit={props.onSubmit}>
      <h3>Add a mirror</h3>
      <p>
        Create a private, dedicated repository first and disable its automation. Use a token limited
        to that repository with Git write access.
      </p>
      <label class="control-field">
        Target Git URL
        <input
          ref={props.targetRef}
          type="url"
          required
          autocomplete="off"
          placeholder="https://github.com/team/project.git"
          value={props.draft.target}
          disabled={props.busy}
          onInput={(event) =>
            props.onChange({ target: event.currentTarget.value, confirmed: false })
          }
        />
      </label>
      <div class="repository-mirror-access">
        <label class="control-field">
          Git username
          <input
            required
            autocomplete="off"
            value={props.draft.username}
            disabled={props.busy}
            onInput={(event) => props.onChange({ username: event.currentTarget.value })}
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
            value={props.draft.token}
            disabled={props.busy}
            onInput={(event) => props.onChange({ token: event.currentTarget.value })}
          />
        </label>
      </div>
      <p id={tokenHelpID} class="repository-mirror-help">
        Forgejo stores the token in the source repository's Git configuration, not in OpenBao.
        Forgejo does not encrypt it. Protect its storage and backups.
      </p>
      <label class="control-check">
        <input
          type="checkbox"
          required
          checked={props.draft.confirmed}
          disabled={props.busy}
          onChange={(event) => props.onChange({ confirmed: event.currentTarget.checked })}
        />
        This target is a dedicated mirror. Factory may overwrite and delete its Git refs.
      </label>
      <div class="control-actions">
        <Show when={props.canCancel}>
          <button type="button" class="quiet-button" disabled={props.busy} onClick={props.onCancel}>
            Cancel
          </button>
        </Show>
        <button
          type="submit"
          class="primary-button"
          disabled={props.busy || props.pending || !props.draft.token || !props.draft.confirmed}
        >
          Add mirror
        </button>
      </div>
    </form>
  );
}
