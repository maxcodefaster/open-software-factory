import { createEffect, createSignal, Show } from "solid-js";
import { z } from "zod";
import { apiRequest } from "../api-client";
const setting = z.object({ enabled: z.boolean() });
export function RecordingSettings(props: { projectID: string; canManage: boolean }) {
  const [enabled, setEnabled] = createSignal<boolean>();
  const [error, setError] = createSignal("");
  const [busy, setBusy] = createSignal(false);
  const path = () => `/api/projects/${props.projectID}/qa-recording`;
  createEffect(
    () => props.projectID,
    () => {
      let active = true;
      void apiRequest(setting, path())
        .then((value) => {
          if (active) setEnabled(value.enabled);
        })
        .catch(() => {
          if (active) setError("Recording settings could not load.");
        });
      return () => {
        active = false;
      };
    },
  );
  return (
    <section class="visual-review" aria-label="QA recording settings">
      <h3>QA recording</h3>
      <p>
        Record the independent review's browser flow, with scenario chapters in one video. No
        additional Sandbox is created.
      </p>
      <Show when={enabled() !== undefined}>
        <label>
          <input
            type="checkbox"
            checked={enabled()}
            disabled={!props.canManage || busy()}
            onChange={async (event) => {
              const next = event.currentTarget.checked;
              setBusy(true);
              setError("");
              try {
                setEnabled(
                  (
                    await apiRequest(setting, path(), {
                      method: "PUT",
                      headers: { "content-type": "application/json" },
                      body: JSON.stringify({ enabled: next }),
                    })
                  ).enabled,
                );
              } catch {
                setError("Recording setting could not save. Reload Settings to check.");
              } finally {
                setBusy(false);
              }
            }}
          />
          Record QA browser reviews
        </label>
      </Show>
      <p>
        A newer complete recording removes the previous video. Comments and saved frames remain. The
        last video expires 30 days after the Change finishes. A missing video does not fail QA.
      </p>
      <Show when={!props.canManage}>
        <p>Project Managers can change this setting.</p>
      </Show>
      <Show when={error()}>
        <p role="alert">{error()}</p>
      </Show>
    </section>
  );
}
