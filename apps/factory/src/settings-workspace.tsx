import { createSignal, For, Show } from "solid-js";
import { SecuritySettings } from "./access/security-settings";
import { AccessSettings } from "./access/settings";
import { rememberSettingsReturn } from "./access/settings-return";
import { EnvironmentSettings } from "./environments/settings";
import { ModelSettings } from "./models/settings";
import { UsageSettings } from "./usage/settings";
import "./settings-workspace.css";

type Scope = "personal" | "project" | "system";
type Category = "models" | "skills" | "people" | "environment" | "security" | "usage";

export function SettingsWorkspace(props: {
  active?: boolean;
  userID: string;
  project: { id: string; name: string } | undefined;
  systemManager: boolean;
  projectManager: boolean;
  developer: boolean;
  initialSelection?: { scope: Scope; category: "people" | "security" } | undefined;
}) {
  const [selection, setSelection] = createSignal<{ scope: Scope; category: Category }>(
    props.initialSelection ?? {
      scope:
        props.project && (props.developer || props.projectManager)
          ? props.developer
            ? "personal"
            : "project"
          : props.systemManager
            ? "system"
            : "personal",
      category:
        props.systemManager || props.developer
          ? "models"
          : props.projectManager && props.project
            ? "people"
            : "security",
    },
  );
  const category = () => selection().category;
  const beforeCompanySignIn = () => {
    const current = selection();
    if (current.category !== "people" && current.category !== "security") return;
    rememberSettingsReturn({
      userID: props.userID,
      project: props.project,
      ...current,
      category: current.category,
    });
  };
  const canManage = () => props.projectManager || props.systemManager;
  const groups = () => [
    ...[
      {
        scope: "personal" as const,
        label: "Personal",
        categories: [
          ...(props.project && props.developer ? ["models"] : []),
          "skills",
          "security",
        ] as Category[],
      },
    ],
    ...(props.project
      ? [
          {
            scope: "project" as const,
            label: props.project.name,
            categories: [
              "usage",
              "skills",
              ...(props.developer ? (["models"] as Category[]) : []),
              ...(props.developer || canManage() ? (["environment"] as Category[]) : []),
              ...(canManage() ? ["people" as const] : []),
            ] as Category[],
          },
        ]
      : []),
    ...(props.systemManager
      ? [
          {
            scope: "system" as const,
            label: "Factory",
            categories: ["models", "skills", "people", "security", "usage"] as Category[],
          },
        ]
      : []),
  ];
  const label = (value: Category, scope: Scope = selection().scope) =>
    ({
      models: "Models",
      skills: "Skills",
      people: "People & access",
      environment: "Environments",
      usage: "Usage & limits",
      security: scope === "system" ? "Company sign-in" : "Login & security",
    })[value];
  return (
    <section class="settings-workspace settings-layout" aria-label="Settings">
      <nav class="settings-sidebar" aria-label="Settings navigation">
        <h2>Settings</h2>
        <For each={groups()}>
          {(group) => (
            <section>
              <h3>{group.label}</h3>
              <For each={group.categories}>
                {(value) => (
                  <button
                    type="button"
                    aria-current={
                      selection().scope === group.scope && category() === value ? "page" : undefined
                    }
                    onClick={() => setSelection({ scope: group.scope, category: value })}
                  >
                    {label(value, group.scope)}
                  </button>
                )}
              </For>
            </section>
          )}
        </For>
      </nav>
      <div class="settings-content">
        <header class="settings-content-heading">
          <small>
            {selection().scope === "system"
              ? "Factory"
              : selection().scope === "personal"
                ? "Personal choices"
                : props.project?.name}
          </small>
          <h2>{label(category())}</h2>
        </header>
        <div
          hidden={
            category() === "security" ||
            category() === "usage" ||
            category() === "environment" ||
            (category() === "people" && canManage())
          }
        >
          <ModelSettings
            active={props.active !== false && (category() === "models" || category() === "skills")}
            project={props.project}
            systemManager={props.systemManager}
            projectManager={canManage()}
            category={category() === "skills" ? "skills" : "models"}
            scope={selection().scope}
          />
        </div>
        <Show when={category() === "security"}>
          <SecuritySettings
            company={selection().scope === "system"}
            beforeCompanySignIn={beforeCompanySignIn}
          />
        </Show>
        <Show when={category() === "usage"}>
          <UsageSettings
            projectID={selection().scope === "project" ? props.project?.id : undefined}
          />
        </Show>
        <Show
          when={category() === "environment" && (props.developer || canManage()) && props.project}
        >
          {(project) => <EnvironmentSettings projectID={project().id} />}
        </Show>
        <Show when={category() === "people" && canManage()}>
          <AccessSettings
            project={selection().scope === "project" ? props.project : undefined}
            systemManager={props.systemManager}
            beforeCompanySignIn={beforeCompanySignIn}
          />
        </Show>
      </div>
    </section>
  );
}
