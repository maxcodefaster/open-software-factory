import type { FrontendApplicationContribution } from "@theia/core/lib/browser/frontend-application-contribution";
import { StatusBar, StatusBarAlignment } from "@theia/core/lib/browser/status-bar/status-bar";
import { CommandRegistry } from "@theia/core/lib/common/command";
import { DisposableCollection } from "@theia/core/lib/common/disposable";
import URI from "@theia/core/lib/common/uri";
import type { Resource, ResourceResolver } from "@theia/core/lib/common/resource";
import { inject, injectable } from "@theia/core/shared/inversify";
import type * as lsp from "@theia/core/shared/vscode-languageserver-protocol";
import { EditorManager } from "@theia/editor/lib/browser/editor-manager";
import { ProblemManager } from "@theia/markers/lib/browser";
import * as monaco from "@theia/monaco-editor-core";
import { ProtocolToMonacoConverter } from "@theia/monaco/lib/browser/protocol-to-monaco-converter";
import type { MessageConnection } from "vscode-jsonrpc/browser";
import { languageConnection, languageRequest } from "./factory-language-connection";
import {
  factoryLanguageState,
  languagePreset,
  type FactoryLanguage,
} from "./factory-language-state";
import {
  FactoryRuntimeContext,
  factoryRuntimeContext,
  factoryRuntimePath,
  readyRuntime,
} from "./factory-runtime-context";
import { factoryWriteContext } from "./factory-write-context";
import { workspaceResource, workspaceScheme } from "./factory-workspace-files";

const commandID = "factory.language-tools";
const statusID = "factory-language-tools";
const markerOwner = "factory-project-language";
const converter = new ProtocolToMonacoConverter();
const completionKinds = [
  monaco.languages.CompletionItemKind.Text,
  monaco.languages.CompletionItemKind.Method,
  monaco.languages.CompletionItemKind.Function,
  monaco.languages.CompletionItemKind.Constructor,
  monaco.languages.CompletionItemKind.Field,
  monaco.languages.CompletionItemKind.Variable,
  monaco.languages.CompletionItemKind.Class,
  monaco.languages.CompletionItemKind.Interface,
  monaco.languages.CompletionItemKind.Module,
  monaco.languages.CompletionItemKind.Property,
  monaco.languages.CompletionItemKind.Unit,
  monaco.languages.CompletionItemKind.Value,
  monaco.languages.CompletionItemKind.Enum,
  monaco.languages.CompletionItemKind.Keyword,
  monaco.languages.CompletionItemKind.Snippet,
  monaco.languages.CompletionItemKind.Color,
  monaco.languages.CompletionItemKind.File,
  monaco.languages.CompletionItemKind.Reference,
  monaco.languages.CompletionItemKind.Folder,
  monaco.languages.CompletionItemKind.EnumMember,
  monaco.languages.CompletionItemKind.Constant,
  monaco.languages.CompletionItemKind.Struct,
  monaco.languages.CompletionItemKind.Event,
  monaco.languages.CompletionItemKind.Operator,
  monaco.languages.CompletionItemKind.TypeParameter,
];

