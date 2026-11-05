import type { FrontendApplicationContribution } from "@theia/core/lib/browser/frontend-application-contribution";
import { inject, injectable } from "@theia/core/shared/inversify";
import URI from "@theia/core/lib/common/uri";
import type { Resource, ResourceResolver } from "@theia/core/lib/common/resource";
import { EditorManager } from "@theia/editor/lib/browser/editor-manager";
import type { TextEditor } from "@theia/editor/lib/browser/editor";
import { StatusBar, StatusBarAlignment } from "@theia/core/lib/browser/status-bar/status-bar";
import { MonacoEditor } from "@theia/monaco/lib/browser/monaco-editor";
import type { FactoryWorkspaceSelection } from "./factory-workspace-selection";
import { WorkspaceService } from "@theia/workspace/lib/browser/workspace-service";
import { authorizedFactoryOrigin } from "./factory-parent-context";
import { workspaceResource, workspaceScheme } from "./factory-workspace-files";
import { AgentFollowGate } from "./factory-agent-follow";
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
  readonly #gate = new AgentFollowGate<ActivityNavigationMessage>(() => performance.now(), 4_000);
  #followTimer: ReturnType<typeof setInterval> | undefined;
  #highlight: { editor: TextEditor; ids: string[]; timer: ReturnType<typeof setTimeout> } | undefined;
  constructor(
    @inject(EditorManager) private readonly editors: EditorManager,
    @inject(WorkspaceService) private readonly workspaces: FactoryWorkspaceSelection,
    @inject(StatusBar) private readonly statusBar: StatusBar,
  ) {}
  async onDidInitializeLayout() {
    this.#origin = await authorizedFactoryOrigin(window.location.href, document.referrer);
    window.addEventListener("message", this.#receive);
    this.#gate.setFollowing(this.#storedFollowing());
    for (const type of ["keydown", "wheel", "pointerdown", "touchmove"])
      document.addEventListener(type, this.#interaction, { capture: true, passive: true });
    this.#followTimer = setInterval(() => void this.#catchUp(), 500);
    this.#followStatus();
  }
  readonly #interaction = () => this.#gate.interact();
  #storedFollowing() {
    try {
      return window.localStorage.getItem("factory.ide.followAgent") !== "off";
    } catch {
      return true;
    }
  }
  #followStatus() {
    const following = this.#gate.following;
    void this.statusBar.setElement("factory-agent-follow", {
      text: following ? "Following agent" : "Follow paused",
      tooltip: following
        ? "The editor moves to the files the agent changes. It waits while you type or scroll. Click to pause."
        : "The editor stays where you are. Click to follow the agent again.",
      alignment: StatusBarAlignment.LEFT,
      priority: 97,
      accessibilityInformation: {
        label: following
          ? "Following agent. Activate to pause."
          : "Follow paused. Activate to follow the agent.",
      },
      onclick: () => {
        this.#gate.setFollowing(!this.#gate.following);
        try {
          window.localStorage.setItem(
            "factory.ide.followAgent",
            this.#gate.following ? "on" : "off",
          );
        } catch {
          // The choice still holds for this session.
        }
        this.#followStatus();
      },
    });
  }
  async #catchUp() {
    const target = this.#gate.take();
    if (target) await this.#follow(target);
  }
  async #follow(target: ActivityNavigationMessage) {
    try {
      const resource = new URI(`${workspaceScheme}://${target.workspaceID}/`).resolve(target.path);
      workspaceResource(resource);
      const widget = await this.editors.open(resource, { mode: "reveal" });
      const line = target.line;
      if (!line) return;
      const editor = widget.editor;
      // The file watch brings the agent's new text in a moment later than the tool result.
      await new Promise((resolve) => setTimeout(resolve, 600));
      const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      if (editor instanceof MonacoEditor)
        editor.getControl().updateOptions({ smoothScrolling: !reduced });
      const range = {
        start: { line: line - 1, character: 0 },
        end: { line: line - 1, character: 0 },
      };
      editor.revealRange(range, { at: "centerIfOutsideViewport" });
      this.#clearHighlight();
      const ids = editor.deltaDecorations({
        oldDecorations: [],
        newDecorations: [{ range, options: { className: "factory-agent-line", isWholeLine: true } }],
      });
      this.#highlight = {
        editor,
        ids,
        timer: setTimeout(() => this.#clearHighlight(), 4_000),
      };
    } catch {
      // Following is a courtesy. A file that cannot open leaves the editor where it is.
    }
  }
  #clearHighlight() {
    const current = this.#highlight;
    if (!current) return;
    clearTimeout(current.timer);
    this.#highlight = undefined;
    try {
      current.editor.deltaDecorations({ oldDecorations: current.ids, newDecorations: [] });
    } catch {
      // The editor was already closed.
    }
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
    if (target.kind === "follow") {
      if (
        this.workspaces.workspace?.resource.toString() === `${workspaceScheme}://${target.workspaceID}/`
      )
        this.#gate.offer(target);
      // Factory only needs to know the target arrived. It never waits on the editor to follow.
      window.parent.postMessage(
        { type: "factory:activity-opened", id: target.id, workspaceID: target.workspaceID },
        this.#origin,
      );
      return;
    }
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
    for (const type of ["keydown", "wheel", "pointerdown", "touchmove"])
      document.removeEventListener(type, this.#interaction, { capture: true });
    clearInterval(this.#followTimer);
    this.#clearHighlight();
    void this.statusBar.removeElement("factory-agent-follow");
    this.#snapshots.clear();
  }
}
