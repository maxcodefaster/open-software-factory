import { createMemo, createSignal, Errored, Loading, lazy, Match, Show, Switch } from "solid-js";
import { defaultDesktopBackgroundKey } from "../../../packages/interface-domain/src/background";
import { loadBootstrap } from "./bootstrap/client";
import { SignIn } from "./sign-in";

const AuthenticatedFactory = lazy(async () => ({
  default: (await import("./factory")).AuthenticatedFactory,
}));

export function Factory() {
  const bootstrap = createMemo(() => loadBootstrap());
  const [error, setError] = createSignal("");
  const authenticated = () => {
    const value = bootstrap();
    return value?.session ? { ...value, session: value.session } : undefined;
  };
  const opening = (message?: () => string, retry?: () => void) => (
    <main class="loading" data-background={defaultDesktopBackgroundKey}>
      <Show when={message} fallback={<span>Opening Factory</span>}>
        <p role="alert">{message?.()}</p>
        <button type="button" class="quiet-button" onClick={retry}>
          Retry opening Factory
        </button>
      </Show>
    </main>
  );
  return (
    <Errored
      fallback={(cause, retry) =>
        opening(() => {
          const error = cause();
          return error instanceof Error ? error.message : "Factory failed to load";
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
          <Match when={authenticated()}>{(value) => <AuthenticatedFactory {...value()} />}</Match>
        </Switch>
      </Loading>
    </Errored>
  );
}
