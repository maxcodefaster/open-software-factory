import type { FrontendApplicationContribution } from "@theia/core/lib/browser/frontend-application-contribution";
import { inject, injectable } from "@theia/core/shared/inversify";
import URI from "@theia/core/lib/common/uri";
import type { Resource, ResourceResolver } from "@theia/core/lib/common/resource";
import { EditorManager } from "@theia/editor/lib/browser/editor-manager";
import type { FactoryWorkspaceSelection } from "./factory-workspace-selection";
import { WorkspaceService } from "@theia/workspace/lib/browser/workspace-service";
import { authorizedFactoryOrigin } from "./factory-parent-context";
import { workspaceResource, workspaceScheme } from "./factory-workspace-files";
import {
  activityNavigationMessage,
  type ActivityNavigationMessage,
} from "./factory-activity-message";

@injectable()
export class FactoryActivityNavigation
  implements FrontendApplicationContribution, ResourceResolver
{
  #origin: string | undefined;
  readonly #snapshots = new Map<string, string>();
  constructor(
    @inject(EditorManager) private readonly editors: EditorManager,
    @inject(WorkspaceService) private readonly workspaces: FactoryWorkspaceSelection,
  ) {}
  async onDidInitializeLayout() {
    this.#origin = await authorizedFactoryOrigin(window.location.href, document.referrer);
    window.addEventListener("message", this.#receive);
  }
  readonly #receive = (event: MessageEvent<unknown>) => {
    if (
      !this.#origin ||
      event.origin !== this.#origin ||
      event.source !== window.parent ||
      window.parent === window
    )
      return;
    const target = activityNavigationMessage(event.data);
    if (!target) return;
    // Selection is acknowledged by Factory before it sends a navigation target.
    // A late target never selects another Workspace or opens a file in the current one.
    if (
      this.workspaces.workspace?.resource.toString() !==
      `${workspaceScheme}://${target.workspaceID}/`
    )
      return;
    void this.open(target);
  };
  async open(target: ActivityNavigationMessage) {
    const origin = this.#origin;
    if (!origin) return;
    try {
      let resource = new URI(`${workspaceScheme}://${target.workspaceID}/`).resolve(target.path);
      workspaceResource(resource);
      if (target.kind === "diff") {
        resource = new URI(`factory-activity://${target.workspaceID}/${target.id}/`).resolve(
          `${target.path}.diff`,
        );
        this.#snapshots.set(
          resource.toString(),
          [
            "# Recorded tool diff. This is not a comparison against the current working file.",
            ...(target.truncated
              ? ["# Shortened snapshot. The complete diff is not available here."]
              : []),
            target.diff,
          ].join("\n"),
        );
        while (this.#snapshots.size > 32) {
          const oldest = this.#snapshots.keys().next().value;
          if (oldest === undefined) break;
          this.#snapshots.delete(oldest);
        }
      }
      await this.editors.open(resource, { mode: "activate" });
      window.parent.postMessage(
        { type: "factory:activity-opened", id: target.id, workspaceID: target.workspaceID },
        origin,
      );
    } catch {
      window.parent.postMessage(
        {
          type: "factory:activity-opened",
          id: target.id,
          workspaceID: target.workspaceID,
          error:
            "This file or recorded diff could not be opened. Existing files and buffers are unchanged.",
        },
        origin,
      );
    }
  }
  resolve(uri: URI): Resource {
    const text = this.#snapshots.get(uri.toString());
    if (uri.scheme !== "factory-activity" || text === undefined)
      throw new Error("Reopen the recorded diff from its chat activity.");
    return {
      uri,
      readOnly: true,
      autosaveable: false,
      readContents: async () => text,
      dispose() {},
    };
  }
  onStop() {
    window.removeEventListener("message", this.#receive);
    this.#snapshots.clear();
  }
}
