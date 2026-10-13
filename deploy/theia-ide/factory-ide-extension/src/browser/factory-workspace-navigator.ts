import { injectable } from "@theia/core/shared/inversify";
import { FileNavigatorModel } from "@theia/navigator/lib/browser/navigator-model";
import { WorkspaceNode } from "@theia/navigator/lib/browser/navigator-tree";
import type { FactoryWorkspaceSelection } from "./factory-workspace-selection";
import { workspaceResource, workspaceScheme } from "./factory-workspace-files";

@injectable()
export class FactoryWorkspaceNavigator extends FileNavigatorModel {
  declare protected readonly workspaceService: FactoryWorkspaceSelection;
  private selection = 0;

  protected override async updateRoot(): Promise<void> {
    const serial = ++this.selection;
    const resource = this.workspaceService.workspace?.resource;
    const root = await this.createRoot();
    // Upstream rebuilds the Explorer asynchronously. A delayed former root must
    // not replace the newly selected Workspace or acknowledge stale file rows.
    if (
      serial !== this.selection ||
      resource?.toString() !== this.workspaceService.workspace?.resource.toString()
    )
      return;
    this.root = root;
    if (
      resource?.scheme === workspaceScheme &&
      WorkspaceNode.is(root) &&
      root.children.some((child) => child.uri.toString() === resource.toString())
    )
      this.workspaceService.navigatorReady(workspaceResource(resource).workspaceID);
  }
}
