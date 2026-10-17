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

@injectable()
export class FactoryChromeContribution implements FrontendApplicationContribution {
  #resizeObserver: ResizeObserver | undefined;
  #themeRegistration: Disposable | undefined;
  #unbindFrameFocus: (() => void) | undefined;
  #preferenceSubscription: Disposable | undefined;
  #stopped = false;

  constructor(
    @inject(ApplicationShell) private readonly shell: ApplicationShell,
    @inject(MonacoThemingService) private readonly monacoThemes: MonacoThemingService,
    @inject(ThemeService) private readonly themes: ThemeService,
    @inject(PreferenceService) private readonly preferences: PreferenceService,
    @inject(StatusBar) private readonly statusBar: StatusBar,
  ) {}

  onDidInitializeLayout(): void {
    this.#unbindFrameFocus = bindFactoryFrameFocus(window);
    this.#themeRegistration = this.monacoThemes.registerParsedTheme(factoryTheme);
    this.themes.setCurrentTheme(factoryTheme.id, false);
    this.shell.rightPanelHandler.container.hide();
    // Embedded frames can resize before Theia installs its window listener, or while hidden.
    this.#resizeObserver = new ResizeObserver(() => this.shell.update());
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

  onStop(): void {
    this.#stopped = true;
    this.#preferenceSubscription?.dispose();
    void this.statusBar.removeElement("factory-editor-settings");
    void this.statusBar.removeElement("factory-editor-save-mode");
    this.#unbindFrameFocus?.();
    this.#resizeObserver?.disconnect();
    this.#themeRegistration?.dispose();
  }
}
