import { createEffect, createSignal, For, Show } from "solid-js";
import type { SetupTask, SetupTaskView } from "../../../../packages/project-domain/src/setup";
import { serverCall } from "../server-functions/result";
import { getSetupReadiness, retrySetupTask } from "../server-functions/setup";

const labels = {
  configuration: "Project configuration",
  "development-secrets": "Development settings",
  "preview-secrets": "Preview settings",
  protection: "Protected main branch",
  hook: "Automatic repository updates",
  wiki: "Project Wiki",
  development: "Development image preparation",
  "preview-image": "Preview image preparation",
  "main-preview": "Main Preview",
} as const satisfies Record<SetupTask, string>;

export function SetupReadiness(props: { projectID: string; canRetry?: boolean }) {
  const [rows, setRows] = createSignal<SetupTaskView[]>([]);
  const [error, setError] = createSignal("");
  const [reading, setReading] = createSignal(false);
  const [retrying, setRetrying] = createSignal<SetupTask>();
  const [refresh, setRefresh] = createSignal(0);
  createEffect(
    () => ({ projectID: props.projectID, refresh: refresh() }),
    ({ projectID }) => {
      let disposed = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      async function load() {
        setReading(true);
        try {
          const value = await serverCall(getSetupReadiness({ data: [projectID] }));
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
        } finally {
          if (!disposed) setReading(false);
        }
      }
      void load();
      return () => {
        disposed = true;
        if (timer) clearTimeout(timer);
      };
    },
  );
  async function retry(task: SetupTask) {
    if (retrying()) return;
    const projectID = props.projectID;
    setRetrying(task);
    try {
      const value = await serverCall(retrySetupTask({ data: [projectID, task] }));
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
        <For each={rows()} keyed={(row) => row.task}>
          {(row) => (
            <li data-state={row().state}>
              <span class="setup-task-indicator" role="img" aria-label={row().state}>
                {row().state === "ready" ? "✓" : row().state === "failed" ? "!" : ""}
              </span>
              <span>
                {labels[row().task]}
                <Show
                  when={
                    row().failure &&
                    (row().state === "failed" ||
                      (row().state === "ready" &&
                        (row().task === "development" || row().task === "preview-image")))
                  }
                >
                  <small>{row().failure}</small>
                </Show>
              </span>
              <Show when={row().state === "failed" && props.canRetry !== false}>
                <button
                  class="quiet-button"
                  type="button"
                  disabled={Boolean(retrying())}
                  onClick={() => void retry(row().task)}
                >
                  {retrying() === row().task ? "Retrying…" : "Retry"}
                </button>
              </Show>
            </li>
          )}
        </For>
      </ul>
      <Show when={error()}>
        <div class="control-actions">
          <p class="form-error" role="alert">
            {error()}
          </p>
          <button
            class="quiet-button"
            type="button"
            disabled={reading()}
            onClick={() => setRefresh((value) => value + 1)}
          >
            {reading() ? "Checking preparation status…" : "Retry preparation status"}
          </button>
        </div>
      </Show>
    </section>
  );
}
