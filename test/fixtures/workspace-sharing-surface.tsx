import { render } from "@solidjs/web";
import { createSignal } from "solid-js";
import { WorkspaceSharingBar } from "../../apps/factory/src/workspace/workspace-sharing";
import { releaseAvailableWorkspaces, sharingDecisionCount } from "./workspace-sharing-commands";
import "../../apps/factory/src/tokens.css";
import "../../apps/factory/src/style.css";
import "./ui-controls.css";
import "@fontsource-variable/inter";
import "@fontsource/sansita/400-italic.css";

function SharingControls() {
  const requested = new URLSearchParams(location.search).get("workspace");
  const [workspace, setWorkspace] = createSignal(requested ?? "workspace-shared");
  const [opened, setOpened] = createSignal("No Workspace opened");
  return (
    <main class="control-catalog factory-desktop" data-background="river-landscape">
      <h1>Workspace sharing controls</h1>
      <button type="button" onClick={releaseAvailableWorkspaces}>
        Load available Workspaces
      </button>
      <WorkspaceSharingBar
        projectID="owned-project"
        workspaceID={workspace()}
        userID="developer-owner"
        onOpen={async (value) => {
          setWorkspace(value.workspaceID);
          setOpened(value.workspaceID);
        }}
      />
      <p role="status" aria-label="Opened Workspace">
        {opened()}
      </p>
      <output class="sr-only" aria-label="Sharing decisions">
        {sharingDecisionCount()}
      </output>
    </main>
  );
}

const root = document.getElementById("root");
if (!root) throw Error("Owned sharing fixture root is unavailable");
render(() => <SharingControls />, root);
