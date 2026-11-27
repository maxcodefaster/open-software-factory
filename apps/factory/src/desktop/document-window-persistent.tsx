import { createEffect, createSignal, For, lazy, Show, untrack } from "solid-js";
import { plainErrorMessage } from "../command-error";
import { WorkspaceSharingBar } from "../workspace/workspace-sharing";
import {
  loadDeveloperIDEWorkspace,
  loadRuntimeWorkspace,
  prefetchDeveloperWorkspaceChunks,
} from "../workspace-chunks";
import { browserWarmupEnvironment, scheduleWarmup } from "../workspace-warmup";
import {
  activeIDETab,
  type DocumentWindowModel,
  isSettingsTabActive,
} from "./document-window-model";

const RuntimeWorkspaceTabs = lazy(async () => ({
  default: (await loadRuntimeWorkspace()).RuntimeWorkspaceTabs,
}));
const DeveloperIDEWorkspace = lazy(async () => ({
  default: (await loadDeveloperIDEWorkspace()).DeveloperIDEWorkspace,
}));
const SettingsWorkspace = lazy(async () => ({
  default: (await import("../settings-workspace")).SettingsWorkspace,
}));

export function DocumentWindowPersistent(props: { model: DocumentWindowModel }) {
  const model = untrack(() => props.model);
  // The editor's multi-megabyte bundle loads after a developer's first idle turn,
  // and never on a narrow or touch viewport until the IDE is opened.
  const [idleWarm, setIdleWarm] = createSignal(false);
  createEffect(
    () => ({ developer: model.canDevelopProject(), warm: idleWarm() }),
    ({ developer, warm }) => {
      if (!developer || warm) return;
      return scheduleWarmup({
        prefetch: prefetchDeveloperWorkspaceChunks,
        warm: () => setIdleWarm(true),
        environment: browserWarmupEnvironment(),
      });
    },
  );
  const [ideMounted, setIDEMounted] = createSignal(false);
  createEffect(
    () =>
      model.workspaceView() === "ide" ||
      model.workspaceTabs().some((tab) => tab.view === "ide") ||
      (idleWarm() && model.canDevelopProject()),
    (wanted) => {
      if (wanted) setIDEMounted(true);
    },
  );

  return (
    <>
      <For
        each={model.workspaceTabs().filter((tab) => tab.view === "settings")}
        keyed={(tab) => tab.id}
      >
        {(tab) => (
          <div class="settings-tab-panel" hidden={!isSettingsTabActive(model, tab().id)}>
            <SettingsWorkspace
              active={isSettingsTabActive(model, tab().id)}
              userID={model.bootstrap.session.user.id}
              initialSelection={tab().settingsSelection}
              project={tab().settingsProject}
              systemManager={model.bootstrap.session.systemManager}
              projectManager={model.canManageSettingsProject(tab().settingsProject?.id)}
              onModelsChanged={model.refreshModelAvailability}
              onOpenTicket={(ticketID, projectID) => {
                if (model.selectedProjectID() !== projectID) model.selectProject(projectID);
                model.selectTicket(ticketID);
              }}
              developer={
                model.bootstrap.session.systemManager ||
                model.memberships
                  .data()
                  ?.some(
                    (member) =>
                      member.projectId === tab().settingsProject?.id && member.role === "developer",
                  ) === true
              }
            />
          </div>
        )}
      </For>
      <RuntimeWorkspaceTabs
        projectID={model.selectedProjectID() ?? ""}
        tabs={model.workspaceTabs()}
        activeTabID={model.workspaceVisible() ? model.activeWorkspaceTab()?.id : undefined}
        attempts={model.attempts()}
        previews={model.appPreviews()}
        pending={model.pending()}
        userID={model.bootstrap.session.user.id}
        canDevelop={model.canDevelopProject()}
        onRetryMainPreview={model.retryMainPreview}
        onOpenTicket={(changeID) => {
          const change = model
            .changes()
            .find(
              (candidate) =>
                candidate.id === changeID && candidate.projectId === model.selectedProjectID(),
            );
          if (change) model.selectTicket(change.ticketId);
        }}
      />
      <Show when={ideMounted()}>
        <Show
          when={
            model.workspaceView() === "ide" && model.workspaceVisible() && model.canDevelopProject()
          }
        >
          <WorkspaceSharingBar
            projectID={model.selectedProjectID()}
            workspaceID={model.activeWorkspaceTab()?.workspaceID}
            userID={model.bootstrap.session.user.id}
            onOpen={(workspace) =>
              model.openIDETarget({
                id: `shared:${workspace.workspaceID}`,
                label:
                  workspace.kind === "ticket" ? workspace.name : `${workspace.name}'s workspace`,
                detail: "Shared source",
                workspaceId: workspace.workspaceID,
              })
            }
          />
        </Show>
        <DeveloperIDEWorkspace
          userID={model.bootstrap.session.user.id}
          projectID={model.selectedProjectID()}
          allowed={model.canDevelopProject()}
          preparingSelection={model.projectMenuOpen()}
          preparationFailure={activeIDETab(model)?.preparationFailure}
          onRetrySelection={() => {
            const tab = model.activeWorkspaceTab();
            const target = model.ideTargets().find((item) => `ide:${item.id}` === tab?.id);
            if (target) void model.openIDETarget(target);
          }}
          onStartSelection={
            model.activeWorkspaceTab()?.id === `ide:personal:${model.selectedProjectID()}`
              ? model.startPersonalIDE
              : undefined
          }
          workspaceID={activeIDETab(model)?.workspaceID}
          active={model.workspaceView() === "ide"}
          navigation={model.ideNavigation()}
          onNavigationOutcome={(id, error) => {
            if (model.ideNavigation()?.id !== id) return;
            model.setIDENavigation(undefined);
            if (error) model.setError(error);
          }}
          onDevelopmentPreview={(message) => {
            const projectID = model.selectedProjectID();
            void model
              .refreshServerState()
              .then(() => {
                if (model.selectedProjectID() !== projectID) return;
                if (
                  model
                    .attempts()
                    .some(
                      (attempt) =>
                        attempt.id === message.attemptID &&
                        attempt.workspaceId === message.workspaceID,
                    )
                )
                  model.openDevelopmentPreview(message.attemptID, message.process, message.label);
              })
              .catch((cause: unknown) =>
                model.setError(
                  cause instanceof Error
                    ? plainErrorMessage(cause.message)
                    : "Preview is unavailable.",
                ),
              );
          }}
        />
      </Show>
    </>
  );
}
