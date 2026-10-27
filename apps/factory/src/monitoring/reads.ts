import { type Accessor, createEffect, createMemo, createSignal, untrack } from "solid-js";
import type { z } from "zod";
import type { MCPLibraryView } from "../../../../packages/conversation-domain/src/mcp-library";
import type { monitoringView } from "../../../../packages/conversation-domain/src/monitoring";
import { getProjectInputs } from "../server-functions/inputs";
import { getMCPLibrary } from "../server-functions/mcp";
import { serverCall } from "../server-functions/result";
import { observeFactoryRead } from "../zero/reads";

type View = z.infer<typeof monitoringView>;

// Activity and source configuration invalidate independently. Neither observer
// admits a command, repeats a failed command or discards an editable Input draft.
export function createInputReads(
  projectID: Accessor<string | undefined>,
  active: Accessor<boolean>,
) {
  const scope = createMemo(() => (active() ? projectID() : undefined));
  const [inputs, setInputs] = createSignal<{ projectID: string; view: View }>();
  const [sources, setSources] = createSignal<{ projectID: string; view: MCPLibraryView }>();
  const [inputError, setInputError] = createSignal("");
  const [sourceError, setSourceError] = createSignal("");
  const [inputBusy, setInputBusy] = createSignal(false);
  const [sourceBusy, setSourceBusy] = createSignal(false);
  let generation = 0;
  let inputVersion = 0;
  let sourceVersion = 0;
  let observed = false;

  async function readInputs(id: string, signal?: AbortSignal) {
    const epoch = generation,
      request = ++inputVersion;
    const current = () =>
      epoch === generation && request === inputVersion && untrack(scope) === id && !signal?.aborted;
    setInputBusy(true);
    try {
      const view = await serverCall(
        getProjectInputs({ data: [id], ...(signal ? { signal } : {}) }),
      );
      if (current()) {
        setInputs({ projectID: id, view });
        setInputError("");
      }
    } catch (cause) {
      if (current())
        setInputError(cause instanceof Error ? cause.message : "Inputs could not load.");
    } finally {
      if (current()) setInputBusy(false);
    }
  }
  async function readSources(id: string, signal?: AbortSignal) {
    const epoch = generation,
      request = ++sourceVersion;
    const current = () =>
      epoch === generation &&
      request === sourceVersion &&
      untrack(scope) === id &&
      !signal?.aborted;
    setSourceBusy(true);
    try {
      const view = await serverCall(getMCPLibrary({ data: [id], ...(signal ? { signal } : {}) }));
      if (current()) {
        setSources({ projectID: id, view });
        setSourceError("");
      }
    } catch (cause) {
      if (current())
        setSourceError(cause instanceof Error ? cause.message : "Sources could not load.");
    } finally {
      if (current()) setSourceBusy(false);
    }
  }
  const source = (kind: "inputs" | "sources") => () => {
    const id = scope();
    return id ? { projectId: id, scope: kind, resourceId: id } : null;
  };
  async function reload(id = untrack(scope)) {
    if (id) await Promise.all([readInputs(id), readSources(id)]);
  }
  createEffect(scope, (id) => {
    generation++;
    setInputError("");
    setSourceError("");
    setInputBusy(false);
    setSourceBusy(false);
    if (id && !observed) void reload(id);
    return () => {
      generation++;
    };
  });
  observed = observeFactoryRead(source("inputs"), async (signal) => {
    const id = untrack(scope);
    if (id) await readInputs(id, signal);
  });
  observeFactoryRead(source("sources"), async (signal) => {
    const id = untrack(scope);
    if (id) await readSources(id, signal);
  });
  return {
    view: () => (inputs()?.projectID === projectID() ? inputs()?.view : undefined),
    sources: () => (sources()?.projectID === projectID() ? sources()?.view : undefined),
    loading: () => inputBusy() || sourceBusy(),
    error: () => inputError() || sourceError(),
    reload,
  };
}