function markdown(
  value: lsp.MarkupContent | lsp.MarkedString | undefined,
): monaco.IMarkdownString | undefined {
  if (!value) return undefined;
  if (typeof value === "string") return { value, isTrusted: false, supportHtml: false };
  if ("language" in value)
    return { value: `\`\`\`${value.language}\n${value.value}\n\`\`\``, isTrusted: false };
  return {
    value:
      value.kind === "plaintext"
        ? value.value.replace(/[\\`*_{}[\]()#+.!<>-]/g, "\\$&")
        : value.value,
    isTrusted: false,
    supportHtml: false,
  };
}

interface Peer {
  readonly workspaceID: string;
  readonly attemptID: string;
  readonly language: FactoryLanguage;
  readonly connection: MessageConnection;
  readonly socket: WebSocket;
  readonly buffers: Map<monaco.editor.ITextModel, monaco.IDisposable>;
  ready: boolean;
}

@injectable()
export class FactoryLanguageTools implements FrontendApplicationContribution, ResourceResolver {
  @inject(EditorManager) private readonly editors!: EditorManager;
  @inject(ProblemManager) private readonly problems!: ProblemManager;
  @inject(StatusBar) private readonly status!: StatusBar;
  @inject(CommandRegistry) private readonly commands!: CommandRegistry;
  private readonly dispose = new DisposableCollection();
  private readonly runtime = new FactoryRuntimeContext();
  private readonly enabled = new Set<string>();
  private readonly peers = new Map<FactoryLanguage, Peer>();
  private readonly failures = new Map<FactoryLanguage, string>();
  private workspaceID: string | undefined;
  private activeLanguage: FactoryLanguage | undefined;
  private busy = false;

  onStart() {
    this.dispose.push(
      this.commands.registerCommand(
        { id: commandID, label: "Start or stop project language tools" },
        {
          execute: () => this.toggle(),
        },
      ),
    );
    this.dispose.push(this.editors.onCurrentEditorChanged(() => this.select()));
    this.dispose.push(
      this.runtime.subscribe(() => {
        this.reconcile();
      }),
    );
    this.dispose.push(
      factoryRuntimeContext.subscribe((state) => {
        if (state?.workspaceID === this.workspaceID) void this.runtime.observe();
      }),
    );
    this.dispose.push(
      factoryWriteContext.subscribe(() => {
        this.reconcile();
      }),
    );
    this.dispose.push(monaco.editor.onDidCreateModel((model) => this.watch(model)));
    for (const language of [
      "typescript",
      "typescriptreact",
      "javascript",
      "javascriptreact",
      "python",
    ]) {
      const selector = { scheme: workspaceScheme, language };
      this.dispose.push(
        monaco.languages.registerCompletionItemProvider(selector, {
          triggerCharacters: [".", '"', "'", "/"],
          provideCompletionItems: async (model, position, _context, token) => {
            const peer = this.peer(model);
            if (!peer) return undefined;
            const result = await languageRequest<lsp.CompletionList | lsp.CompletionItem[] | null>(
              peer.connection,
              peer.socket,
              "textDocument/completion",
              this.at(model, position),
              token,
            );
            if (!result || this.peer(model) !== peer) return undefined;
            const word = model.getWordUntilPosition(position);
            const range = {
              startLineNumber: position.lineNumber,
              endLineNumber: position.lineNumber,
              startColumn: word.startColumn,
              endColumn: word.endColumn,
            };
            return {
              incomplete: !Array.isArray(result) && result.isIncomplete,
              suggestions: (Array.isArray(result) ? result : result.items).map((item) => ({
                label: item.label,
                kind:
                  completionKinds[(item.kind ?? 1) - 1] ?? monaco.languages.CompletionItemKind.Text,
                detail: item.detail,
                documentation: markdown(item.documentation),
                sortText: item.sortText,
                filterText: item.filterText,
                insertText: item.textEdit?.newText ?? item.insertText ?? item.label,
                insertTextRules:
                  item.insertTextFormat === 2
                    ? monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet
                    : undefined,
                range: item.textEdit
                  ? converter.asRange(
                      "range" in item.textEdit ? item.textEdit.range : item.textEdit.insert,
                    )
                  : range,
                additionalTextEdits: converter.asTextEdits(item.additionalTextEdits),
                // Server commands are deliberately not forwarded.
              })),
            };
          },
        }),
      );
      this.dispose.push(
        monaco.languages.registerHoverProvider(selector, {
          provideHover: async (model, position, token) => {
            const peer = this.peer(model);
            if (!peer) return undefined;
            const result = await languageRequest<lsp.Hover | null>(
              peer.connection,
              peer.socket,
              "textDocument/hover",
              this.at(model, position),
              token,
            );
            if (!result || this.peer(model) !== peer) return undefined;
            const content = Array.isArray(result.contents) ? result.contents : [result.contents];
            return {
              range: converter.asRange(result.range),
              contents: content.map((value) => markdown(value)!).filter(Boolean),
            };
          },
        }),
      );
      this.dispose.push(
        monaco.languages.registerDefinitionProvider(selector, {
          provideDefinition: async (model, position, token) => {
            const peer = this.peer(model);
            if (!peer) return undefined;
            const result = await languageRequest<
              lsp.Location | lsp.Location[] | lsp.LocationLink[] | null
            >(
              peer.connection,
              peer.socket,
              "textDocument/definition",
              this.at(model, position),
              token,
            );
            if (!result || this.peer(model) !== peer) return undefined;
            return (Array.isArray(result) ? result : [result]).flatMap((value) => {
              const uri = "targetUri" in value ? value.targetUri : value.uri;
              try {
                const resource = new URI(uri);
                if (resource.scheme === "factory-language") {
                  if (
                    resource.authority !== peer.workspaceID ||
                    !resource.path.toString().startsWith(`/${peer.attemptID}/`)
                  )
                    return [];
                } else if (workspaceResource(resource).workspaceID !== peer.workspaceID) return [];
                return [
                  {
                    uri: monaco.Uri.parse(uri),
                    range: converter.asRange(
                      "targetRange" in value ? value.targetSelectionRange : value.range,
                    ),
                  },
                ];
              } catch {
                return [];
              }
            });
          },
        }),
      );
    }
    this.select();
  }

  private select() {
    const editor = this.editors.currentEditor?.editor;
    if (!editor) {
      if (this.editors.all.length === 0) this.closePeers();
      this.renderStatus();
      return;
    }
    let workspaceID: string | undefined;
    try {
      workspaceID =
        editor &&
        (editor.uri.scheme === "factory-language"
          ? editor.uri.authority
          : workspaceResource(editor.uri).workspaceID);
    } catch {}
    this.activeLanguage = editor ? languagePreset(editor.document.languageId) : undefined;
    if (workspaceID !== this.workspaceID) {
      this.closePeers();
      this.workspaceID = workspaceID;
      this.failures.clear();
      if (workspaceID) this.runtime.select(workspaceID);
    }
    this.reconcile();
  }

  private async toggle() {
    const workspaceID = this.workspaceID;
    if (!workspaceID || !this.activeLanguage || this.busy) return;
    if (this.peers.get(this.activeLanguage)?.ready) {
      this.enabled.delete(workspaceID);
      this.closePeers();
      this.renderStatus();
      return;
    }
    this.enabled.add(workspaceID);
    this.failures.clear();
    this.busy = true;
    this.renderStatus();
    try {
      // This is the only path which may start compute, and the action names it.
      await this.runtime.prepare();
      if (workspaceID === this.workspaceID) {
        const stale = this.peers.get(this.activeLanguage);
        if (stale && !stale.ready) this.closePeer(stale);
        this.reconcile();
      }
    } finally {
      this.busy = false;
      this.renderStatus();
    }
  }

  private reconcile() {
    const runtime = readyRuntime(this.runtime.value);
    if (
      !runtime ||
      runtime.workspaceID !== this.workspaceID ||
      !this.workspaceID ||
      !factoryWriteContext.allows(this.workspaceID) ||
      !this.enabled.has(this.workspaceID)
    ) {
      this.closePeers();
      this.renderStatus();
      return;
    }
    for (const peer of this.peers.values())
      if (peer.attemptID !== runtime.attemptID) this.closePeer(peer);
    for (const model of monaco.editor.getModels()) {
      if (model.uri.scheme !== workspaceScheme || model.uri.authority !== runtime.workspaceID)
        continue;
      const language = languagePreset(model.getLanguageId());
      if (language && !this.peers.has(language) && !this.failures.has(language))
        this.connect(runtime.workspaceID, runtime.attemptID, language);
      this.watch(model);
    }
    this.renderStatus();
  }

  private connect(workspaceID: string, attemptID: string, language: FactoryLanguage) {
    const url = new URL(
      factoryRuntimePath({ workspaceID, attemptID }, `language/${language}`),
      window.location.href,
    );
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    const socket = new WebSocket(url);
    const connection = languageConnection(socket);
    const peer: Peer = {
      workspaceID,
      attemptID,
      language,
      socket,
      connection,
      buffers: new Map(),
      ready: false,
    };
    this.peers.set(language, peer);
    const fail = (message: string) => {
      if (this.peers.get(language) !== peer) return;
      this.failures.set(language, message);
      this.closePeer(peer);
      this.renderStatus();
    };
    const deadline = window.setTimeout(
      () =>
        fail(
          "Language tools did not connect. Check that the project's dependencies are installed, then retry.",
        ),
      20_000,
    );
    connection.onClose(() =>
      fail("Language tools disconnected. Click to reconnect using your retained buffers."),
    );
    connection.onNotification(
      "textDocument/publishDiagnostics",
      (value: lsp.PublishDiagnosticsParams) => {
        if (!peer.ready || this.peers.get(language) !== peer) return;
        const model = monaco.editor.getModel(monaco.Uri.parse(value.uri));
        if (
          !model ||
          !peer.buffers.has(model) ||
          (value.version !== undefined && model.getVersionId() !== value.version)
        )
          return;
        this.problems.setMarkers(new URI(value.uri), markerOwner, value.diagnostics);
      },
    );
    socket.addEventListener("close", () => window.clearTimeout(deadline), { once: true });
    socket.addEventListener(
      "open",
      () => {
        void (async () => {
          await connection.sendRequest<lsp.InitializeResult>("initialize", {
            processId: null,
            rootUri: `${workspaceScheme}://${workspaceID}/`,
            capabilities: {
              textDocument: {
                synchronization: { didSave: false },
                publishDiagnostics: { versionSupport: true },
                completion: { completionItem: { snippetSupport: true } },
                hover: { contentFormat: ["markdown", "plaintext"] },
                definition: { linkSupport: true },
              },
              workspace: { configuration: true },
            },
          });
          if (this.peers.get(language) !== peer) return;
          await connection.sendNotification("initialized", {});
          window.clearTimeout(deadline);
          peer.ready = true;
          factoryLanguageState.set(workspaceID, language, true);
          for (const model of monaco.editor.getModels()) this.watch(model);
          this.renderStatus();
        })().catch(() =>
          fail(
            "Language tools could not start. Install the project's TypeScript or Python environment, then retry.",
          ),
        );
      },
      { once: true },
    );
  }

  private watch(model: monaco.editor.ITextModel) {
    const language = languagePreset(model.getLanguageId());
    const peer = language && this.peers.get(language);
    if (
      !peer?.ready ||
      model.uri.scheme !== workspaceScheme ||
      model.uri.authority !== peer.workspaceID ||
      peer.buffers.has(model)
    )
      return;
    const uri = model.uri.toString();
    void peer.connection
      .sendNotification("textDocument/didOpen", {
        textDocument: {
          uri,
          languageId: model.getLanguageId(),
          version: model.getVersionId(),
          text: model.getValue(),
        },
      })
      .catch(() => {});
    const changes = model.onDidChangeContent(() => {
      this.problems.setMarkers(new URI(uri), markerOwner, []);
      void peer.connection
        .sendNotification("textDocument/didChange", {
          textDocument: { uri, version: model.getVersionId() },
          contentChanges: [{ text: model.getValue() }],
        })
        .catch(() => {});
    });
    const close = model.onWillDispose(() => {
      changes.dispose();
      peer.buffers.delete(model);
      this.problems.setMarkers(new URI(uri), markerOwner, []);
      void peer.connection
        .sendNotification("textDocument/didClose", { textDocument: { uri } })
        .catch(() => {});
    });
    peer.buffers.set(model, {
      dispose: () => {
        changes.dispose();
        close.dispose();
      },
    });
  }

  private peer(model: monaco.editor.ITextModel) {
    const language = languagePreset(model.getLanguageId());
    const peer = language && this.peers.get(language);
    return peer?.ready &&
      peer.workspaceID === model.uri.authority &&
      model.uri.scheme === workspaceScheme
      ? peer
      : undefined;
  }
  private at(model: monaco.editor.ITextModel, position: monaco.Position) {
    return {
      textDocument: { uri: model.uri.toString() },
      position: { line: position.lineNumber - 1, character: position.column - 1 },
    };
  }
  private closePeer(peer: Peer) {
    if (this.peers.get(peer.language) !== peer) return;
    this.peers.delete(peer.language);
    peer.connection.dispose();
    peer.socket.close();
    factoryLanguageState.set(peer.workspaceID, peer.language, false);
    for (const [model, disposable] of peer.buffers) {
      disposable.dispose();
      if (!model.isDisposed())
        this.problems.setMarkers(new URI(model.uri.toString()), markerOwner, []);
    }
    peer.buffers.clear();
  }
  private closePeers() {
    for (const peer of this.peers.values()) this.closePeer(peer);
  }
  resolve(uri: URI): Resource {
    if (uri.scheme !== "factory-language") throw new Error("Not a project dependency document");
    const peer = [...this.peers.values()].find(
      (peer) =>
        peer.ready &&
        peer.workspaceID === uri.authority &&
        uri.path.toString().startsWith(`/${peer.attemptID}/${peer.language}/`),
    );
    if (!peer) throw new Error("The dependency's original Runtime Attempt is not connected.");
    return {
      uri,
      readOnly: true,
      autosaveable: false,
      dispose() {},
      readContents: async () => {
        if (this.peers.get(peer.language) !== peer)
          throw new Error("The dependency's original Runtime Attempt is not connected.");
        const result = await languageRequest<{ text: string }>(
          peer.connection,
          peer.socket,
          "factory/readDocument",
          {
            uri: uri.toString(),
          },
        );
        if (this.peers.get(peer.language) !== peer || typeof result.text !== "string")
          throw new Error("Dependency document is unavailable.");
        return result.text;
      },
    };
  }
  private renderStatus() {
    const language = this.activeLanguage;
    if (!this.workspaceID || !language) {
      if (this.editors.currentEditor)
        void this.status.setElement(statusID, {
          name: "Language support",
          text: "Syntax highlighting",
          alignment: StatusBarAlignment.RIGHT,
          priority: 1,
          tooltip:
            "Project-aware completion, diagnostics and navigation are provided for TypeScript, JavaScript and Python. This language has syntax highlighting only.",
        });
      else void this.status.removeElement(statusID);
      return;
    }
    const name = language === "python" ? "Python" : "TypeScript";
    const peer = this.peers.get(language);
    const allowed = factoryWriteContext.allows(this.workspaceID);
    const failure = this.failures.get(language) ?? this.runtime.value?.failure;
    const working = this.busy || Boolean(peer && !peer.ready);
    void this.status.setElement(statusID, {
      name: "Project language tools",
      text: peer?.ready
        ? `${name} tools`
        : working
          ? `$(loading~spin) Preparing ${name} tools`
          : `${name} · ${failure ? "Retry tools" : "Start tools"}`,
      alignment: StatusBarAlignment.RIGHT,
      priority: 1,
      ...(!working && allowed ? { command: commandID } : {}),
      tooltip:
        failure ??
        (peer?.ready
          ? "Completion, diagnostics and Go to Definition use this Workspace's Dev Container and installed dependencies. Click to stop language tools without stopping compute."
          : allowed
            ? "Start project language tools. This prepares compute and runs the project's Dev Container setup if it is stopped. Your unsaved buffers stay in the editor."
            : "Language tools require editing control. Source files and syntax highlighting remain available."),
    });
  }
  onStop() {
    this.closePeers();
    this.dispose.dispose();
    void this.status.removeElement(statusID);
  }
}
