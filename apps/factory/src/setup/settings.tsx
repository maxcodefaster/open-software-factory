import { Show } from "solid-js";
import { SetupInspection } from "./inspection-panel";
import { SetupReadiness } from "./readiness-panel";
import "./setup.css";

export function ProjectSetupSettings(props: {
  projectID: string;
  userID: string;
  canManage: boolean;
}) {
  return (
    <section class="setup-settings" aria-label="Project setup settings">
      <Show when={props.canManage}>
        <SetupInspection
          projectID={props.projectID}
          storageKey={`project-setup:${props.userID}:draft:answers:${props.projectID}`}
        />
      </Show>
      <SetupReadiness projectID={props.projectID} canRetry={props.canManage} />
    </section>
  );
}
