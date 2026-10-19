import type {
  DidChangeLabelEvent,
  LabelProviderContribution,
} from "@theia/core/lib/browser/label-provider";
import { Emitter } from "@theia/core/lib/common/event";
import URI from "@theia/core/lib/common/uri";
import { inject, injectable } from "@theia/core/shared/inversify";
import { FileStat } from "@theia/filesystem/lib/common/files";
import { FactorySourceClient } from "./factory-source-client";
import { workspaceScheme } from "./factory-workspace-files";

@injectable()
export class FactoryWorkspaceLabels implements LabelProviderContribution {
  private readonly labels = new Map<string, string>();
  private readonly changed = new Emitter<DidChangeLabelEvent>();
  readonly onDidChange = this.changed.event;

  constructor(@inject(FactorySourceClient) private readonly source: FactorySourceClient) {}

  async prepare(workspaceID: string) {
    try {
      const { label } = await this.source.presentation(workspaceID);
      if (this.labels.get(workspaceID) === label) return;
      this.labels.set(workspaceID, label);
      this.changed.fire({
        affects: (element) => {
          const resource = this.resource(element);
          return resource?.scheme === workspaceScheme && resource.authority === workspaceID;
        },
      });
    } catch {
      // Display metadata never grants access or prevents canonical source from opening.
      // The URI retains its immutable Workspace identity even without its friendly name.
    }
  }

  canHandle(element: object) {
    return this.resource(element)?.scheme === workspaceScheme ? 20 : 0;
  }

  getName(element: object) {
    const resource = this.resource(element);
    return resource?.path.isRoot ? this.label(resource) : undefined;
  }

  getLongName(element: object) {
    const resource = this.resource(element);
    return resource ? `${this.label(resource)}${resource.path.toString()}` : undefined;
  }

  getDetails(element: object) {
    const resource = this.resource(element);
    return resource ? this.label(resource) : undefined;
  }

  private resource(element: object) {
    if (element instanceof URI) return element;
    if (FileStat.is(element)) return element.resource;
    if (
      "kind" in element &&
      element.kind === "uriIconReference" &&
      "uri" in element &&
      element.uri instanceof URI
    )
      return element.uri;
    return undefined;
  }

  private label(resource: URI) {
    return this.labels.get(resource.authority) ?? `Source · ${resource.authority.slice(0, 8)}`;
  }
}
