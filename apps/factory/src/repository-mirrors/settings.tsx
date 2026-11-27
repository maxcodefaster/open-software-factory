import { createEffect, createSignal, For, Show, untrack } from "solid-js";
import { FreshAuthentication } from "../access/fresh-authentication";
import { getRepositoryMirrorProjects } from "../server-functions/repository-mirrors";
import { serverCall } from "../server-functions/result";
import type { ProjectsLoadState } from "./mirror-state";
import { ProjectMirrors } from "./project-mirrors";
import "./settings.css";

export function RepositoryMirrorSettings(props: {
  active: boolean;
  projectID?: string | undefined;
}) {
  const [projectsState, setProjectsState] = createSignal<ProjectsLoadState>({ kind: "loading" });
  let disposed = false;

  function loadProjects() {
    setProjectsState({ kind: "loading" });
    void serverCall(getRepositoryMirrorProjects({ data: [] })).then(
      (value) => {
        if (disposed) return;
        setProjectsState({
          kind: "loaded",
          projects: value,
          selectedID: value.find((item) => item.id === props.projectID)?.id ?? value[0]?.id ?? "",
        });
      },
      () => {
        if (!disposed)
          setProjectsState({
            kind: "error",
            message: "Projects could not be loaded. Check your connection, then try again.",
          });
      },
    );
  }

  createEffect(
    () => props.active,
    (active) => {
      if (!active || untrack(projectsState).kind === "loaded") return;
      disposed = false;
      loadProjects();
      return () => {
        disposed = true;
      };
    },
  );

  const loaded = () => {
    const current = projectsState();
    return current.kind === "loaded" ? current : undefined;
  };
  const loadError = () => {
    const current = projectsState();
    return current.kind === "error" ? current.message : "";
  };

  return (
    <section class="repository-mirrors" aria-label="Repository mirrors">
      <p>
        Copy pushed branches, tags and history to an external Git repository. Forgejo synchronizes
        after pushes and checks hourly.
      </p>
      <p>
        Git only. Accounts, Tickets, secrets, uploads and unpushed work are not included. Changes
        and deletions also reach the mirror.
      </p>
      <FreshAuthentication active={props.active} />
      <Show when={loadError()}>
        <p role="alert">{loadError()}</p>
        <button type="button" class="quiet-button" onClick={loadProjects}>
          Reload Projects
        </button>
      </Show>
      <Show
        when={loaded()}
        fallback={
          <Show when={!loadError()}>
            <p role="status">Loading Projects…</p>
          </Show>
        }
      >
        {(state) => (
          <Show
            when={state().projects.length}
            fallback={<p>Create a Project before configuring a mirror.</p>}
          >
            <label class="control-field">
              Project
              <select
                value={state().selectedID}
                onChange={(event) => {
                  const selectedID = event.currentTarget.value;
                  setProjectsState((current) =>
                    current.kind === "loaded" ? { ...current, selectedID } : current,
                  );
                }}
              >
                <For each={state().projects}>
                  {(item) => <option value={item.id}>{item.name}</option>}
                </For>
              </select>
            </label>
            <Show when={state().selectedID} keyed>
              {(id) => <ProjectMirrors projectID={id} active={props.active} />}
            </Show>
          </Show>
        )}
      </Show>
    </section>
  );
}
