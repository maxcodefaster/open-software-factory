import type { CompositeTreeNode } from "@theia/core/lib/browser/tree/tree";
import type { FileStat } from "@theia/filesystem/lib/common/files";
import type URI from "@theia/core/lib/common/uri";
import { injectable } from "@theia/core/shared/inversify";
import {
  FileNavigatorTree,
  type WorkspaceRootNode,
  type WorkspaceNode,
} from "@theia/navigator/lib/browser/navigator-tree";
import { workspaceScheme } from "./factory-workspace-files";

@injectable()
export class FactoryWorkspaceTree extends FileNavigatorTree {
  override async createWorkspaceRoot(
    folder: FileStat,
    workspace: WorkspaceNode,
  ): Promise<WorkspaceRootNode> {
    const root = await super.createWorkspaceRoot(folder, workspace);
    if (folder.resource.scheme === workspaceScheme) {
      root.expanded = true;
      // Workspace selection already resolves this directory through FileService.
      // Install its exact snapshot once; subsequent refreshes still use the
      // normal FileTree resolution and its authenticated provider.
      root.children = folder.children
        ? await this.filter.filter(this.toNodes(folder, root))
        : await this.resolveChildren(root);
    }
    return root;
  }

  protected override toNodeId(uri: URI, parent: CompositeTreeNode): string {
    return uri.scheme === workspaceScheme ? uri.toString() : super.toNodeId(uri, parent);
  }

  override createId(root: WorkspaceRootNode, uri: URI): string {
    return uri.scheme === workspaceScheme ? uri.toString() : super.createId(root, uri);
  }
}
