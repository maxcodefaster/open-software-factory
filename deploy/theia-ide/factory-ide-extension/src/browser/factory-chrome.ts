import { ApplicationShell } from "@theia/core/lib/browser/shell/application-shell";
import type { FrontendApplicationContribution } from "@theia/core/lib/browser/frontend-application-contribution";
import { ThemeService } from "@theia/core/lib/browser/theming";
import type { Disposable } from "@theia/core/lib/common/disposable";
import { inject, injectable } from "@theia/core/shared/inversify";
import { MonacoThemingService } from "@theia/monaco/lib/browser/monaco-theming-service";
import { factoryTheme } from "./factory-theme";
import { bindFactoryFrameFocus } from "./factory-frame-focus";
import { PreferenceService } from "@theia/core/lib/common/preferences";
import { StatusBar, StatusBarAlignment } from "@theia/core/lib/browser/status-bar/status-bar";
import { EditorManager } from "@theia/editor/lib/browser/editor-manager";
import { FactoryWorkspaceFiles, workspaceScheme } from "./factory-workspace-files";
import { FactoryWorkspaceLabels } from "./factory-workspace-labels";

@injectable()
export class FactoryChromeContribution implements FrontendApplicationContribution {
  #resizeObserver: ResizeObserver | undefined;
  #themeRegistration: Disposable | undefined;
  #unbindFrameFocus: (() => void) | undefined;
  #preferenceSubscription: Disposable | undefined;
  #sourceSubscription: Disposable | undefined;
  #editorSubscription: Disposable | undefined;
  #labelSubscription: Disposable | undefined;
  #stopped = false;
  #wideExplorerWidth: number | undefined;

  constructor(
    @inject(ApplicationShell) private readonly shell: ApplicationShell,
    @inject(MonacoThemingService) private readonly monacoThemes: MonacoThemingService,
    @inject(ThemeService) private readonly themes: ThemeService,
    @inject(PreferenceService) private readonly preferences: PreferenceService,
    @inject(StatusBar) private readonly statusBar: StatusBar,
    @inject(FactoryWorkspaceFiles) private readonly files: FactoryWorkspaceFiles,
    @inject(EditorManager) private readonly editors: EditorManager,
    @inject(FactoryWorkspaceLabels) private readonly labels: FactoryWorkspaceLabels,
  ) {}

  onDidInitializeLayout(): void {
    const updateBufferWorkspace = () => this.#bufferWorkspace();
    this.#editorSubscription = this.editors.onCurrentEditorChanged(updateBufferWorkspace);
    this.#labelSubscription = this.labels.onDidChange(updateBufferWorkspace);
    this.#bufferWorkspace();
    this.#sourceSubscription = this.files.onWatchConnectionChanged((disconnected) => {
      if (!disconnected.size) {
        this.statusBar.removeElement("factory-source-connection");
        return;
      }
      const unavailable = [...disconnected.values()].some((retrying) => !retrying);
      void this.statusBar.setElement("factory-source-connection", {
        text: unavailable ? "Source unavailable" : "Source reconnecting",
        tooltip: unavailable
          ? "Source access or its watch was rejected. Keep unsaved edits and reopen the Workspace."
          : "Source updates are reconnecting. Existing files and unsaved edits are retained.",
        alignment: StatusBarAlignment.LEFT,
        priority: 90,
      });
    });
    this.#unbindFrameFocus = bindFactoryFrameFocus(window);
    this.#themeRegistration = this.monacoThemes.registerParsedTheme(factoryTheme);
    this.themes.setCurrentTheme(factoryTheme.id, false);
    this.shell.rightPanelHandler.container.hide();
    // Embedded frames can resize before Theia installs its window listener, or while hidden.
    this.#resizeObserver = new ResizeObserver(() => {
      const width = this.shell.node.clientWidth;
      const panel = this.shell.leftPanelHandler;
      if (width > 0 && width < 1000 && panel.dockPanel.isVisible) {
        const maximum = Math.max(140, Math.floor(width * 0.32));
        const current = panel.container.node.clientWidth;
        if (current > maximum) {
          this.#wideExplorerWidth ??= current;
          this.shell.resize(maximum, "left");
        }
      } else if (width >= 1000 && this.#wideExplorerWidth !== undefined) {
        this.shell.resize(this.#wideExplorerWidth, "left");
        this.#wideExplorerWidth = undefined;
      }
      this.shell.update();
    });
    this.#resizeObserver.observe(this.shell.node);
    void this.preferences.ready.then(() => {
      if (this.#stopped) return;
      void this.statusBar.setElement("factory-editor-settings", {
        text: "Editor settings",
        tooltip: "Open your editor preferences, including font, layout and save behavior.",
        alignment: StatusBarAlignment.LEFT,
        priority: 100,
        command: "workbench.action.openGlobalSettings",
      });
      this.#saveMode();
      this.#preferenceSubscription = this.preferences.onPreferenceChanged((event) => {
        if (event.preferenceName === "files.autoSave") this.#saveMode();
      });
    });
  }

  #saveMode() {
    const mode = this.preferences.get<string>("files.autoSave", "off");
    void this.statusBar.setElement("factory-editor-save-mode", {
      text: mode === "off" ? "Save: manual" : "Save: automatic",
      tooltip:
        mode === "off"
          ? "Auto-save is off. Use Ctrl+S or Command+S. Open editor settings to change save behavior."
          : `Auto-save: ${mode}. Open editor settings to change save behavior.`,
      alignment: StatusBarAlignment.LEFT,
      priority: 99,
      command: "workbench.action.openGlobalSettings",
    });
  }

  #bufferWorkspace() {
    const resource = this.editors.currentEditor?.editor.uri;
    if (!resource || resource.scheme !== workspaceScheme) {
      void this.statusBar.removeElement("factory-buffer-workspace");
      return;
    }
    const label = this.labels.getDetails(resource) ?? `Source · ${resource.authority.slice(0, 8)}`;
    void this.statusBar.setElement("factory-buffer-workspace", {
      text: `File · ${label}`,
      tooltip: `This file belongs to ${label}. Switching the Explorer does not move it to another Workspace.`,
      alignment: StatusBarAlignment.LEFT,
      priority: 98,
    });
  }

  onStop(): void {
    this.#stopped = true;
    this.#preferenceSubscription?.dispose();
    this.#sourceSubscription?.dispose();
    this.#editorSubscription?.dispose();
    this.#labelSubscription?.dispose();
    void this.statusBar.removeElement("factory-source-connection");
    void this.statusBar.removeElement("factory-editor-settings");
    void this.statusBar.removeElement("factory-editor-save-mode");
    void this.statusBar.removeElement("factory-buffer-workspace");
    this.#unbindFrameFocus?.();
    this.#resizeObserver?.disconnect();
    this.#themeRegistration?.dispose();
  }
}
