import { createEffect, createSignal, Show } from "solid-js";
import { emptyResponseSchema, protocolRequest } from "../api-client";
import { plainErrorMessage } from "../command-error";
import {
  endOwnSessions,
  getPasswordChangeState,
  getSecurityPolicy,
  getSignOutDestination,
} from "../server-functions/access";
import { type ServerValue, serverCall } from "../server-functions/result";
import "./settings.css";
import { FreshAuthentication } from "./fresh-authentication";
import { IdentitySettings } from "./identity-settings";
import { PasswordChange } from "./password-change";

export function SecuritySettings(props: { company: boolean; beforeCompanySignIn?: () => void }) {
  const [policy, setPolicy] = createSignal<ServerValue<ReturnType<typeof getSecurityPolicy>>>();
  const [error, setError] = createSignal("");
  const [loadError, setLoadError] = createSignal("");
  const [busy, setBusy] = createSignal(false);
  const [confirm, setConfirm] = createSignal(false);
  const [fresh, setFresh] = createSignal(true);
  const [canChangePassword, setCanChangePassword] = createSignal(false);
  function load() {
    setLoadError("");
    void Promise.all([
      serverCall(getSecurityPolicy({ data: [] })),
      serverCall(getPasswordChangeState({ data: [] })),
    ])
      .then(([nextPolicy, passwordState]) => {
        setPolicy(nextPolicy);
        setCanChangePassword(passwordState.available);
      })
      .catch((cause) =>
        setLoadError(
          cause instanceof Error
            ? plainErrorMessage(cause.message)
            : "Could not load security settings",
        ),
      );
  }
  createEffect(
    () => undefined,
    () => load(),
  );
  async function endAll() {
    setBusy(true);
    setError("");
    try {
      await serverCall(endOwnSessions({ data: [] }));
      location.reload();
    } catch (cause) {
      setError(
        cause instanceof Error ? plainErrorMessage(cause.message) : "Could not end sessions",
      );
      setBusy(false);
    }
  }
  async function signOut() {
    setBusy(true);
    setError("");
    try {
      const destination = await serverCall(getSignOutDestination({ data: [] }));
      await protocolRequest(emptyResponseSchema, "/api/auth/sign-out", { method: "POST" });
      if (destination.forgeLogoutURL) location.assign(destination.forgeLogoutURL);
      else location.reload();
    } catch (cause) {
      setError(cause instanceof Error ? plainErrorMessage(cause.message) : "Could not sign out");
      setBusy(false);
    }
  }
  return (
    <section
      class="access-settings model-settings-body access-settings-body"
      aria-label={props.company ? "Company sign-in" : "Login & security"}
    >
      <FreshAuthentication beforeCompanySignIn={props.beforeCompanySignIn} onFresh={setFresh} />
      <Show
        when={props.company}
        fallback={
          <Show when={policy()}>
            {(value) => (
              <section>
                <h3>Sign-in</h3>
                <p class="model-settings-note">
                  {value().companySignIn ? "Company single sign-on" : "Managed Factory accounts"}.
                  Browser sessions renew with activity for {value().sessionDays} days.
                </p>
              </section>
            )}
          </Show>
        }
      >
        <IdentitySettings beforeCompanySignIn={props.beforeCompanySignIn} />
      </Show>
      <Show when={!props.company && canChangePassword()}>
        <PasswordChange fresh={fresh()} />
      </Show>
      <Show when={!props.company}>
        <section>
          <h3>Sessions</h3>
          <p class="model-settings-note">
            Signing out never stops an Agent or background work. Ending all browser sessions
            requires a recent sign-in.
          </p>
          <div class="access-confirm">
            <button
              type="button"
              class="quiet-button"
              disabled={busy()}
              onClick={() => void signOut()}
            >
              Sign out here
            </button>
            <Show
              when={confirm()}
              fallback={
                <button
                  type="button"
                  class="quiet-button"
                  disabled={busy()}
                  onClick={() => setConfirm(true)}
                >
                  End all browser sessions
                </button>
              }
            >
              <button
                type="button"
                class="quiet-button"
                disabled={busy()}
                onClick={() => setConfirm(false)}
              >
                Keep sessions
              </button>
              <button
                type="button"
                class="danger-button"
                disabled={busy()}
                onClick={() => void endAll()}
              >
                Confirm sign out everywhere
              </button>
            </Show>
          </div>
        </section>
        <Show when={loadError()}>
          <div class="model-settings-error">
            <p role="alert">{loadError()}</p>
            <button type="button" class="quiet-button" onClick={load}>
              Reload security settings
            </button>
          </div>
        </Show>
        <Show when={error()}>
          <p role="alert" class="error">
            {error()}
          </p>
        </Show>
      </Show>
    </section>
  );
}
