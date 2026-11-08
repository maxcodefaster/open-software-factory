import type { TreeNode } from "@theia/core/lib/browser/tree/tree";
import type { NodeProps } from "@theia/core/lib/browser/tree/tree-widget";
import { injectable } from "@theia/core/shared/inversify";
import type React = require("@theia/core/shared/react");
import { FileNode } from "@theia/filesystem/lib/browser/file-tree";
import { FileNavigatorWidget } from "@theia/navigator/lib/browser/navigator-widget";
import { isTreeTouchClick, treeTouchGesture } from "./factory-tree-touch";

@injectable()
export class FactoryWorkspaceWidget extends FileNavigatorWidget {
  private readonly touch = treeTouchGesture();

  protected override createNodeAttributes(
    node: TreeNode,
    props: NodeProps,
  ): React.Attributes & React.HTMLAttributes<HTMLElement> {
    const original = super.createNodeAttributes(node, props);
    return {
      ...original,
      onPointerDown: (event: React.PointerEvent<HTMLElement>) => {
        this.touch.down(event, node.id);
        original.onPointerDown?.(event);
      },
      onPointerCancel: (event: React.PointerEvent<HTMLElement>) => {
        this.touch.cancel();
        original.onPointerCancel?.(event);
      },
      onPointerUp: (event: React.PointerEvent<HTMLElement>) => {
        const id = this.touch.up(event);
        const current = id ? this.model.getNode(id) : undefined;
        if (current) {
          event.stopPropagation();
          if (FileNode.is(current)) {
            this.model.selectNode(current);
            this.model.openNode(current);
          } else this.tapNode(current);
        }
        original.onPointerUp?.(event);
      },
      onClick: (event: React.MouseEvent<HTMLElement>) => {
        // Touch was handled before the compatibility mouse event can lose its row.
        if (isTreeTouchClick(event.nativeEvent)) event.stopPropagation();
        else original.onClick?.(event);
      },
    };
  }
}
