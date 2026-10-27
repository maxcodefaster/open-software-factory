import { createEffect, createSignal, Show } from "solid-js";
import { emptyResponseSchema, protocolRequest } from "../api-client";
import {
  endOwnSessions,
  getSecurityPolicy,
  getSignOutDestination,
} from "../server-functions/access";
import { type ServerValue, serverCall } from "../server-functions/result";
import "./settings.css";
import { FreshAuthentication } from "./fresh-authentication";
import { IdentitySettings } from "./identity-settings";

export function SecuritySettings(props: { company: boolean; beforeCompanySignIn?: () => void }) {
  const [policy, setPolicy] = createSignal<ServerValue<ReturnType<typeof getSecurityPolicy>>>();
  const [error, setError] = createSignal("");
  const [busy, setBusy] = createSignal(false);
  const [confirm, setConfirm] = createSignal(false);
  createEffect(
    () => undefined,
    () => {
      void serverCall(getSecurityPolicy({ data: [] }))
        .then(setPolicy)
        .catch((cause) =>
          setError(cause instanceof Error ? cause.message : "Could not load security settings"),
        );
    },
  );
  async function endAll() {
    setBusy(true);
    setError("");
    try {
      await serverCall(endOwnSessions({ data: [] }));
      location.reload();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not end sessions");
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
      setError(cause instanceof Error ? cause.message : "Could not sign out");
      setBusy(false);
    }
  }
  return (
    <section
      class="access-settings model-settings-body access-settings-body"
      aria-label={props.company ? "Company sign-in" : "Login & security"}
    >
      <FreshAuthentication beforeCompanySignIn={props.beforeCompanySignIn} />
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
      <Show when={!props.company}>
        <section>
          <h3>Browser sessions</h3>
          <p class="model-settings-note">
            Signing out never stops an Agent. Local Git credentials and other devices stay signed
            in.
          </p>
          <button
            type="button"
            class="quiet-button"
            disabled={busy()}
            onClick={() => void signOut()}
          >
            Sign out here
          </button>
        </section>
        <section>
          <h3>All your devices</h3>
          <p class="model-settings-note">
            End all Factory browser sessions. Background work continues. Recent sign-in is required.
          </p>
          <Show
            when={confirm()}
            fallback={
              <button type="button" class="quiet-button" onClick={() => setConfirm(true)}>
                End all browser sessions
              </button>
            }
          >
            <div class="access-confirm">
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
            </div>
          </Show>
        </section>
        <Show when={error()}>
          <p role="alert" class="error">
            {error()}
          </p>
        </Show>
      </Show>
    </section>
  );
}
