import { untrack } from "solid-js";
import { workspacePanelID } from "../workspace-tabbar";
import { DocumentWindowChrome } from "./document-window-chrome";
import type { DocumentWindowModel } from "./document-window-model";
import { DocumentWindowPanels } from "./document-window-panels";
import { DocumentWindowPersistent } from "./document-window-persistent";

export type { DocumentWindowModel } from "./document-window-model";

export function DocumentWindow(props: { model: DocumentWindowModel }) {
  // The model identity is stable; its accessors retain live state.
  const model = untrack(() => props.model);
  return (
    <section
      ref={model.workspaceElement}
      class={`workspace-window workspace-window-${model.workspaceView() ?? "minimized"}`}
      aria-label={`${model.workspaceView() ?? "minimized"} workspace`}
      data-closing={model.workspaceWindow.closing() ? "true" : "false"}
      onAnimationEnd={(event) => {
        if (event.target === event.currentTarget && event.animationName === "window-out")
          model.workspaceWindow.finishExit();
      }}
      aria-hidden={model.workspaceVisible() ? "false" : "true"}
      hidden={!model.workspaceWindow.present() || model.workspaceTabs().length === 0}
      inert={!model.workspaceVisible() || model.agentOverlay()}
    >
      <DocumentWindowChrome model={model} />
      <div
        class="workspace-view-body"
        role="tabpanel"
        id={workspacePanelID}
        aria-labelledby={model.activeWorkspaceLabelID()}
        tabindex="-1"
      >
        <DocumentWindowPanels model={model} />
        <DocumentWindowPersistent model={model} />
      </div>
    </section>
  );
}
