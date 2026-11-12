import { FrontendApplicationContribution } from "@theia/core/lib/browser/frontend-application-contribution";
import { LabelProviderContribution } from "@theia/core/lib/browser/label-provider";
import { ApplicationShellOptions } from "@theia/core/lib/browser/shell/application-shell";
import { bindViewContribution } from "@theia/core/lib/browser/shell/view-contribution";
import { StatusBar, StatusBarImpl } from "@theia/core/lib/browser/status-bar/status-bar";
import { WidgetFactory } from "@theia/core/lib/browser/widget-manager";
import { ResourceResolver } from "@theia/core/lib/common/resource";
import { ContainerModule } from "@theia/core/shared/inversify";
import { FileServiceContribution } from "@theia/filesystem/lib/browser/file-service";
import { LanguageGrammarDefinitionContribution } from "@theia/monaco/lib/browser/textmate/textmate-contribution";
import { createFileNavigatorContainer } from "@theia/navigator/lib/browser/navigator-container";
import { FileNavigatorModel } from "@theia/navigator/lib/browser/navigator-model";
import { FileNavigatorTree } from "@theia/navigator/lib/browser/navigator-tree";
import { FileNavigatorWidget } from "@theia/navigator/lib/browser/navigator-widget";
import { SearchInWorkspaceClientImpl } from "@theia/search-in-workspace/lib/browser/search-in-workspace-service";
import { SearchInWorkspaceServer } from "@theia/search-in-workspace/lib/common/search-in-workspace-interface";
import { WorkspaceService } from "@theia/workspace/lib/browser/workspace-service";
import { FactoryActivityNavigation } from "./factory-activity-navigation";
import { FactoryChromeContribution } from "./factory-chrome";
import { FactoryDiagnosticsContribution } from "./factory-diagnostics";
import { FactoryLanguageGrammars } from "./factory-language-grammars";
import { FactoryLanguageTools } from "./factory-language-tools";
import {
  FactoryRuntimeContribution,
  FactoryRuntimeWidget,
  factoryRuntimeWidgetID,
} from "./factory-runtime-widget";
import { FactorySourceClient } from "./factory-source-client";
import { FactoryStatusBar } from "./factory-status-bar";
import {
  FactoryTerminalContribution,
  FactoryTerminalWidget,
  factoryTerminalWidgetID,
} from "./factory-terminal-widget";
import { FactoryWorkspaceFileContribution, FactoryWorkspaceFiles } from "./factory-workspace-files";
import { FactoryWorkspaceLabels } from "./factory-workspace-labels";
import { FactoryWorkspaceNavigator } from "./factory-workspace-navigator";
import { FactoryWorkspaceSearch } from "./factory-workspace-search";
import { FactoryWorkspaceSelection } from "./factory-workspace-selection";
import { FactoryWorkspaceTree } from "./factory-workspace-tree";
import { FactoryWorkspaceWidget } from "./factory-workspace-widget";
import { FactoryWriterContribution } from "./factory-writer";
import "./factory-ide.css";
import { FactoryGitContribution, FactoryGitWidget, factoryGitWidgetID } from "./factory-git-widget";

// After a network loss Theia closes its pending requests with this reason and reconnects by itself.
// Nobody awaits those requests, so the rejections would only surface as uncaught page errors.
window.addEventListener("unhandledrejection", (event) => {
  const reason: unknown = event.reason;
  const text =
    typeof reason === "string"
      ? reason
      : reason && typeof reason === "object" && "reason" in reason
        ? String((reason as { reason: unknown }).reason)
        : reason instanceof Error
          ? reason.message
          : "";
  if (text === "reconnecting channel") event.preventDefault();
});

