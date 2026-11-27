import { type Accessor, createEffect, createMemo, createSignal, untrack } from "solid-js";
import type { z } from "zod";
import type { MCPLibraryView } from "#conversation-domain/mcp-library";
import type { monitoringView } from "#conversation-domain/monitoring";
import { plainErrorMessage } from "../command-error";
import { getProjectInputs } from "../server-functions/inputs";
import { getMCPLibrary } from "../server-functions/mcp";
import { serverCall } from "../server-functions/result";
import { observeFactoryRead } from "../zero/reads";

type View = z.infer<typeof monitoringView>;

function createReadChannel<T>(options: {
  scope: Accessor<string | undefined>;
  getGeneration: () => number;
  fetch: (id: string, signal?: AbortSignal) => Promise<T>;
  fallbackError: string;
}) {
  const [data, setData] = createSignal<{ projectID: string; view: T }>();
  const [error, setError] = createSignal("");
  const [busy, setBusy] = createSignal(false);
  let version = 0;

  async function read(id: string, signal?: AbortSignal) {
    const epoch = options.getGeneration();
    const request = ++version;
    const current = () =>
      epoch === options.getGeneration() &&
      request === version &&
      untrack(options.scope) === id &&
      !signal?.aborted;
    setBusy(true);
    try {
      const view = await options.fetch(id, signal);
      if (current()) {
        setData({ projectID: id, view });
        setError("");
      }
    } catch (cause) {
      if (current()) {
        setError(cause instanceof Error ? plainErrorMessage(cause.message) : options.fallbackError);
      }
    } finally {
      if (current()) setBusy(false);
    }
  }

  function reset() {
    setError("");
    setBusy(false);
  }

  return { data, error, busy, read, reset };
}

// Activity and source configuration invalidate independently. Neither observer
// admits a command, repeats a failed command or discards an editable Input draft.
export function createInputReads(
  projectID: Accessor<string | undefined>,
  active: Accessor<boolean>,
) {
  const scope = createMemo(() => (active() ? projectID() : undefined));
  let generation = 0;
  let observed = false;

  const inputs = createReadChannel<View>({
    scope,
    getGeneration: () => generation,
    fetch: (id, signal) =>
      serverCall(getProjectInputs({ data: [id], ...(signal ? { signal } : {}) })),
    fallbackError: "Inputs could not load.",
  });
  const sources = createReadChannel<MCPLibraryView>({
    scope,
    getGeneration: () => generation,
    fetch: (id, signal) => serverCall(getMCPLibrary({ data: [id], ...(signal ? { signal } : {}) })),
    fallbackError: "Sources could not load.",
  });

  const source = (kind: "inputs" | "sources") => () => {
    const id = scope();
    return id ? { projectId: id, scope: kind, resourceId: id } : null;
  };

  async function reload(id = untrack(scope)) {
    if (id) await Promise.all([inputs.read(id), sources.read(id)]);
  }

  createEffect(scope, (id) => {
    generation++;
    inputs.reset();
    sources.reset();
    if (id && !observed) void reload(id);
    return () => {
      generation++;
    };
  });

  observed = observeFactoryRead(source("inputs"), async (signal) => {
    const id = untrack(scope);
    if (id) await inputs.read(id, signal);
  });
  observeFactoryRead(source("sources"), async (signal) => {
    const id = untrack(scope);
    if (id) await sources.read(id, signal);
  });

  return {
    view: () => (inputs.data()?.projectID === projectID() ? inputs.data()?.view : undefined),
    sources: () => (sources.data()?.projectID === projectID() ? sources.data()?.view : undefined),
    loading: () => inputs.busy() || sources.busy(),
    error: () => inputs.error() || sources.error(),
    reload,
  };
}
