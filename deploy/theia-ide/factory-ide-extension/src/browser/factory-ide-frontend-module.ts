import { FrontendApplicationContribution } from "@theia/core/lib/browser/frontend-application-contribution";
import { bindViewContribution } from "@theia/core/lib/browser/shell/view-contribution";
import { WidgetFactory } from "@theia/core/lib/browser/widget-manager";
import { ContainerModule } from "@theia/core/shared/inversify";
import { FileServiceContribution } from "@theia/filesystem/lib/browser/file-service";
import { SearchInWorkspaceServer } from "@theia/search-in-workspace/lib/common/search-in-workspace-interface";
import { SearchInWorkspaceClientImpl } from "@theia/search-in-workspace/lib/browser/search-in-workspace-service";
import { WorkspaceService } from "@theia/workspace/lib/browser/workspace-service";
import { createFileNavigatorContainer } from "@theia/navigator/lib/browser/navigator-container";
import { FileNavigatorWidget } from "@theia/navigator/lib/browser/navigator-widget";
import { FileNavigatorTree } from "@theia/navigator/lib/browser/navigator-tree";
import { FileNavigatorModel } from "@theia/navigator/lib/browser/navigator-model";
import { FactoryWorkspaceNavigator } from "./factory-workspace-navigator";
import { FactoryWorkspaceTree } from "./factory-workspace-tree";
import { FactoryWorkspaceSelection } from "./factory-workspace-selection";
import { FactorySourceClient } from "./factory-source-client";
import { FactoryWorkspaceFileContribution, FactoryWorkspaceFiles } from "./factory-workspace-files";
import { FactoryWorkspaceSearch } from "./factory-workspace-search";
import { FactoryDiagnosticsContribution } from "./factory-diagnostics";
import { FactoryChromeContribution } from "./factory-chrome";
import { FactoryWriterContribution } from "./factory-writer";
import {
  FactoryRuntimeContribution,
  FactoryRuntimeWidget,
  factoryRuntimeWidgetID,
} from "./factory-runtime-widget";
import {
  FactoryTerminalContribution,
  FactoryTerminalWidget,
  factoryTerminalWidgetID,
} from "./factory-terminal-widget";
import "./factory-ide.css";

export default new ContainerModule((bind, _unbind, _isBound, rebind) => {
  rebind(WorkspaceService).to(FactoryWorkspaceSelection).inSingletonScope();
  rebind(FileNavigatorWidget).toDynamicValue(({ container }) => {
    const navigator = createFileNavigatorContainer(container);
    navigator.rebind(FileNavigatorTree).to(FactoryWorkspaceTree).inSingletonScope();
    navigator.rebind(FileNavigatorModel).to(FactoryWorkspaceNavigator).inSingletonScope();
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
  bind(FactoryWriterContribution).toSelf().inSingletonScope();
  bind(FrontendApplicationContribution).toService(FactoryWriterContribution);

  bind(FactoryDiagnosticsContribution).toSelf().inSingletonScope();
  bind(FrontendApplicationContribution).toService(FactoryDiagnosticsContribution);

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
});
