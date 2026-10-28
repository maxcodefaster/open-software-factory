import { createSignal, For, Loading, lazy, Show, untrack } from "solid-js";
import { rememberSettingsReturn } from "./access/settings-return";
import { createWorkspaceNavigation, WorkspaceNavigationToggle } from "./ui/workspace-navigation";
import "./settings-workspace.css";

const SecuritySettings = lazy(async () => ({
  default: (await import("./access/security-settings")).SecuritySettings,
}));
const AccessSettings = lazy(async () => ({
  default: (await import("./access/settings")).AccessSettings,
}));
const EnvironmentSettings = lazy(async () => ({
  default: (await import("./environments/settings")).EnvironmentSettings,
}));
const ProjectSetupSettings = lazy(async () => ({
  default: (await import("./setup/settings")).ProjectSetupSettings,
}));
const MCPLibrary = lazy(async () => ({ default: (await import("./mcp/library")).MCPLibrary }));
const ModelSettings = lazy(async () => ({
  default: (await import("./models/settings")).ModelSettings,
}));
const SkillLibrary = lazy(async () => ({
  default: (await import("./skills/library")).SkillLibrary,
}));
const MonitoringSettings = lazy(async () => ({
  default: (await import("./monitoring/settings")).MonitoringSettings,
}));
const ReleaseSettings = lazy(async () => ({
  default: (await import("./releases/settings")).ReleaseSettings,
}));
const UsageSettings = lazy(async () => ({
  default: (await import("./usage/settings")).UsageSettings,
}));

type Scope = "personal" | "project" | "system";
type Category =
  | "releases"
  | "models"
  | "skills"
  | "mcp"
  | "monitoring"
  | "people"
  | "environment"
  | "setup"
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
  initialSelection?: { scope: Scope; category: "people" | "security" | "monitoring" } | undefined;
}) {
  let root: HTMLElement | undefined;
  let sidebar: HTMLElement | undefined;
  const navigation = createWorkspaceNavigation({
    root: () => root,
    panel: () => sidebar,
    breakpoint: 760,
    active: () => props.active !== false,
  });
  const initialSelection = untrack<{ scope: Scope; category: Category }>(
    () =>
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
  const [selection, select] = createSignal<{ scope: Scope; category: Category }>(initialSelection);
  const [visited, setVisited] = createSignal<ReadonlySet<Category>>(
    new Set([initialSelection.category]),
  );
  function setSelection(next: { scope: Scope; category: Category }) {
    setVisited((previous) =>
      previous.has(next.category) ? previous : new Set([...previous, next.category]),
    );
    select(next);
  }
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
              ...(props.developer || canManage() ? (["setup", "environment"] as Category[]) : []),
              "monitoring",
              "releases",
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
      releases: "Releases",
      people: "People & access",
      environment: "Environments",
      setup: "Project setup",
      usage: "Monitoring",
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
          <Show when={category() !== "environment"}>
            <header
              class="settings-content-heading"
              data-library={category() === "skills" || category() === "mcp" ? "true" : undefined}
            >
              <h2 class="settings-wide-title">{label(category())}</h2>
              {navigationTitle()}
              <small>
                {selection().scope === "system"
                  ? "Factory"
                  : selection().scope === "personal"
                    ? "Personal choices"
                    : props.project?.name}
              </small>
            </header>
          </Show>
          <Loading on={category()} fallback={<p role="status">Opening settings…</p>}>
            <Show
              when={category() === "setup" && (props.developer || canManage()) && props.project}
            >
              {(project) => (
                <ProjectSetupSettings
                  projectID={project().id}
                  userID={props.userID}
                  canManage={canManage()}
                />
              )}
            </Show>
            <Show when={visited().has("models")}>
              <div class="settings-configuration-host" hidden={category() !== "models"}>
                <ModelSettings
                  navigation={navigationTitle()}
                  active={props.active !== false && category() === "models"}
                  project={props.project}
                  systemManager={props.systemManager}
                  projectManager={canManage()}
                  scope={selection().scope}
                  onModelsChanged={props.onModelsChanged}
                />
              </div>
            </Show>
            <Show when={visited().has("skills")}>
              <div class="settings-configuration-host" hidden={category() !== "skills"}>
                <SkillLibrary
                  navigation={navigationTitle()}
                  projectId={props.project?.id}
                  projectName={props.project?.name}
                  active={props.active !== false && category() === "skills"}
                />
              </div>
            </Show>
            <Show when={visited().has("releases") && props.project}>
              {(project) => (
                <div hidden={category() !== "releases"}>
                  <ReleaseSettings
                    projectID={project().id}
                    active={props.active !== false && category() === "releases"}
                  />
                </div>
              )}
            </Show>
            <Show when={visited().has("mcp")}>
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
            </Show>
            <Show when={visited().has("monitoring")}>
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
            </Show>
            <Show when={category() === "security"}>
              <div hidden={category() !== "security"}>
                <SecuritySettings
                  company={selection().scope === "system"}
                  beforeCompanySignIn={beforeCompanySignIn}
                />
              </div>
            </Show>
            <Show when={category() === "usage"}>
              <div hidden={category() !== "usage"}>
                <UsageSettings
                  projectID={selection().scope === "project" ? props.project?.id : undefined}
                  onOpenTicket={props.onOpenTicket}
                />
              </div>
            </Show>
            <Show
              when={
                visited().has("environment") && (props.developer || canManage()) && props.project
              }
            >
              {(project) => (
                <div hidden={category() !== "environment"}>
                  <EnvironmentSettings projectID={project().id} navigation={navigationTitle()} />
                </div>
              )}
            </Show>
            <Show when={category() === "people" && canManage()}>
              <div hidden={category() !== "people"}>
                <AccessSettings
                  project={selection().scope === "project" ? props.project : undefined}
                  systemManager={props.systemManager}
                  beforeCompanySignIn={beforeCompanySignIn}
                />
              </div>
            </Show>
          </Loading>
        </div>
      </div>
    </section>
  );
}
