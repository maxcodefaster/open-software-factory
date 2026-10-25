import { createEffect, createSignal, Loading, lazy, Match, Show, Switch } from "solid-js";
import { defaultDesktopBackgroundKey } from "../../../packages/interface-domain/src/background";
import type { Bootstrap } from "./api-contracts";
import { loadBootstrap } from "./bootstrap/client";
import { SignIn } from "./sign-in";

const AuthenticatedFactory = lazy(async () => ({
  default: (await import("./factory")).AuthenticatedFactory,
}));

export function Factory() {
  const [bootstrap, setBootstrap] = createSignal<Bootstrap>();
  const [error, setError] = createSignal("");
  function load() {
    setError("");
    void loadBootstrap()
      .then(setBootstrap)
      .catch((cause) =>
        setError(cause instanceof Error ? cause.message : "Factory failed to load"),
      );
  }
  createEffect(() => undefined, load);
  const authenticated = () => {
    const value = bootstrap();
    return value?.session ? { ...value, session: value.session } : undefined;
  };
  const opening = () => (
    <main class="loading" data-background={defaultDesktopBackgroundKey}>
      <Show when={error()} fallback={<span>Opening Factory</span>}>
        <p role="alert">{error()}</p>
        <button type="button" class="quiet-button" onClick={load}>
          Retry opening Factory
        </button>
      </Show>
    </main>
  );
  return (
    <Loading fallback={opening()}>
      <Switch>
        <Match when={bootstrap() === undefined}>{opening()}</Match>
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
  );
}
