import { Show } from "solid-js";
import type { JSX } from "@solidjs/web";
import { SkillLibrary } from "../skills/library";
import { ProjectModelSettings } from "./project-settings";
import { SystemModelSettings } from "./system-settings";
export function ModelSettings(props: {
  active?: boolean;
  systemManager: boolean;
  projectManager: boolean;
  project: { id: string; name: string } | undefined;
  category: "models" | "skills";
  scope: "personal" | "project" | "system";
  onModelsChanged?: (() => Promise<void>) | undefined;
  navigation?: JSX.Element;
}) {
  return (
    <section class="settings-configuration" aria-label="Agent settings">
      <Show when={props.category === "models"}>
        <>
          <p class="settings-scope-description">
            {props.scope === "system"
              ? "Defaults and allowed choices for everyone in Factory."
              : props.scope === "project"
                ? `Defaults for ${props.project?.name}. Developers can use permitted personal overrides.`
                : "Your model choices for this Project. Unset values follow inherited defaults."}
          </p>
          <Show
            when={props.scope === "system" && props.systemManager}
            fallback={
              <Show when={props.project}>
                {(project) => (
                  <ProjectModelSettings
                    active={props.active ?? true}
                    projectID={project().id}
                    management={props.scope === "project"}
                  />
                )}
              </Show>
            }
          >
            <SystemModelSettings
              active={props.active ?? true}
              onModelsChanged={props.onModelsChanged}
            />
          </Show>
        </>
      </Show>
      <div class="skill-library-host" hidden={props.category !== "skills"}>
        <SkillLibrary
          navigation={props.navigation}
          projectId={props.project?.id}
          projectName={props.project?.name}
          active={props.active !== false && props.category === "skills"}
        />
      </div>
    </section>
  );
}