export default new ContainerModule((bind, _unbind, _isBound, rebind) => {
  bind(FactoryLanguageGrammars).toSelf().inSingletonScope();
  bind(LanguageGrammarDefinitionContribution).toService(FactoryLanguageGrammars);
  rebind(ApplicationShellOptions).toConstantValue({ leftPanel: { initialSizeRatio: 0.28 } });
  bind(FactoryStatusBar).toSelf().inSingletonScope();
  rebind(StatusBarImpl).toService(FactoryStatusBar);
  rebind(StatusBar).toService(FactoryStatusBar);
  bind(FactoryWorkspaceLabels).toSelf().inSingletonScope();
  bind(LabelProviderContribution).toService(FactoryWorkspaceLabels);
  rebind(WorkspaceService).to(FactoryWorkspaceSelection).inSingletonScope();
  rebind(FileNavigatorWidget).toDynamicValue(({ container }) => {
    const navigator = createFileNavigatorContainer(container);
    navigator.rebind(FileNavigatorTree).to(FactoryWorkspaceTree).inSingletonScope();
    navigator.rebind(FileNavigatorModel).to(FactoryWorkspaceNavigator).inSingletonScope();
    navigator.rebind(FileNavigatorWidget).to(FactoryWorkspaceWidget).inSingletonScope();
    return navigator.get(FileNavigatorWidget);
  });
  bind(FactorySourceClient)
    .toDynamicValue(() => new FactorySourceClient(new URL("./", window.location.href)))
    .inSingletonScope();
  bind(FactoryWorkspaceFiles)
    .toDynamicValue(
      (context) => new FactoryWorkspaceFiles(context.container.get(FactorySourceClient)),
    )
    .inSingletonScope();
  rebind(SearchInWorkspaceServer)
    .toDynamicValue(
      (context) =>
        new FactoryWorkspaceSearch(
          context.container.get(FactorySourceClient),
          context.container.get(SearchInWorkspaceClientImpl),
        ),
    )
    .inSingletonScope();
  bind(FileServiceContribution)
    .toDynamicValue(
      (context) =>
        new FactoryWorkspaceFileContribution(context.container.get(FactoryWorkspaceFiles)),
    )
    .inSingletonScope();

  bind(FactoryChromeContribution).toSelf().inSingletonScope();
  bind(FrontendApplicationContribution).toService(FactoryChromeContribution);
  bind(FactoryActivityNavigation).toSelf().inSingletonScope();
  bind(FrontendApplicationContribution).toService(FactoryActivityNavigation);
  bind<ResourceResolver>(ResourceResolver).toDynamicValue(({ container }) => ({
    resolve(uri) {
      if (uri.scheme !== "factory-activity") throw new Error("Not a recorded activity diff");
      return container.get(FactoryActivityNavigation).resolve(uri);
    },
  }));
  bind(FactoryWriterContribution).toSelf().inSingletonScope();
  bind(FrontendApplicationContribution).toService(FactoryWriterContribution);

  bind(FactoryDiagnosticsContribution).toSelf().inSingletonScope();
  bind(FrontendApplicationContribution).toService(FactoryDiagnosticsContribution);
  bind(FactoryLanguageTools).toSelf().inSingletonScope();
  bind(FrontendApplicationContribution).toService(FactoryLanguageTools);
  // Resolving ResourceProvider builds EditorManager itself. Defer the language
  // contribution lookup until an actual dependency document is opened.
  bind<ResourceResolver>(ResourceResolver).toDynamicValue(({ container }) => ({
    resolve(uri) {
      if (uri.scheme !== "factory-language") throw new Error("Not a project dependency document");
      return container.get(FactoryLanguageTools).resolve(uri);
    },
  }));

  bind(FactoryRuntimeWidget).toSelf();
  bind(WidgetFactory)
    .toDynamicValue((context) => ({
      id: factoryRuntimeWidgetID,
      createWidget: () => context.container.get(FactoryRuntimeWidget),
    }))
    .inSingletonScope();
  bindViewContribution(bind, FactoryRuntimeContribution);
  bind(FrontendApplicationContribution).toService(FactoryRuntimeContribution);

  bind(FactoryTerminalWidget).toSelf();
  bind(WidgetFactory)
    .toDynamicValue((context) => ({
      id: factoryTerminalWidgetID,
      createWidget: () => context.container.get(FactoryTerminalWidget),
    }))
    .inSingletonScope();
  bindViewContribution(bind, FactoryTerminalContribution);
  bind(FrontendApplicationContribution).toService(FactoryTerminalContribution);
  bind(FactoryGitWidget).toSelf();
  bind(WidgetFactory)
    .toDynamicValue((context) => ({
      id: factoryGitWidgetID,
      createWidget: () => context.container.get(FactoryGitWidget),
    }))
    .inSingletonScope();
  bindViewContribution(bind, FactoryGitContribution);
  bind(FrontendApplicationContribution).toService(FactoryGitContribution);
});
