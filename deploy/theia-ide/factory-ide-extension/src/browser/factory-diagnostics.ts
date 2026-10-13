import { FrontendApplicationContribution } from "@theia/core/lib/browser/frontend-application-contribution";
import { DiagnosticSeverity } from "@theia/core/shared/vscode-languageserver-protocol";
import type { EditorWidget } from "@theia/editor/lib/browser/editor-widget";
import { EditorManager } from "@theia/editor/lib/browser/editor-manager";
import { ProblemManager } from "@theia/markers/lib/browser";
import { inject, injectable } from "@theia/core/shared/inversify";
import ts from "typescript";

const diagnosticsOwner = "factory-typescript";
const supportedSource = /\.(?:[cm]?[jt]sx?)$/i;

function diagnosticSeverity(category: ts.DiagnosticCategory) {
  if (category === ts.DiagnosticCategory.Error) return DiagnosticSeverity.Error;
  if (category === ts.DiagnosticCategory.Warning) return DiagnosticSeverity.Warning;
  return DiagnosticSeverity.Information;
}

export function sourceDiagnostics(fileName: string, source: string) {
  const result = ts.transpileModule(source, {
    compilerOptions: {
      allowJs: true,
      checkJs: true,
      jsx: ts.JsxEmit.ReactJSX,
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2022,
    },
    fileName,
    reportDiagnostics: true,
  });

  return (result.diagnostics ?? []).map((diagnostic) => {
    const file = diagnostic.file;
    const startOffset = diagnostic.start ?? 0;
    const endOffset = startOffset + (diagnostic.length ?? 1);
    const start = file?.getLineAndCharacterOfPosition(startOffset) ?? {
      line: 0,
      character: 0,
    };
    const end = file?.getLineAndCharacterOfPosition(endOffset) ?? start;
    return {
      code: diagnostic.code,
      message: ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"),
      range: { start, end },
      severity: diagnosticSeverity(diagnostic.category),
      source: "TypeScript syntax",
    };
  });
}

@injectable()
export class FactoryDiagnosticsContribution implements FrontendApplicationContribution {
  constructor(
    @inject(EditorManager)
    private readonly editors: EditorManager,
    @inject(ProblemManager)
    private readonly problems: ProblemManager,
  ) {}

  onStart(): void {
    for (const editor of this.editors.all) this.watch(editor);
    this.editors.onCreated((editor) => this.watch(editor));
  }

  private watch(widget: EditorWidget) {
    let timer: number | undefined;
    const update = () => {
      const uri = widget.editor.uri;
      const fileName = uri.path.toString();
      const diagnostics = supportedSource.test(fileName)
        ? sourceDiagnostics(fileName, widget.editor.document.getText())
        : [];
      this.problems.setMarkers(uri, diagnosticsOwner, diagnostics);
    };
    const schedule = () => {
      if (timer !== undefined) window.clearTimeout(timer);
      timer = window.setTimeout(update, 200);
    };
    const contentChanged = widget.editor.onDocumentContentChanged(schedule);
    const languageChanged = widget.editor.onLanguageChanged(schedule);
    widget.onDidDispose(() => {
      if (timer !== undefined) window.clearTimeout(timer);
      contentChanged.dispose();
      languageChanged.dispose();
      this.problems.setMarkers(widget.editor.uri, diagnosticsOwner, []);
    });
    schedule();
  }
}
