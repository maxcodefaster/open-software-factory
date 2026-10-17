import { render } from "@solidjs/web";
import { createSignal, Show } from "solid-js";
import { createAuthClient } from "better-auth/client";
import "./web.css";

const base = new URL(document.baseURI);
const auth = createAuthClient({
  baseURL: base.origin,
  basePath: `${base.pathname.replace(/\/$/, "")}/api/auth`,
});
function App() {
  const [name, setName] = createSignal<string | null | undefined>();
  const [signup, setSignup] = createSignal(false);
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal("");
  async function refresh() {
    const response = await fetch(new URL("api/session", base));
    const data = (await response.json()) as { name?: string };
    setName(response.ok ? (data.name ?? "") : null);
  }
  void refresh().catch(() => {
    setName(null);
    setError("Could not connect. Try again.");
  });
  async function submit(event: SubmitEvent) {
    event.preventDefault();
    if (busy()) return;
    setBusy(true);
    setError("");
    const form = new FormData(event.currentTarget as HTMLFormElement);
    const email = String(form.get("email"));
    const password = String(form.get("password"));
    try {
      const result = signup()
        ? await auth.signUp.email({ email, password, name: String(form.get("name")) })
        : await auth.signIn.email({ email, password });
      if (result.error) setError(result.error.message ?? "Could not sign in.");
      else {
        setSignup(false);
        await refresh();
      }
    } catch {
      setError("Could not connect. Try again.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <main>
      <Show when={name() !== undefined} fallback={<p role="status">Loading…</p>}>
        <Show
          when={name() !== null}
          fallback={
            <section>
              <h1>{signup() ? "Create your account" : "Welcome back"}</h1>
              <form onSubmit={(event) => void submit(event)}>
                <Show when={signup()}>
                  <label>
                    Name
                    <input name="name" autocomplete="name" required />
                  </label>
                </Show>
                <label>
                  Email
                  <input name="email" type="email" autocomplete="email" required />
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
                  />
                </label>
                <Show when={error()}>
                  <p role="alert">{error()}</p>
                </Show>
                <button type="submit" disabled={busy()}>
                  {busy() ? "Please wait…" : signup() ? "Create account" : "Sign in"}
                </button>
              </form>
              <button
                type="button"
                class="text-button"
                onClick={() => {
                  setSignup(!signup());
                  setError("");
                }}
              >
                {signup() ? "Already have an account? Sign in" : "Create an account"}
              </button>
            </section>
          }
        >
          <header>
            <span>{name()}</span>
            <button
              type="button"
              class="text-button"
              onClick={async () => {
                await auth.signOut();
                setName(null);
              }}
            >
              Sign out
            </button>
          </header>
          <section>
            <h1>You're home.</h1>
          </section>
        </Show>
      </Show>
    </main>
  );
}
const root = document.getElementById("app");
if (!root) throw new Error("Missing application root");
render(() => <App />, root);
