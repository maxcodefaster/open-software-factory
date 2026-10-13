import { SkillLibrary } from "./library";
export function ProjectSkillSettings(props: {
  projectID: string;
  management: boolean;
  active?: boolean;
}) {
  return (
    <SkillLibrary
      scope={props.management ? "project" : "personal"}
      projectId={props.projectID}
      active={props.active}
    />
  );
}
