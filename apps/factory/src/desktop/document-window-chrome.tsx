import { Show, untrack } from "solid-js";
import { InboxSourceNavigation } from "../inbox/source-navigation";
import { WorkspaceTabbar } from "../workspace-tabbar";
import type { DocumentWindowModel } from "./document-window-model";

export function DocumentWindowChrome(props: { model: DocumentWindowModel }) {
  const model = untrack(() => props.model);
  return (
    <>
      <WorkspaceTabbar
        tabs={model.workspaceTabs()}
        activeTabID={model.activeWorkspaceTab()?.id}
        shareURL={model.shareableURL()}
        onActivate={model.activateWorkspaceTab}
        onClose={model.closeWorkspaceTab}
        onMinimize={() => model.setWorkspaceVisible(false)}
      />
      <Show when={model.inboxSourceActive() && !model.agentOverlay()}>
        <InboxSourceNavigation
          next={model.nextInboxItem()}
          busy={model.inboxSourceOpening() || model.inbox.busy()}
          onBack={model.returnToInbox}
          onNext={() => {
            const item = model.nextInboxItem();
            if (item) void model.startInboxItem(item);
          }}
        />
      </Show>
    </>
  );
}
