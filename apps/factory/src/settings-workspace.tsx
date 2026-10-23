import { createSignal, For, Show } from "solid-js";
import { SecuritySettings } from "./access/security-settings";
import { AccessSettings } from "./access/settings";
import { rememberSettingsReturn } from "./access/settings-return";
import { EnvironmentSettings } from "./environments/settings";
import { ModelSettings } from "./models/settings";
import { MCPLibrary } from "./mcp/library";
import { MonitoringSettings } from "./monitoring/settings";
import { RecordingSettings } from "./review/settings";
import { UsageSettings } from "./usage/settings";
import { createWorkspaceNavigation, WorkspaceNavigationToggle } from "./ui/workspace-navigation";
import "./settings-workspace.css";

type Scope = "personal" | "project" | "system";
type Category =
  | "models"
  | "skills"
  | "mcp"
  | "monitoring"
  | "people"
  | "environment"
  | "security"
  | "usage";

export function SettingsWorkspace(props: {
  active?: boolean;
  userID: string;
  project: { id: string; name: string } | undefined;
  systemManager: boolean;
  projectManager: boolean;
  developer: boolean;
  onModelsChanged?: (() => Promise<void>) | undefined;
  onOpenTicket?: ((id: string, projectId: string) => void) | undefined;
  initialSelection?: { scope: Scope; category: "people" | "security" } | undefined;
}) {
  let root: HTMLElement | undefined;
  let sidebar: HTMLElement | undefined;
  const navigation = createWorkspaceNavigation({
    root: () => root,
    panel: () => sidebar,
    breakpoint: 760,
    active: () => props.active !== false,
  });
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
  const [monitoringSetup, setMonitoringSetup] = createSignal<{
    id: string;
    projectId: string;
    projectName: string;
  }>();
  const [monitoringSource, setMonitoringSource] = createSignal<{
    id: string;
    projectId: string;
    connectionId: string;
  }>();
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
  const navigationSelection = () =>
    category() === "mcp" && monitoringSetup()
      ? { scope: "project" as const, category: "monitoring" as const }
      : selection();
  const groups = () => [
    ...(props.project
      ? [
          {
            scope: "project" as const,
            label: `Project · ${props.project.name}`,
            categories: [
              ...(props.developer ? (["models"] as Category[]) : []),
              ...(props.developer || canManage() ? (["environment"] as Category[]) : []),
              "monitoring",
              "usage",
              ...(canManage() ? ["people" as const] : []),
            ] as Category[],
          },
        ]
      : []),
    { scope: "personal" as const, label: "Libraries", categories: ["skills", "mcp"] as Category[] },
    {
      scope: "personal" as const,
      label: "Personal",
      categories: [
        ...(props.project && props.developer ? ["models"] : []),
        "security",
      ] as Category[],
    },
    ...(props.systemManager
      ? [
          {
            scope: "system" as const,
            label: "Factory administration",
            categories: ["models", "usage", "people", "security"] as Category[],
          },
        ]
      : []),
  ];
  const label = (value: Category, scope: Scope = selection().scope) =>
    ({
      models: scope === "personal" ? "Model overrides" : "Models",
      skills: "Skills",
      mcp: "MCP connections",
      monitoring: "Inputs",
      people: "People & access",
      environment: "Environments",
      usage: "Usage & limits",
      security: scope === "system" ? "Company sign-in" : "Login & security",
    })[value];
  const navigationTitle = () => (
    <h2
      class="settings-navigation-title"
      aria-label={label(navigationSelection().category, navigationSelection().scope)}
    >
      <WorkspaceNavigationToggle
        navigation={navigation}
        label="Choose settings page"
        title={label(navigationSelection().category, navigationSelection().scope)}
      />
    </h2>
  );
  return (
    <section
      ref={root}
      class="settings-workspace workspace-navigation-container"
      aria-label="Settings"
    >
      <div class="settings-layout">
        <nav
          ref={sidebar}
          class="settings-sidebar"
          id={navigation.id}
          data-navigation-open={navigation.open() ? "true" : "false"}
          aria-label="Settings navigation"
        >
          <h2>Settings</h2>
          <div class="settings-navigation-groups">
            <For each={groups()}>
              {(group) => (
                <section class={group.scope === "system" ? "settings-admin-group" : undefined}>
                  <h3>{group.label}</h3>
                  <For each={group.categories}>
                    {(value) => (
                      <button
                        type="button"
                        aria-current={
                          navigationSelection().scope === group.scope &&
                          navigationSelection().category === value
                            ? "page"
                            : undefined
                        }
                        onClick={() => {
                          if (value === "mcp") setMonitoringSetup(undefined);
                          setSelection({ scope: group.scope, category: value });
                          navigation.close(true);
                        }}
                      >
                        {label(value, group.scope)}
                      </button>
                    )}
                  </For>
                </section>
              )}
            </For>
          </div>
        </nav>
        <div
          class="settings-content"
          data-skills={category() === "skills" || category() === "mcp" ? "true" : "false"}
        >
          <header
            class="settings-content-heading"
            data-library={category() === "skills" || category() === "mcp" ? "true" : undefined}
          >
            <small>
              {selection().scope === "system"
                ? "Factory"
                : selection().scope === "personal"
                  ? "Personal choices"
                  : props.project?.name}
            </small>
            <h2 class="settings-wide-title">{label(category())}</h2>
            {navigationTitle()}
          </header>
          <div
            class="settings-configuration-host"
            hidden={
              category() === "security" ||
              category() === "usage" ||
              category() === "environment" ||
              category() === "mcp" ||
              category() === "monitoring" ||
              (category() === "people" && canManage())
            }
          >
            <ModelSettings
              navigation={navigationTitle()}
              active={
                props.active !== false && (category() === "models" || category() === "skills")
              }
              project={props.project}
              systemManager={props.systemManager}
              projectManager={canManage()}
              category={category() === "skills" ? "skills" : "models"}
              scope={selection().scope}
              onModelsChanged={props.onModelsChanged}
            />
          </div>
          <div class="settings-configuration-host" hidden={category() !== "mcp"}>
            <MCPLibrary
              navigation={navigationTitle()}
              active={props.active !== false && category() === "mcp"}
              projectId={props.project?.id}
              projectName={props.project?.name}
              monitoringSetup={monitoringSetup()}
              onMonitoringReturn={(connectionId) => {
                const setup = monitoringSetup();
                if (setup && setup.projectId === props.project?.id && connectionId)
                  setMonitoringSource({
                    id: crypto.randomUUID(),
                    projectId: setup.projectId,
                    connectionId,
                  });
                setMonitoringSetup(undefined);
                setSelection({ scope: "project", category: "monitoring" });
              }}
            />
          </div>
          <div class="settings-configuration-host" hidden={category() !== "monitoring"}>
            <MonitoringSettings
              navigation={navigationTitle()}
              active={props.active !== false && category() === "monitoring"}
              project={props.project}
              sourceRequest={monitoringSource()}
              onOpenMCP={() => {
                if (!props.project) return;
                setMonitoringSetup({
                  id: crypto.randomUUID(),
                  projectId: props.project.id,
                  projectName: props.project.name,
                });
                setSelection({ scope: "project", category: "mcp" });
              }}
              onOpenTicket={props.onOpenTicket}
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
            {(project) => (
              <>
                <EnvironmentSettings projectID={project().id} />
                <RecordingSettings projectID={project().id} canManage={canManage()} />
              </>
            )}
          </Show>
          <Show when={category() === "people" && canManage()}>
            <AccessSettings
              project={selection().scope === "project" ? props.project : undefined}
              systemManager={props.systemManager}
              beforeCompanySignIn={beforeCompanySignIn}
            />
          </Show>
        </div>
      </div>
    </section>
  );
}
