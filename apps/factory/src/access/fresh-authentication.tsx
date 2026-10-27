import { createEffect, createSignal, Show } from "solid-js";
import { factoryIdentityClient } from "../auth-client";
import { getAuthenticationState } from "../server-functions/access";
import { type ServerValue, serverCall } from "../server-functions/result";

export function FreshAuthentication(props: {
  active?: boolean | undefined;
  beforeCompanySignIn?: (() => void) | undefined;
}) {
  const [state, setState] = createSignal<ServerValue<ReturnType<typeof getAuthenticationState>>>();
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal("");
  createEffect(
    () => props.active !== false,
    (active) => {
      if (!active) return;
      let disposed = false;
      let pending = false;
      let refreshAgain = false;
      async function refresh() {
        if (disposed) return;
        if (pending) {
          refreshAgain = true;
          return;
        }
        pending = true;
        try {
          const current = await serverCall(getAuthenticationState({ data: [] }));
          if (!disposed) setState(current);
        } catch {
          if (!disposed)
            setError(
              "Identity confirmation is unavailable. Reload before changing security settings.",
            );
        } finally {
          pending = false;
          if (refreshAgain && !disposed) {
            refreshAgain = false;
            void refresh();
          }
        }
      }
      void refresh();
      const timer = setInterval(() => {
        if (!document.hidden) void refresh();
      }, 30_000);
      window.addEventListener("focus", refresh);
      return () => {
        disposed = true;
        clearInterval(timer);
        window.removeEventListener("focus", refresh);
      };
    },
  );
  async function signIn(password?: string) {
    const current = state();
    if (!current || busy()) return;
    setBusy(true);
    setError("");
    try {
      if (current.companySignIn) props.beforeCompanySignIn?.();
      const result = current.companySignIn
        ? await factoryIdentityClient.signIn.sso({
            providerId: "company",
            callbackURL: location.href,
          })
        : await factoryIdentityClient.signIn.email({
            email: current.email,
            password: password ?? "",
          });
      if (result.error) throw new Error(result.error.message ?? "Sign-in failed");
      if (current.companySignIn && result.data?.url) location.assign(result.data.url);
      else setState(await serverCall(getAuthenticationState({ data: [] })));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Sign-in failed");
    } finally {
      setBusy(false);
    }
  }
  return (
    <Show when={state() && !state()?.fresh}>
      <section class="access-reauth" aria-label="Confirm your identity">
        <h3>Confirm your identity</h3>
        <p class="model-settings-note">
          Sign in again before changing security settings. Your work and Agents keep running.
        </p>
        <Show
          when={state()?.companySignIn}
          fallback={
            <form
              onSubmit={(event) => {
                event.preventDefault();
                const form = event.currentTarget;
                const password = String(new FormData(form).get("password"));
                void signIn(password).finally(() => form.reset());
              }}
            >
              <label>
                Password
                <input
                  name="password"
                  type="password"
                  autocomplete="current-password"
                  required
                  disabled={busy()}
                />
              </label>
              <button type="submit" class="quiet-button" disabled={busy()}>
                Confirm identity
              </button>
            </form>
          }
        >
          <button
            type="button"
            class="quiet-button"
            disabled={busy()}
            onClick={() => void signIn()}
          >
            Continue with company account
          </button>
        </Show>
        <Show when={error()}>
          <p role="alert" class="error">
            {error()}
          </p>
        </Show>
      </section>
    </Show>
  );
}
