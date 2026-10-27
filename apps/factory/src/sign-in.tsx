import { createSignal, Show } from "solid-js";
import type { DesktopBackgroundKey } from "../../../packages/interface-domain/src/background";
import { factoryIdentityClient } from "./auth-client";

export function SignIn(props: {
  error: string;
  setError(value: string): void;
  background: DesktopBackgroundKey;
  companySignIn?: boolean;
}) {
  const [pending, setPending] = createSignal(false);
  const [emergency, setEmergency] = createSignal(false);
  async function company() {
    setPending(true);
    props.setError("");
    try {
      const response = await factoryIdentityClient.signIn.sso({
        providerId: "company",
        callbackURL: location.href,
      });
      if (response.error) throw new Error(response.error.message ?? "Company sign-in failed");
      if (response.data?.url) location.assign(response.data.url);
    } catch (cause) {
      props.setError(cause instanceof Error ? cause.message : "Company sign-in failed");
      setPending(false);
    }
  }

  async function signIn(event: SubmitEvent) {
    event.preventDefault();
    const form = new FormData(event.currentTarget as HTMLFormElement);
    setPending(true);
    props.setError("");
    try {
      const response = await factoryIdentityClient.signIn.email({
        email: String(form.get("email")),
        password: String(form.get("password")),
      });
      if (response.error) throw new Error(response.error.message ?? "Sign in failed");
      if (response.data?.url) {
        location.assign(response.data.url);
        return;
      }
      location.reload();
    } catch (cause) {
      props.setError(cause instanceof Error ? cause.message : "Sign in failed");
      setPending(false);
    }
  }

  return (
    <main class="signin" data-background={props.background}>
      <section class="signin-brand">
        <p class="brand-mark">Open Software Factory</p>
        <h1>From intent to running software.</h1>
        <p>Plan the work, direct the agent, inspect the result.</p>
        <div class="runtime-diagram" aria-hidden="true">
          <span>Clarify</span>
          <i />
          <span>Build</span>
          <i />
          <span>Review</span>
          <i />
          <span>Merge</span>
        </div>
      </section>
      <section class="signin-form">
        <form onSubmit={signIn}>
          <p class="eyebrow">Account access</p>
          <h2>Sign in</h2>
          <p class="signin-copy">Open your Factory workspace.</p>
          <Show when={props.companySignIn && !emergency()}>
            <button type="button" disabled={pending()} onClick={() => void company()}>
              {pending() ? "Opening company sign-in" : "Continue with company account"}
            </button>
            <button
              type="button"
              class="quiet-button"
              disabled={pending()}
              onClick={() => setEmergency(true)}
            >
              Emergency administrator
            </button>
          </Show>
          <div hidden={props.companySignIn && !emergency()}>
            <label for="email">Email</label>
            <input id="email" name="email" type="email" autocomplete="email" required />
            <label for="password">Password</label>
            <input
              id="password"
              name="password"
              type="password"
              autocomplete="current-password"
              minlength="12"
              required
            />
            <button type="submit" disabled={pending()}>
              {pending() ? "Signing in" : "Sign in"}
            </button>
          </div>
          <Show when={props.error}>
            <p class="error" role="alert">
              {props.error}
            </p>
          </Show>
          <p class="managed-access">
            {props.companySignIn
              ? "Only the separately secured emergency administrator uses a local password."
              : "Use the account provided by your Factory administrator."}
          </p>
        </form>
      </section>
    </main>
  );
}
