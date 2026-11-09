import { createMemo, createSignal, Loading, Show } from "solid-js";
import { factoryIdentityClient } from "../auth-client";
import { defaultDesktopBackgroundKey } from "../../../../packages/interface-domain/src/background";
import { getMCPAuthorization } from "../server-functions/access";
import { serverCall } from "../server-functions/result";

export function mcpAuthorizationQuery(url: string) {
  const parsed = new URL(url);
  const parameters = parsed.searchParams;
  return parameters.get("client_id")?.startsWith("factory-mcp-") && parameters.has("sig")
    ? parsed.search.slice(1)
    : undefined;
}

export function MCPAuthorization(props: { query: string; userName: string }) {
  const details = createMemo(() => serverCall(getMCPAuthorization({ data: [props.query] })));
  const [work, setWork] = createSignal(true);
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal("");
  async function decide(accept: boolean) {
    if (busy()) return;
    setBusy(true);
    setError("");
    try {
      const scopes = details()
        ?.scopes.filter((scope) => work() || scope !== "factory:work")
        .join(" ");
      const result = await factoryIdentityClient.oauth2.consent({
        accept,
        scope: scopes,
        oauth_query: props.query,
      });
      if (result.error)
        throw new Error(
          "Factory could not confirm this authorization. Nothing was granted by this page.",
        );
      const data = result.data;
      if (!data || !("url" in data) || typeof data.url !== "string")
        throw new Error("Authorization has no confirmed redirect.");
      window.location.assign(data.url);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "MCP authorization could not complete.");
      setBusy(false);
    }
  }
  return (
    <main
      class="signin"
      data-background={defaultDesktopBackgroundKey}
      aria-labelledby="mcp-authorization-title"
    >
      <section class="signin-brand">
        <p class="brand-mark">Open Software Factory</p>
        <h1 id="mcp-authorization-title">Your agent. Factory compute.</h1>
        <p>Connect a local coding client to your authorized development Workspaces.</p>
      </section>
      <section class="signin-form">
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void decide(true);
          }}
        >
          <h2>Connect to Factory</h2>
          <p>Signed in as {props.userName}.</p>
          <Loading fallback={<p role="status">Reading the requested access…</p>}>
            <Show when={details()}>
              {(request) => (
                <>
                  <p>
                    <strong>{request().name}</strong> requests access through Factory MCP.
                  </p>
                  <p>
                    It can read the Projects and Workspaces your account can access. Project
                    permissions still apply.
                  </p>
                  <Show when={request().scopes.includes("factory:work")}>
                    <label class="control-check">
                      <input
                        type="checkbox"
                        checked={work()}
                        disabled={busy()}
                        onChange={(event) => setWork(event.currentTarget.checked)}
                      />
                      Allow development tools, including files, commands and shared compute
                      controls.
                    </label>
                  </Show>
                  <p>Your local browser sessions and credentials are not transferred.</p>
                  <Show when={error()}>
                    <p role="alert">{error()}</p>
                  </Show>
                  <div class="control-actions">
                    <button
                      type="button"
                      class="quiet-button"
                      disabled={busy()}
                      onClick={() => void decide(false)}
                    >
                      Cancel
                    </button>
                    <button type="submit" class="primary-button" disabled={busy()}>
                      {busy() ? "Connecting…" : "Connect client"}
                    </button>
                  </div>
                </>
              )}
            </Show>
          </Loading>
        </form>
      </section>
    </main>
  );
}
