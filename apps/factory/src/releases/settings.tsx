import { Show } from "solid-js";
import { Feedback } from "../ui/feedback";
import { ReleaseAccessPanel } from "./settings-access";
import { ReleasePublishPanel } from "./settings-publish";
import { createReleaseSettingsState } from "./settings-state";
import "./settings.css";

export function ReleaseSettings(props: { projectID: string; active: boolean }) {
  const state = createReleaseSettingsState(props);

  return (
    <section
      class="release-settings"
      aria-label="Project releases"
      aria-busy={state.busy() ? "true" : "false"}
    >
      <p class="release-note">
        Publish versioned source and artifacts. Deployment and operation stay with your external
        systems.
      </p>
      <div class="release-toolbar">
        <Show when={state.view()?.canManageAccess}>
          <nav class="release-tabs" aria-label="Release sections">
            <button
              type="button"
              aria-pressed={state.panel() === "versions" ? "true" : "false"}
              onClick={() => state.choosePanel("versions")}
            >
              Versions
            </button>
            <button
              type="button"
              aria-pressed={state.panel() === "access" ? "true" : "false"}
              onClick={() => state.choosePanel("access")}
            >
              External access
            </button>
          </nav>
        </Show>
        <button
          type="button"
          class="quiet-button"
          disabled={state.busy()}
          onClick={() => state.refresh()}
        >
          Refresh releases
        </button>
      </div>
      <Show when={state.loadError()}>
        <p role="alert" class="release-error">
          {state.loadError()} {state.view() ? "Showing the last confirmed data." : ""}
        </p>
      </Show>
      <Show when={state.error()}>
        <p role="alert" class="release-error">
          {state.error()}
        </p>
      </Show>
      <Show when={state.notice()}>
        <Feedback state="success" message={state.notice()} />
      </Show>
      <Show
        when={state.view()}
        fallback={
          <p role="status">
            {state.loadError() ? "Release details are unavailable." : "Loading releases…"}
          </p>
        }
      >
        {(data) => (
          <>
            <Show when={state.panel() === "versions" || !data().canManageAccess}>
              <ReleasePublishPanel data={data} state={state} />
            </Show>
            <Show when={state.panel() === "access" && data().canManageAccess}>
              <ReleaseAccessPanel active={props.active} data={data} state={state} />
            </Show>
          </>
        )}
      </Show>
    </section>
  );
}
