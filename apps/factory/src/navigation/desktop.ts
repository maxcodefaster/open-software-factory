import { createEffect, createSignal, onCleanup, untrack } from "solid-js";
import { type FactoryLocation, factoryPath } from "./location";
import type { FactoryNavigation } from "./router";

export const unavailableLink =
  "This link is unavailable. You may not have access, or the item was removed.";

// Coordinates route intent with a persistent desktop. Internal selections are
// already applied; Back/Forward and direct links must restore the resource.
export function createDesktopNavigation(options: {
  navigation: FactoryNavigation | undefined;
  ready(): boolean;
  accessKey(): string;
  apply(location: FactoryLocation, current: () => boolean): Promise<void> | void;
}) {
  const [failure, setFailure] = createSignal("");
  const [pending, setPending] = createSignal(false);
  const [retries, setRetries] = createSignal(0);
  let version = 0,
    applying = false,
    opening = false;
  let last: string | undefined, lastPath: string | undefined, published: string | undefined;
  onCleanup(() => version++);
  createEffect(
    () => ({
      path: options.navigation?.path(),
      location: options.navigation?.location(),
      ready: options.ready(),
      access: options.accessKey(),
      retry: retries(),
    }),
    (value) => {
      if (!value.path || !value.location) return;
      const location = value.location;
      if (!value.ready) {
        // A reconnect may temporarily make cached query completeness unknown.
        // It must not replay an already-open route and hide a local draft.
        if (opening || value.path !== lastPath) {
          version++;
          last = undefined;
          opening = false;
          setPending(false);
        }
        return;
      }
      const key = JSON.stringify([value.path, value.access, value.retry]);
      if (key === last) return;
      last = key;
      const request = ++version;
      setFailure("");
      setPending(false);
      const pathChanged = lastPath !== value.path;
      lastPath = value.path;
      if (published === value.path && pathChanged) {
        published = undefined;
        return;
      }
      published = undefined;
      opening = true;
      setPending(true);
      let operation: Promise<void> | void;
      applying = true;
      try {
        // Route intent is fully tracked above. Applying it is an imperative
        // transition, not a subscription to every editor/window it inspects.
        operation = untrack(() => options.apply(location, () => request === version));
      } catch {
        opening = false;
        setFailure(unavailableLink);
        setPending(false);
        return;
      } finally {
        applying = false;
      }
      void Promise.resolve(operation).then(
        () => {
          if (request === version) {
            opening = false;
            setPending(false);
          }
        },
        () => {
          if (request === version) {
            opening = false;
            setFailure(unavailableLink);
            setPending(false);
          }
        },
      );
    },
  );
  return {
    failure,
    pending,
    retry() {
      if (options.navigation?.failure()) {
        options.navigation.retry();
        return;
      }
      last = undefined;
      setRetries((value) => value + 1);
    },
    publish(location: Exclude<FactoryLocation, { view: "unavailable" }>, replace = false) {
      if (!options.navigation || applying) return;
      version++;
      opening = false;
      setFailure("");
      setPending(false);
      const path = factoryPath(location);
      published = path === options.navigation.path() ? undefined : path;
      options.navigation.open(location, replace);
    },
  };
}
