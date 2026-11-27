import { type Accessor, createEffect, Show } from "solid-js";
import { CopyButton } from "../ui/feedback";
import type { ReleaseDialog } from "./settings-types";

export function ReleaseReference(props: { value: string; label: string }) {
  return (
    <div class="release-reference-row">
      <code class="release-reference">{props.value}</code>
      <CopyButton
        value={props.value}
        label="Copy"
        accessibleLabel={`Copy ${props.label}`}
        iconOnly={true}
        class="quiet-button"
      />
    </div>
  );
}

export function PublishConfirmation(props: {
  confirmation: Accessor<Extract<ReleaseDialog, { kind: "confirm-publish" }>>;
  busy: Accessor<boolean>;
  onConfirm: (pending: Extract<ReleaseDialog, { kind: "confirm-publish" }>) => void;
  onEdit: () => void;
}) {
  let heading: HTMLHeadingElement | undefined;
  createEffect(
    () => props.confirmation().commandID,
    () => {
      heading?.focus();
    },
  );
  return (
    <section class="release-confirmation" aria-label="Confirm publication">
      <h4 ref={heading} tabindex="-1">
        Publish {props.confirmation().version}?
      </h4>
      <dl class="release-facts">
        <dt>Exact commit</dt>
        <dd>
          <ReleaseReference value={props.confirmation().commitSHA} label="release commit" />
        </dd>
        <dt>Release notes</dt>
        <dd class="release-notes">{props.confirmation().notes || "No release notes."}</dd>
      </dl>
      <p>
        External systems may automatically deploy this version. Factory does not wait for them and
        cannot roll their changes back.
      </p>
      <div class="release-actions">
        <button
          type="button"
          class="primary-button"
          disabled={props.busy()}
          onClick={() => props.onConfirm(props.confirmation())}
        >
          {props.busy()
            ? "Requesting publication…"
            : `Publish version ${props.confirmation().version}`}
        </button>
        <button
          type="button"
          class="quiet-button"
          disabled={props.busy()}
          onClick={() => props.onEdit()}
        >
          Edit version
        </button>
      </div>
    </section>
  );
}

export function EndAttemptConfirmation(props: {
  busy: Accessor<boolean>;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <section class="release-confirmation" aria-label="End publication attempt">
      <h4 tabindex="-1">End this attempt?</h4>
      <p>
        Write access will be revoked and its Sandbox stopped. Existing publications and external
        deployments are not rolled back. Use a new version for another build.
      </p>
      <div class="release-actions">
        <button
          type="button"
          class="danger-button"
          disabled={props.busy()}
          onClick={() => props.onConfirm()}
        >
          Confirm end attempt
        </button>
        <button
          type="button"
          class="quiet-button"
          disabled={props.busy()}
          onClick={() => props.onCancel()}
        >
          Keep attempt
        </button>
      </div>
    </section>
  );
}

export function CredentialCard(props: {
  credential: Accessor<Extract<ReleaseDialog, { kind: "show-credential" }>>;
  onToggleReveal: () => void;
  onDismiss: () => void;
}) {
  let heading: HTMLHeadingElement | undefined;
  createEffect(
    () => true,
    () => {
      heading?.focus();
    },
  );
  return (
    <section class="release-confirmation" aria-label="New machine credential">
      <h4 ref={heading} tabindex="-1">
        Save this credential now
      </h4>
      <p>
        This token is shown only once. Put it in the consumer's secret store, not a chat or
        committed configuration.
      </p>
      <div class="release-credential-field">
        <label>
          Username
          <input
            readonly
            value={props.credential().username}
            autocomplete="off"
            spellcheck={false}
          />
        </label>
        <CopyButton
          value={props.credential().username}
          label="Copy"
          accessibleLabel="Copy username"
          class="quiet-button"
        />
      </div>
      <Show
        when={props.credential().token}
        fallback={
          <p>The token cannot be shown again. Rotate this access to obtain a new credential.</p>
        }
      >
        {(token) => (
          <div class="release-credential-field">
            <label>
              Access token
              <input
                readonly
                type={props.credential().revealed ? "text" : "password"}
                value={token()}
                autocomplete="off"
                spellcheck={false}
              />
            </label>
            <div class="release-actions">
              <button
                type="button"
                class="quiet-button"
                aria-pressed={props.credential().revealed ? "true" : "false"}
                onClick={() => props.onToggleReveal()}
              >
                {props.credential().revealed ? "Hide token" : "Show token"}
              </button>
              <CopyButton
                value={token()}
                label="Copy"
                accessibleLabel="Copy access token"
                class="quiet-button"
              />
            </div>
          </div>
        )}
      </Show>
      <p class="release-note">
        Chart reads and runtime image pulls need credentials in their respective systems. The
        operator configures both.
      </p>
      <button type="button" class="quiet-button" onClick={() => props.onDismiss()}>
        Dismiss credential
      </button>
    </section>
  );
}

export function RotateGrantConfirmation(props: {
  grantName: string;
  busy: Accessor<boolean>;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <section class="release-confirmation" aria-label="Rotate read credential">
      <h4 tabindex="-1">Rotate {props.grantName}?</h4>
      <p>
        The old credential stops working immediately. External systems cannot fetch new content
        until you install the replacement. Already downloaded content remains available.
      </p>
      <div class="release-actions">
        <button
          type="button"
          class="danger-button"
          disabled={props.busy()}
          onClick={() => props.onConfirm()}
        >
          Confirm rotation
        </button>
        <button
          type="button"
          class="quiet-button"
          disabled={props.busy()}
          onClick={() => props.onCancel()}
        >
          Keep credential
        </button>
      </div>
    </section>
  );
}

export function RevokeGrantConfirmation(props: {
  grantName: string;
  busy: Accessor<boolean>;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <section class="release-confirmation" aria-label="Revoke read credential">
      <h4 tabindex="-1">Revoke {props.grantName}?</h4>
      <p>
        External systems using this credential will no longer be able to fetch source or artifacts.
        Already downloaded content cannot be recalled.
      </p>
      <div class="release-actions">
        <button
          type="button"
          class="danger-button"
          disabled={props.busy()}
          onClick={() => props.onConfirm()}
        >
          Confirm revocation
        </button>
        <button
          type="button"
          class="quiet-button"
          disabled={props.busy()}
          onClick={() => props.onCancel()}
        >
          Keep access
        </button>
      </div>
    </section>
  );
}
