import { createEffect, createSignal, Show } from "solid-js";
import { Icon } from "../icon";
import type { KnowledgeGeneration } from "./contracts";
import { wikiGenerationProgress } from "./wiki-progress";

export function WorkspaceGenerationBanner(props: {
  generation?: KnowledgeGeneration | undefined;
  loading: boolean;
  hasPublishedPages: boolean;
  pending: boolean;
  onGenerate(): void;
}) {
  const [generationStartedAt, setGenerationStartedAt] = createSignal<number>();
  const [generationNow, setGenerationNow] = createSignal(Date.now());
  createEffect(
    () =>
      ["pending", "running"].includes(props.generation?.state ?? "")
        ? props.generation?.id
        : undefined,
    (id) => {
      if (!id) return setGenerationStartedAt(undefined);
      setGenerationStartedAt(Date.now());
      setGenerationNow(Date.now());
      const timer = setInterval(() => setGenerationNow(Date.now()), 15_000);
      return () => clearInterval(timer);
    },
  );

  return (
    <Show when={["pending", "running", "failed"].includes(props.generation?.state ?? "")}>
      <div class="knowledge-generation">
        <Show when={["pending", "running"].includes(props.generation?.state ?? "")}>
          <div>
            <span class={`generation-dot ${props.generation?.state}`} />
            <small role="status">Updating Wiki…</small>
          </div>
          <Show when={props.generation}>
            {(generation) => (
              <p class="generation-detail" aria-live="polite">
                {wikiGenerationProgress(
                  generation(),
                  generationStartedAt() === undefined
                    ? undefined
                    : generationNow() - (generationStartedAt() ?? 0),
                )}
              </p>
            )}
          </Show>
        </Show>
        <Show when={props.generation?.failure}>
          {(failure) => (
            <div class="knowledge-update-error">
              <p role="alert">
                {props.loading
                  ? "Wiki update failed."
                  : props.hasPublishedPages
                    ? "Update failed. Your saved pages are still available."
                    : "Wiki creation failed."}
              </p>
              <details>
                <summary>Update details</summary>
                <pre>{failure()}</pre>
              </details>
            </div>
          )}
        </Show>
        <Show when={props.generation?.state === "failed"}>
          <button
            type="button"
            class="quiet-button"
            disabled={
              props.pending || ["pending", "running"].includes(props.generation?.state ?? "")
            }
            onClick={props.onGenerate}
          >
            Retry update
          </button>
        </Show>
      </div>
    </Show>
  );
}

export function WorkspaceEmptyState(props: {
  loading: boolean;
  hasPublishedPages: boolean;
  generation?: KnowledgeGeneration | undefined;
  pending: boolean;
  onGenerate(): void;
}) {
  return (
    <div class="empty-workspace">
      <Icon name="knowledge" />
      <Show when={!props.loading} fallback={<p role="status">Loading Wiki…</p>}>
        <Show when={!props.hasPublishedPages} fallback={<p>Choose a Wiki page to read.</p>}>
          <p>
            {["pending", "running"].includes(props.generation?.state ?? "")
              ? "Project Wiki is being generated."
              : props.generation?.state === "failed"
                ? "No Wiki pages have been published yet."
                : "Generate Project Wiki from the current commit."}
          </p>
          <Show when={!["pending", "running", "failed"].includes(props.generation?.state ?? "")}>
            <button
              type="button"
              class="workspace-action"
              data-primary="true"
              disabled={props.pending}
              onClick={props.onGenerate}
            >
              Create Project Wiki
            </button>
          </Show>
        </Show>
      </Show>
    </div>
  );
}
