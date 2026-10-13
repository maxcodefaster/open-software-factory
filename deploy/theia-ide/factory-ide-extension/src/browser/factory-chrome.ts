import { ApplicationShell } from "@theia/core/lib/browser/shell/application-shell";
import type { FrontendApplicationContribution } from "@theia/core/lib/browser/frontend-application-contribution";
import { ThemeService } from "@theia/core/lib/browser/theming";
import type { Disposable } from "@theia/core/lib/common/disposable";
import { inject, injectable } from "@theia/core/shared/inversify";
import { MonacoThemingService } from "@theia/monaco/lib/browser/monaco-theming-service";
import { factoryTheme } from "./factory-theme";
import { bindFactoryFrameFocus } from "./factory-frame-focus";

@injectable()
export class FactoryChromeContribution implements FrontendApplicationContribution {
  #resizeObserver: ResizeObserver | undefined;
  #themeRegistration: Disposable | undefined;
  #unbindFrameFocus: (() => void) | undefined;

  constructor(
    @inject(ApplicationShell) private readonly shell: ApplicationShell,
    @inject(MonacoThemingService) private readonly monacoThemes: MonacoThemingService,
    @inject(ThemeService) private readonly themes: ThemeService,
  ) {}

  onDidInitializeLayout(): void {
    this.#unbindFrameFocus = bindFactoryFrameFocus(window);
    this.#themeRegistration = this.monacoThemes.registerParsedTheme(factoryTheme);
    this.themes.setCurrentTheme(factoryTheme.id, false);
    this.shell.rightPanelHandler.container.hide();
    // Embedded frames can resize before Theia installs its window listener, or while hidden.
    this.#resizeObserver = new ResizeObserver(() => this.shell.update());
    this.#resizeObserver.observe(this.shell.node);
  }

  onStop(): void {
    this.#unbindFrameFocus?.();
    this.#resizeObserver?.disconnect();
    this.#themeRegistration?.dispose();
  }
}
