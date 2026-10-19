import { inject, injectable } from "@theia/core/shared/inversify";
import type { MaybePromise } from "@theia/core/lib/common/types";
import { Deferred } from "@theia/core/lib/common/promise-util";
import URI from "@theia/core/lib/common/uri";
import { WorkspaceService } from "@theia/workspace/lib/browser/workspace-service";
import type { FileStat } from "@theia/filesystem/lib/common/files";
import { workspaceResource, workspaceScheme } from "./factory-workspace-files";
import { requestedWorkspace, selectedWorkspaceLocation } from "./factory-workspace-location";
import { authorizedFactoryOrigin } from "./factory-parent-context";
import { factoryRuntimeContext } from "./factory-runtime-context";
import { FactoryWorkspaceLabels } from "./factory-workspace-labels";

// Keep Theia's root/preference/watch lifecycle. Only selection and URI identity
// differ; selecting Factory source never invokes upstream's window-reload path.
@injectable()
export class FactoryWorkspaceSelection extends WorkspaceService {
  private selection = 0;
  private navigatorWorkspace: string | undefined;
  private factoryOrigin: string | undefined;
  private readonly sourceReady = new Deferred<void>();
  @inject(FactoryWorkspaceLabels)
  protected readonly workspaceLabels!: FactoryWorkspaceLabels;

  override get ready(): Promise<void> {
    return this.sourceReady.promise;
  }

  override get roots(): Promise<FileStat[]> {
    return this.sourceReady.promise.then(() => super.roots);
  }
  private readonly selected = (event: MessageEvent<unknown>): void => {
    if (
      window.parent === window ||
      event.source !== window.parent ||
      !this.factoryOrigin ||
      event.origin !== this.factoryOrigin
    )
      return;
    const value = event.data;
    if (
      typeof value !== "object" ||
      value === null ||
      !("type" in value) ||
      value.type !== "factory:select-workspace" ||
      !("workspaceID" in value) ||
      typeof value.workspaceID !== "string"
    )
      return;
    void this.select(value.workspaceID).catch(() =>
      this.messageService.error("Workspace source is unavailable. Retry opening the Workspace."),
    );
  };

  protected override getDefaultWorkspaceUri(): MaybePromise<string | undefined> {
    return window.location.pathname.startsWith("/editor/") ||
      requestedWorkspace(window.location.href)
      ? undefined
      : super.getDefaultWorkspaceUri();
  }

  protected override getWorkspacePath(resource: URI): string {
    return resource.scheme === workspaceScheme
      ? resource.toString()
      : super.getWorkspacePath(resource);
  }

  protected override setURLFragment(workspacePath: string): void {
    const resource = new URI(workspacePath);
    if (resource.scheme === workspaceScheme) {
      window.history.replaceState(
        null,
        "",
        selectedWorkspaceLocation(window.location.href, resource),
      );
    } else {
      super.setURLFragment(workspacePath);
    }
  }

  protected override async doInit(): Promise<void> {
    this.factoryOrigin = await authorizedFactoryOrigin(window.location.href, document.referrer);
    const workspaceID = requestedWorkspace(window.location.href);
    await super.doInit();
    if (workspaceID) {
      try {
        await this.select(workspaceID);
      } catch {
        this.messageService.error("Workspace source is unavailable. Retry opening the Workspace.");
      }
    }
    window.addEventListener("message", this.selected);
    // Explorer's initial root must resolve after source selection. Upstream
    // doInit resolves its own ready before this adapter selects the remote root.
    this.sourceReady.resolve();
    if (this.factoryOrigin && window.parent !== window)
      window.parent.postMessage({ type: "factory:ide-ready" }, this.factoryOrigin);
  }

  async select(workspaceID: string): Promise<void> {
    const serial = ++this.selection;
    const root = new URI(`${workspaceScheme}://${workspaceID}/`);
    workspaceResource(root);
    const [stat] = await Promise.all([
      this.fileService.resolve(root),
      this.workspaceLabels.prepare(workspaceID),
    ]);
    if (serial !== this.selection) return;
    await this.setWorkspace(stat);
    if (serial !== this.selection) return;
    factoryRuntimeContext.select(workspaceID);
    if (this.navigatorWorkspace === workspaceID) this.acknowledge(workspaceID);
  }

  navigatorReady(workspaceID: string): void {
    if (this.workspace?.resource.toString() !== `${workspaceScheme}://${workspaceID}/`) return;
    this.navigatorWorkspace = workspaceID;
    this.acknowledge(workspaceID);
  }

  private acknowledge(workspaceID: string): void {
    if (this.factoryOrigin && window.parent !== window)
      window.parent.postMessage(
        { type: "factory:workspace-selected", workspaceID },
        this.factoryOrigin,
      );
  }

  onStop(): void {
    this.selection++;
    window.removeEventListener("message", this.selected);
  }
}
