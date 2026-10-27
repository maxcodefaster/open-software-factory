import {
  type Accessor,
  createContext,
  createEffect,
  createMemo,
  createSignal,
  onCleanup,
  type ParentProps,
  untrack,
  useContext,
} from "solid-js";
import { zeroQueries } from "../../../../packages/zero-schema/src";
import { useZeroConnection, useZeroQuery } from "../../../../packages/zero-solid/src";
import { createInvalidatedRead } from "./invalidated-read";

export type ReadScope = {
  projectId: string;
  scope:
    | "lifecycle"
    | "ticket"
    | "conversation"
    | "review"
    | "knowledge"
    | "inputs"
    | "sources"
    | "releases";
  resourceId: string;
};
type ReadSource = ReadScope | "inbox" | null;
type ReadObserver = (
  source: Accessor<ReadSource>,
  read: (signal: AbortSignal) => Promise<void>,
  onError?: (cause: unknown) => void,
) => void;
export const FactoryReads = createContext<{
  observe: ReadObserver;
  errors: Accessor<readonly string[]>;
  retry(): void;
} | null>(null);

export function FactoryReadProvider(props: ParentProps) {
  const connection = useZeroConnection();
  const [errors, setErrors] = createSignal<Record<string, string>>({});
  const retries = new Set<() => void>();
  const observe: ReadObserver = (source, read, onError) => {
    const versions = useZeroQuery(
      () => {
        const current = source();
        return current
          ? zeroQueries.readVersions.list(current === "inbox" ? { scope: "inbox" } : current)
          : null;
      },
      { ttl: "none" },
    );
    const id = crypto.randomUUID();
    const clearError = (key: string) =>
      setErrors((previous) => {
        if (!(key in previous)) return previous;
        const next = { ...previous };
        delete next[key];
        return next;
      });
    createEffect(versions.error, (error) => {
      setErrors((previous) => {
        const next = { ...previous };
        if (error) next[`${id}:query`] = error.message ?? "Shared updates could not load";
        else delete next[`${id}:query`];
        return next;
      });
    });
    onCleanup(() => {
      retries.delete(retry);
      setErrors((previous) => {
        const next = { ...previous };
        delete next[`${id}:query`];
        delete next[`${id}:read`];
        return next;
      });
    });
    const refresh = createInvalidatedRead({
      read: async (signal) => {
        // The version/source memo owns invalidation. The read captures current
        // command scope once and must not subscribe to the values it publishes.
        await untrack(() => read(signal));
        clearError(`${id}:read`);
      },
      visible: () => !document.hidden && untrack(() => Boolean(source())),
      onError: (cause) => {
        setErrors((previous) => ({ ...previous, [`${id}:read`]: "Shared reads are unavailable" }));
        onError?.(cause);
      },
    });
    const retry = () => {
      versions.retry();
      void refresh.refresh();
    };
    retries.add(retry);
    createEffect(
      () => JSON.stringify(source()),
      () => {
        clearError(`${id}:read`);
      },
    );
    const observation = createMemo(
      () => ({
        source: JSON.stringify(source()),
        revisions: versions
          .data()
          ?.map((row) => `${row.audience}:${row.resourceId}:${row.revision}`)
          .join("|"),
        complete: versions.completeness(),
        connected: connection.state()?.name === "connected",
      }),
      {
        equals: (a, b) =>
          a?.source === b?.source &&
          a?.revisions === b?.revisions &&
          a?.complete === b?.complete &&
          a?.connected === b?.connected,
      },
    );
    createEffect(observation, (current) => {
      if (current.source !== "null" && current.complete === "complete" && current.connected)
        void refresh.refresh();
    });
    createEffect(
      () => true,
      () => {
        const wake = () => {
          if (!document.hidden) void refresh.refresh();
        };
        window.addEventListener("focus", wake);
        document.addEventListener("visibilitychange", wake);
        return () => {
          refresh.stop();
          window.removeEventListener("focus", wake);
          document.removeEventListener("visibilitychange", wake);
        };
      },
    );
  };
  return FactoryReads({
    value: {
      observe,
      errors: () => Object.values(errors()),
      retry: () => {
        for (const retry of retries) retry();
      },
    },
    get children() {
      return props.children;
    },
  });
}

// Standalone UI fixtures keep their explicit initial/read actions. Production
// mounts these components under FactoryReadProvider, never a polling fallback.
export function observeFactoryRead(
  source: Accessor<ReadSource>,
  read: (signal: AbortSignal) => Promise<void>,
  onError?: (cause: unknown) => void,
) {
  const owner = useContext(FactoryReads);
  owner?.observe(source, read, onError);
  return Boolean(owner);
}

export function useFactoryReadStatus() {
  return useContext(FactoryReads);
}
