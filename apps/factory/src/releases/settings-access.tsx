import { type Accessor, For, Show } from "solid-js";
import type { ReleaseSettingsView } from "#project-domain/release";
import { FreshAuthentication } from "../access/fresh-authentication";
import {
  CredentialCard,
  ReleaseReference,
  RevokeGrantConfirmation,
  RotateGrantConfirmation,
} from "./settings-dialogs";
import type { ReleaseSettingsState } from "./settings-state";
import { focusDecision, type ReleaseDialog } from "./settings-types";

export function ReleaseAccessPanel(props: {
  active: boolean;
  data: Accessor<ReleaseSettingsView>;
  state: ReleaseSettingsState;
}) {
  const credential = (): Extract<ReleaseDialog, { kind: "show-credential" }> | undefined => {
    const current = props.state.dialog();
    return current.kind === "show-credential" ? current : undefined;
  };
  const rotationFor = (grantID: string) => {
    const current = props.state.dialog();
    return current.kind === "confirm-rotate" && current.grantID === grantID ? current : undefined;
  };
  const isRevoking = (grantID: string) => {
    const current = props.state.dialog();
    return current.kind === "confirm-revoke" && current.grantID === grantID;
  };

  return (
    <>
      <section aria-labelledby="release-access-heading">
        <h3 id="release-access-heading">External access</h3>
        <p>
          Give an external system read-only access to this Project. Use separate credentials for
          each consumer. Factory does not check its connection or deployment.
        </p>
        <dl class="release-facts">
          <dt>Repository</dt>
          <dd>
            <ReleaseReference value={props.data().repositoryURL} label="repository URL" />
          </dd>
          <dt>Registry</dt>
          <dd>
            <ReleaseReference
              value={`${props.data().registryURL}/${props.data().packageOwner}`}
              label="registry URL"
            />
          </dd>
        </dl>
        <FreshAuthentication active={props.active} />
        <Show when={!props.data().configured}>
          <p>
            Machine access requires the configured Forgejo administrator and encrypted credential
            store.
          </p>
        </Show>
        <Show when={credential()}>
          {(value) => (
            <CredentialCard
              credential={value}
              onToggleReveal={() => props.state.toggleCredentialReveal()}
              onDismiss={() => props.state.setDialog({ kind: "none" })}
            />
          )}
        </Show>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            props.state.submitAccess();
          }}
        >
          <fieldset
            class="release-fields"
            disabled={props.state.busy() || !props.data().configured}
          >
            <div class="release-access-fields">
              <label>
                Access name
                <input
                  value={props.state.name()}
                  onInput={(event) => props.state.setName(event.currentTarget.value)}
                  maxlength={100}
                  required
                  placeholder="Production image reader"
                />
              </label>
              <label>
                Read scope
                <select
                  value={props.state.scope()}
                  onChange={(event) =>
                    props.state.setScope(event.currentTarget.value as "git" | "packages")
                  }
                >
                  <option value="git">Project repository</option>
                  <option value="packages">Project packages</option>
                </select>
              </label>
            </div>
            <p class="release-note">
              {props.state.scope() === "git"
                ? "Reads this Project's source, including all branches and history."
                : "Reads all packages in this Project's private registry namespace."}
            </p>
          </fieldset>
          <button
            type="submit"
            class="primary-button"
            disabled={props.state.busy() || !props.data().configured || !props.state.name().trim()}
          >
            Create read access
          </button>
        </form>
      </section>
      <section aria-labelledby="release-readers-heading">
        <h3 id="release-readers-heading">Read credentials</h3>
        <Show
          when={props.data().access.length}
          fallback={
            <p class="release-note">
              No external access yet. Create a credential when a consumer needs it.
            </p>
          }
        >
          <ul class="release-list">
            <For each={props.data().access} keyed={(grant) => grant.id}>
              {(grant) => (
                <li class="release-grant">
                  <div class="release-section-heading">
                    <div>
                      <strong>{grant().name}</strong>
                      <p class="release-note">
                        {grant().scope === "git" ? "Repository read" : "Package read"} ·{" "}
                        {grant().state}
                      </p>
                    </div>
                    <Show when={grant().state !== "revoked"}>
                      <div class="release-actions">
                        <button
                          type="button"
                          class="quiet-button"
                          aria-label={`Rotate ${grant().name}`}
                          disabled={props.state.busy()}
                          onClick={(event) => {
                            props.state.setDialog({
                              kind: "confirm-rotate",
                              grantID: grant().id,
                              commandID: crypto.randomUUID(),
                            });
                            focusDecision(event.currentTarget);
                          }}
                        >
                          Rotate
                        </button>
                        <button
                          type="button"
                          class="danger-button"
                          aria-label={`Revoke ${grant().name}`}
                          disabled={props.state.busy()}
                          onClick={(event) => {
                            props.state.setDialog({
                              kind: "confirm-revoke",
                              grantID: grant().id,
                            });
                            focusDecision(event.currentTarget);
                          }}
                        >
                          Revoke
                        </button>
                      </div>
                    </Show>
                  </div>
                  <Show when={rotationFor(grant().id)}>
                    {(pending) => (
                      <RotateGrantConfirmation
                        grantName={grant().name}
                        busy={props.state.busy}
                        onConfirm={() =>
                          props.state.confirmRotation(grant().id, pending().commandID)
                        }
                        onCancel={() => props.state.setDialog({ kind: "none" })}
                      />
                    )}
                  </Show>
                  <Show when={isRevoking(grant().id)}>
                    <RevokeGrantConfirmation
                      grantName={grant().name}
                      busy={props.state.busy}
                      onConfirm={() => props.state.confirmRevocation(grant().id)}
                      onCancel={() => props.state.setDialog({ kind: "none" })}
                    />
                  </Show>
                </li>
              )}
            </For>
          </ul>
        </Show>
      </section>
    </>
  );
}
