import { createMemo, createSignal, Errored, Loading, lazy, Match, Show, Switch } from "solid-js";
import { defaultDesktopBackgroundKey } from "../../../packages/interface-domain/src/background";
import { loadBootstrap } from "./bootstrap/client";
import { plainErrorMessage } from "./command-error";
import { SignIn } from "./sign-in";
import { MCPAuthorization, mcpAuthorizationQuery } from "./mcp/authorization";

const AuthenticatedFactory = lazy(async () => ({
  default: (await import("./factory")).AuthenticatedFactory,
}));

export function Factory() {
  const authorization = mcpAuthorizationQuery(window.location.href);
  const bootstrap = createMemo(() => loadBootstrap());
  const [error, setError] = createSignal("");
  const authenticated = () => {
    const value = bootstrap();
    return value?.session ? { ...value, session: value.session } : undefined;
  };
  const opening = (message?: () => string, retry?: () => void) => (
    <main class="loading" data-background={defaultDesktopBackgroundKey}>
      <h1 class="sr-only">Open Software Factory</h1>
      <Show when={message} fallback={<span>Opening Factory</span>}>
        <div class="loading-error">
          <p role="alert">{message?.()}</p>
          <button type="button" class="quiet-button" onClick={retry}>
            Retry opening Factory
          </button>
        </div>
      </Show>
    </main>
  );
  return (
    <Errored
      fallback={(cause, retry) =>
        opening(() => {
          const error = cause();
          return plainErrorMessage(
            error instanceof Error && error.message ? error.message : "Factory could not open.",
          );
        }, retry)
      }
    >
      <Loading fallback={opening()}>
        <Switch>
          <Match when={!bootstrap()?.session}>
            <SignIn
              companySignIn={bootstrap()?.identity.companySignIn ?? false}
              error={error()}
              setError={setError}
              background={
                bootstrap()?.uiPreference.desktopBackgroundKey ?? defaultDesktopBackgroundKey
              }
            />
          </Match>
          <Match when={authenticated()}>
            {(value) =>
              authorization ? (
                <MCPAuthorization query={authorization} userName={value().session.user.name} />
              ) : (
                <AuthenticatedFactory {...value()} />
              )
            }
          </Match>
        </Switch>
      </Loading>
    </Errored>
  );
}
