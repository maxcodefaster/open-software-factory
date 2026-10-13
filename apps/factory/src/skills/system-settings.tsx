import { SkillLibrary } from "./library";
export function SystemSkillSettings(props: { active?: boolean }) {
  return <SkillLibrary scope="system" active={props.active} />;
}
