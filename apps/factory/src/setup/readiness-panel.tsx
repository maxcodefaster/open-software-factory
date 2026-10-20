import { createEffect, createSignal, For, onCleanup, Show } from "solid-js";
import {
  type SetupTask,
  type SetupTaskView,
  setupReadiness,
} from "../../../../packages/project-domain/src/setup";
import { apiRequest } from "../api-client";

const labels = {
  configuration: "Project configuration",
  "development-secrets": "Development settings",
  "preview-secrets": "Preview settings",
  protection: "Protected main branch",
  hook: "Automatic repository updates",
  wiki: "Project Wiki",
  development: "Development image",
  "preview-image": "Preview image",
  "main-preview": "Main Preview",
} as const satisfies Record<SetupTask, string>;

export function SetupReadiness(props: { projectID: string }) {
  const [rows, setRows] = createSignal<SetupTaskView[]>([]);
  const [error, setError] = createSignal("");
  const [retrying, setRetrying] = createSignal<SetupTask>();
  const [refresh, setRefresh] = createSignal(0);
  createEffect(
    () => ({ projectID: props.projectID, refresh: refresh() }),
    ({ projectID }) => {
      let disposed = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      async function load() {
        try {
          const value = await apiRequest(setupReadiness, `/api/projects/${projectID}/setup`);
          if (disposed) return;
          setRows(value);
          setError("");
          if (
            !value.length ||
            value.some((row) => row.state === "pending" || row.state === "running")
          )
            timer = setTimeout(() => void load(), 2500);
        } catch {
          if (!disposed) setError("Preparation status is unavailable. Your project is retained.");
        }
      }
      void load();
      onCleanup(() => {
        disposed = true;
        if (timer) clearTimeout(timer);
      });
    },
  );
  async function retry(task: SetupTask) {
    if (retrying()) return;
    const projectID = props.projectID;
    setRetrying(task);
    try {
      const value = await apiRequest(setupReadiness, `/api/projects/${projectID}/setup/retry`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ task }),
      });
      if (props.projectID === projectID) {
        setRows(value);
        setRefresh((value) => value + 1);
      }
    } catch {
      setError("This step could not restart. Other project work stays available.");
    } finally {
      setRetrying(undefined);
    }
  }
  return (
    <section class="setup-readiness" aria-label="Project preparation">
      <p>Planning is available while your Wiki and environments prepare.</p>
      <ul>
        <For each={rows()}>
          {(row) => (
            <li data-state={row.state}>
              <span class="setup-task-indicator" role="img" aria-label={row.state}>
                {row.state === "ready" ? "✓" : row.state === "failed" ? "!" : ""}
              </span>
              <span>
                {labels[row.task]}
                <Show when={row.state === "failed" && row.failure}>
                  <small>{row.failure}</small>
                </Show>
              </span>
              <Show when={row.state === "failed"}>
                <button
                  class="quiet-button"
                  type="button"
                  disabled={Boolean(retrying())}
                  onClick={() => void retry(row.task)}
                >
                  {retrying() === row.task ? "Retrying…" : "Retry"}
                </button>
              </Show>
            </li>
          )}
        </For>
      </ul>
      <Show when={error()}>
        <p class="form-error" role="alert">
          {error()}
        </p>
      </Show>
    </section>
  );
}
