import { createMemo, createSignal, Errored, Loading, refresh, Show } from "solid-js";
import { createAuthClient } from "better-auth/client";
import { getSession } from "./server-functions/session.ts";

import { applicationBase } from "./base.ts";

let auth: ReturnType<typeof createAuthClient> | undefined;
function authClient() {
  auth ??= createAuthClient({
    baseURL: window.location.origin,
    basePath: `${applicationBase()}/api/auth`,
  });
  return auth;
}
function AuthForm(props: { onAuthenticated(): Promise<unknown> }) {
  const [signup, setSignup] = createSignal(false);
  const [pending, setPending] = createSignal(false);
  const [error, setError] = createSignal("");
  // Signal writes are batched. Guard the request synchronously too.
  let submitting = false;

  async function submit(event: SubmitEvent) {
    event.preventDefault();
    if (submitting) return;
    const form = new FormData(event.currentTarget as HTMLFormElement);
    submitting = true;
    setPending(true);
    setError("");
    try {
      const email = String(form.get("email") ?? "");
      const password = String(form.get("password") ?? "");
      const result = signup()
        ? await authClient().signUp.email({ email, password, name: String(form.get("name") ?? "") })
        : await authClient().signIn.email({ email, password });
      if (result.error) {
        setError(result.error.message ?? "Could not sign in.");
        return;
      }
      // A failed session read can be retried without submitting credentials again.
      await props.onAuthenticated();
    } catch {
      setError("Could not connect. Try again.");
    } finally {
      submitting = false;
      setPending(false);
    }
  }
  return (
    <section>
      <h1>{signup() ? "Create your account" : "Welcome back"}</h1>
      <form onSubmit={(event) => void submit(event)} aria-busy={pending() ? "true" : "false"}>
        <Show when={signup()}>
          <label>
            Name
            <input name="name" autocomplete="name" required disabled={pending()} />
          </label>
        </Show>
        <label>
          Email
          <input name="email" type="email" autocomplete="email" required disabled={pending()} />
        </label>
        <label>
          Password
          <input
            name="password"
            type="password"
            minlength={12}
            maxlength={128}
            autocomplete={signup() ? "new-password" : "current-password"}
            required
            disabled={pending()}
          />
        </label>
        <Show when={error()}>
          <p role="alert">{error()}</p>
        </Show>
        <button type="submit" disabled={pending()}>
          {pending() ? "Please wait…" : signup() ? "Create account" : "Sign in"}
        </button>
      </form>
      <button
        type="button"
        class="text-button"
        disabled={pending()}
        onClick={() => {
          setSignup(!signup());
          setError("");
        }}
      >
        {signup() ? "Already have an account? Sign in" : "Create an account"}
      </button>
    </section>
  );
}

function Home(props: { name: string; onSignedOut(): Promise<unknown> }) {
  const [pending, setPending] = createSignal(false);
  const [error, setError] = createSignal("");
  let signingOut = false;
  async function signOut() {
    if (signingOut) return;
    signingOut = true;
    setPending(true);
    setError("");
    try {
      const result = await authClient().signOut();
      if (result.error) {
        setError(result.error.message ?? "Could not sign out.");
        return;
      }
      await props.onSignedOut();
    } catch {
      setError("Could not sign out. Check your connection and try again.");
    } finally {
      signingOut = false;
      setPending(false);
    }
  }
  return (
    <>
      <header>
        <span>{props.name}</span>
        <button
          type="button"
          class="text-button"
          disabled={pending()}
          onClick={() => void signOut()}
        >
          {pending() ? "Signing out…" : "Sign out"}
        </button>
      </header>
      <Show when={error()}>
        <p role="alert">{error()}</p>
      </Show>
      <section>
        <h1>You're home.</h1>
      </section>
    </>
  );
}

export function App() {
  const session = createMemo(() => getSession());
  const refreshSession = () => refresh(session);
  return (
    <main>
      <Errored
        fallback={(_error, retry) => (
          <section>
            <h1>Could not load your session</h1>
            <p role="alert">Check your connection and try again.</p>
            <button type="button" onClick={retry}>
              Try again
            </button>
          </section>
        )}
      >
        <Loading fallback={<p role="status">Loading…</p>}>
          <Show when={session()} fallback={<AuthForm onAuthenticated={refreshSession} />}>
            {(user) => <Home name={user().name} onSignedOut={refreshSession} />}
          </Show>
        </Loading>
      </Errored>
    </main>
  );
}
