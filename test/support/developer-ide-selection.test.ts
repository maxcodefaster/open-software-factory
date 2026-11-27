import { expect, mock, test } from "bun:test";
import { readFileSync } from "node:fs";
import ts from "typescript";
import {
  workspaceResource,
  workspaceScheme,
} from "../../deploy/theia-ide/factory-ide-extension/lib/browser/factory-workspace-files";
import {
  requestedWorkspace,
  selectedWorkspaceLocation,
} from "../../deploy/theia-ide/factory-ide-extension/lib/browser/factory-workspace-location";
import { authorizedFactoryOrigin } from "../../deploy/theia-ide/factory-ide-extension/src/browser/factory-parent-context";
import {
  Disposable,
  DisposableCollection,
} from "../../deploy/theia-ide/node_modules/@theia/core/lib/common/disposable";
import { Emitter } from "../../deploy/theia-ide/node_modules/@theia/core/lib/common/event";
import { Deferred } from "../../deploy/theia-ide/node_modules/@theia/core/lib/common/promise-util";
import URI from "../../deploy/theia-ide/node_modules/@theia/core/lib/common/uri";
import Ajv from "../../deploy/theia-ide/node_modules/@theia/core/shared/ajv/index.cjs";
import { FileStat } from "../../deploy/theia-ide/node_modules/@theia/filesystem/lib/common/files";
import type { WorkspaceNode } from "../../deploy/theia-ide/node_modules/@theia/navigator/lib/browser/navigator-tree";

// Execute the installed, pinned Theia lifecycle/storage implementation without
// loading a DOM or building the IDE. Only injection and unrelated UI dependencies
// are inert; doInit, setWorkspace, roots and the storage-prefix lifecycle are real.
function sourceModule<T>(path: string, imports: Record<string, unknown>): T {
  const { outputText } = ts.transpileModule(readFileSync(new URL(path, import.meta.url), "utf8"), {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.CommonJS,
      experimentalDecorators: true,
      esModuleInterop: true,
    },
  });
  const exports = {};
  const decorator = () => () => {};
  new Function("require", "exports", outputText)((name: string) => {
    if (Object.hasOwn(imports, name)) return imports[name];
    if (name.endsWith("inversify"))
      return {
        inject: decorator,
        injectable: decorator,
        named: decorator,
        postConstruct: decorator,
      };
    // Unused UI imports may occur in decorators, but must never become callers.
    return new Proxy({}, { get: () => undefined });
  }, exports);
  return exports as T;
}

const pinnedWorkspace = sourceModule<
  typeof import("../../deploy/theia-ide/node_modules/@theia/workspace/lib/browser/workspace-service")
>("../../deploy/theia-ide/node_modules/@theia/workspace/src/browser/workspace-service.ts", {
  "@theia/core": { Disposable, DisposableCollection, Emitter },
  "@theia/core/lib/common/promise-util": { Deferred },
  "@theia/core/lib/common/uri": URI,
  "@theia/core/shared/ajv": Ajv,
  "@theia/filesystem/lib/common/files": { FileStat },
  "./workspace-schema-updater.js": { workspaceSchema: {} },
});
const pinnedStorage = sourceModule<
  typeof import("../../deploy/theia-ide/node_modules/@theia/workspace/lib/browser/workspace-storage-service")
>(
  "../../deploy/theia-ide/node_modules/@theia/workspace/src/browser/workspace-storage-service.ts",
  {},
);
const startupSelection = sourceModule<
  typeof import("../../deploy/theia-ide/factory-ide-extension/lib/browser/factory-workspace-selection")
>("../../deploy/theia-ide/factory-ide-extension/src/browser/factory-workspace-selection.ts", {
  "@theia/core/lib/common/promise-util": { Deferred },
  "@theia/core/lib/common/uri": URI,
  "@theia/workspace/lib/browser/workspace-service": pinnedWorkspace,
  "./factory-parent-context": { authorizedFactoryOrigin },
  "./factory-runtime-context": { factoryRuntimeContext: { select() {} } },
  "./factory-workspace-files": { workspaceScheme, workspaceResource },
  "./factory-workspace-location": { requestedWorkspace, selectedWorkspaceLocation },
});

function startup(href: string) {
  const previous = {
    window: Object.getOwnPropertyDescriptor(globalThis, "window"),
    document: Object.getOwnPropertyDescriptor(globalThis, "document"),
    fetch: globalThis.fetch,
  };
  const messages = new EventTarget();
  const posted: { type: string; workspaceID?: string }[] = [];
  const parent = {
    postMessage: (message: (typeof posted)[number]) => {
      posted.push(message);
    },
  };
  const location = new URL(href);
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: Object.assign(messages, {
      parent,
      location,
      history: {
        replaceState: (_state: unknown, _unused: string, url: string) => {
          location.href = url;
        },
      },
    }),
  });
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: { referrer: "" },
  });
  globalThis.fetch = mock(async () =>
    Response.json({ factoryOrigin: "https://factory.example" }),
  ) as unknown as typeof fetch;
  const reads: string[] = [];
  const watches: string[] = [];
  const errors: string[] = [];
  const unavailable = new Set<string>();
  const source = new startupSelection.FactoryWorkspaceSelection();
  Object.assign(source, {
    fileService: {
      resolve: async (resource: URI) => {
        reads.push(resource.toString());
        if (unavailable.has(resource.authority)) throw new Error("Source unavailable");
        return { ...FileStat.dir(resource), children: [] };
      },
      onDidFilesChange: () => Disposable.NULL,
      watch: (resource: URI) => {
        watches.push(resource.toString());
        return Disposable.NULL;
      },
    },
    workspaceLabels: { async prepare() {} },
    messageService: { error: (message: string) => errors.push(message) },
    server: {
      getMostRecentlyUsedWorkspace: async () => {
        throw new Error("Factory startup must not read the previous default Workspace");
      },
      setMostRecentlyUsedWorkspace: async () => {},
    },
    windowTitleService: { update() {} },
    fsPreferences: { onPreferenceChanged() {}, get: () => ({}) },
    workspaceFileService: { isWorkspaceFile: () => false },
  });
  const storage = new pinnedStorage.WorkspaceStorageService();
  const keys: string[] = [];
  const saved = new Map<string, unknown>();
  Object.assign(storage, {
    workspaceService: source,
    storageService: {
      getData: async (key: string) => {
        keys.push(key);
        return saved.get(key);
      },
      setData: async (key: string, data: unknown) => {
        saved.set(key, data);
      },
    },
  });
  (storage as unknown as { init(): void }).init();
  const initialized = (source as unknown as { doInit(): Promise<void> }).doInit();
  return {
    source,
    storage,
    saved,
    initialized,
    reads,
    watches,
    errors,
    unavailable,
    keys,
    posted,
    select(workspaceID: string, origin = "https://factory.example", sender = parent) {
      messages.dispatchEvent(
        Object.assign(new Event("message"), {
          origin,
          source: sender,
          data: { type: "factory:select-workspace", workspaceID },
        }),
      );
    },
    dispose() {
      source.onStop();
      for (const key of ["window", "document"] as const) {
        const descriptor = previous[key];
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else Reflect.deleteProperty(globalThis, key);
      }
      globalThis.fetch = previous.fetch;
    },
  };
}

test("embedded startup cannot restore a previous global layout before trusted initial selection", async () => {
  // DeveloperIDEWorkspace opens /api/developer-ide/access?embed=1&epoch=2:
  // the edge initially supplies no Workspace. CDP sees ?workspace=... only
  // later, after setURLFragment's replaceState has recorded parent selection.
  const current = "971fe4a0-e4ee-568f-b50e-c951b3ff71b5";
  const old = "factory-workspace://22222222-2222-4222-8222-222222222222/old.ts";
  const editor = startup("https://editor.example/editor/01994a7d-0000-7000-8000-000000000001/2/");
  editor.saved.set("_global_:layout", [old]);
  // ShellLayoutRestorer obtains its layout through WorkspaceStorageService.
  // Inflating a saved editor reads its URI; old files can wake old compute.
  const restoration = editor.storage.getData<string[]>("layout").then((uris) => {
    editor.reads.push(...(uris ?? []));
  });
  try {
    await Bun.sleep(0);
    expect(editor.posted).toContainEqual({ type: "factory:ide-ready" });
    expect(editor.reads).toEqual([]);
    expect(editor.keys).toEqual([]);
    editor.select(current, "https://untrusted.example");
    editor.select(current, "https://factory.example", { postMessage() {} });
    await Bun.sleep(0);
    expect(editor.reads).toEqual([]);
    expect(editor.keys).toEqual([]);
    const presentation = new Deferred<void>();
    Object.assign(editor.source, {
      workspaceLabels: { prepare: () => presentation.promise },
    });
    editor.select(current);
    await Bun.sleep(0);
    expect(editor.reads).toEqual([`factory-workspace://${current}/`]);
    expect(editor.keys).toEqual([]);
    presentation.resolve();
    await Promise.all([editor.initialized, restoration, editor.source.ready]);
    expect(editor.keys).toEqual([`factory-workspace://${current}/:layout`]);
    expect(editor.reads).toEqual([`factory-workspace://${current}/`]);
    expect(editor.watches).toEqual([`factory-workspace://${current}/`]);
    expect((await editor.source.roots).map((root) => root.resource.authority)).toEqual([current]);
  } finally {
    editor.dispose();
  }
});

test("failed initial selection stays gated until an explicit successful selection", async () => {
  const current = "971fe4a0-e4ee-568f-b50e-c951b3ff71b5";
  const editor = startup(
    `https://editor.example/editor/01994a7d-0000-7000-8000-000000000001/2/?workspace=${current}`,
  );
  editor.unavailable.add(current);
  let ready = false;
  const restoration = editor.storage.getData("layout");
  void editor.source.ready.then(() => {
    ready = true;
  });
  try {
    await editor.initialized;
    await Bun.sleep(0);
    expect(ready).toBe(false);
    expect(editor.keys).toEqual([]);
    expect(editor.errors).toHaveLength(1);
    expect(editor.posted).toContainEqual({ type: "factory:ide-ready" });
    editor.unavailable.delete(current);
    editor.select(current);
    await restoration;
    expect(ready).toBe(true);
    expect(editor.keys).toEqual([`factory-workspace://${current}/:layout`]);
    expect(editor.watches).toEqual([`factory-workspace://${current}/`]);
  } finally {
    editor.dispose();
  }
});

test("an explicit initial query selects its roots before any saved-layout read", async () => {
  const current = "971fe4a0-e4ee-568f-b50e-c951b3ff71b5";
  const editor = startup(
    `https://editor.example/editor/01994a7d-0000-7000-8000-000000000001/2/?workspace=${current}`,
  );
  const key = `factory-workspace://${current}/:layout`;
  // An intentional cross-Workspace buffer in this Workspace's own layout stays
  // restorable. Selection is an ordering boundary, not a file-access allowlist.
  const buffer = {
    uri: "factory-workspace://22222222-2222-4222-8222-222222222222/old.ts",
    unsaved: "keep my edits",
  };
  const layout = { buffers: [buffer], focused: buffer.uri, collapsed: true };
  editor.saved.set(key, layout);
  try {
    const restored = await editor.storage.getData("layout");
    await editor.initialized;
    expect(editor.keys).toEqual([key]);
    expect(editor.reads).toEqual([`factory-workspace://${current}/`]);
    expect(editor.source.workspace?.resource.authority).toBe(current);
    expect(restored).toBe(layout);
    expect(layout.buffers[0]).toBe(buffer);
    expect(editor.errors).toEqual([]);
  } finally {
    editor.dispose();
  }
});

class WorkspaceServiceFixture {
  workspace: { resource: URI } | undefined;
  fileService = { resolve: async (resource: URI) => ({ resource }) };
  async setWorkspace(workspace: { resource: URI }) {
    this.workspace = workspace;
  }
}

mock.module(
  "../../deploy/theia-ide/node_modules/@theia/workspace/lib/browser/workspace-service",
  () => ({
    WorkspaceService: WorkspaceServiceFixture,
  }),
);
mock.module(
  "../../deploy/theia-ide/node_modules/@theia/navigator/lib/browser/navigator-model",
  () => ({
    FileNavigatorModel: class {},
  }),
);
mock.module(
  "../../deploy/theia-ide/node_modules/@theia/navigator/lib/browser/navigator-tree",
  () => ({
    WorkspaceNode: { is: (root: { children?: unknown[] } | undefined) => Boolean(root?.children) },
    FileNavigatorTree: class {
      async createWorkspaceRoot(folder: unknown, parent: unknown) {
        return { fileStat: folder, parent, children: [] };
      }
    },
  }),
);

const { FactoryWorkspaceSelection } = await import(
  "../../deploy/theia-ide/factory-ide-extension/lib/browser/factory-workspace-selection"
);
const { FactoryWorkspaceNavigator } = await import(
  "../../deploy/theia-ide/factory-ide-extension/lib/browser/factory-workspace-navigator"
);
const { FactoryWorkspaceTree } = await import(
  "../../deploy/theia-ide/factory-ide-extension/lib/browser/factory-workspace-tree"
);

test("Explorer installation consumes the selected root snapshot without reading it twice", async () => {
  const resource = new URI("factory-workspace://11111111-1111-4111-8111-111111111111/");
  const folder = { ...FileStat.dir(resource), children: [FileStat.dir(resource.resolve("src"))] };
  const workspace: WorkspaceNode = {
    id: "WorkspaceNodeId",
    name: "WorkspaceNode",
    parent: undefined,
    children: [],
    selected: false,
  };
  const children = [{ id: resource.resolve("src").toString(), parent: workspace }];
  const converted: unknown[] = [];
  let reads = 0;
  const tree = new FactoryWorkspaceTree();
  Object.assign(tree, {
    toNodes: async (snapshot: unknown) => {
      converted.push(snapshot);
      return children;
    },
    filter: { filter: async (nodes: Promise<unknown>) => nodes },
    resolveChildren: async () => {
      reads++;
      return children;
    },
  });
  const root = await tree.createWorkspaceRoot(folder, workspace);
  expect(root.children).toBe(children);
  expect(root.expanded).toBe(true);
  expect(reads).toBe(0);
  expect(converted).toEqual([folder]);
  // An unresolved root still needs its authenticated read. Empty resolved
  // directories are snapshots too, not a reason to repeat the network request.
  await tree.createWorkspaceRoot(FileStat.dir(resource), workspace);
  expect(reads).toBe(1);
  await tree.createWorkspaceRoot({ ...FileStat.dir(resource), children: [] }, workspace);
  expect(reads).toBe(1);
});

test("Workspace selection acknowledges the new Explorer only after its root is installed", async () => {
  const previous = globalThis.window;
  const posted: unknown[] = [];
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      location: new URL("http://editor.localhost/editor/user/1/"),
      parent: { postMessage: (message: unknown) => posted.push(message) },
    },
  });
  const source = new FactoryWorkspaceSelection();
  Object.assign(source, {
    factoryOrigin: "http://factory.localhost",
    workspaceLabels: { async prepare() {} },
  });
  try {
    const a = "11111111-1111-4111-8111-111111111111";
    const b = "22222222-2222-4222-8222-222222222222";
    await source.select(a);
    expect(posted).toEqual([]);
    source.navigatorReady(a);
    expect(posted).toEqual([{ type: "factory:workspace-selected", workspaceID: a }]);
    await source.select(b);
    source.navigatorReady(a);
    expect(posted).toHaveLength(1);
    source.navigatorReady(b);
    expect(posted.at(-1)).toEqual({ type: "factory:workspace-selected", workspaceID: b });
    await source.select(b);
    expect(posted.at(-1)).toEqual({ type: "factory:workspace-selected", workspaceID: b });
    expect(posted).toHaveLength(3);
  } finally {
    Object.defineProperty(globalThis, "window", { configurable: true, value: previous });
  }
});

test("a delayed former Explorer cannot replace or acknowledge the current Workspace", async () => {
  const a = new URI("factory-workspace://11111111-1111-4111-8111-111111111111/");
  const b = new URI("factory-workspace://22222222-2222-4222-8222-222222222222/");
  const first = Promise.withResolvers<unknown>();
  const installed: string[] = [];
  const workspaceService = {
    workspace: { resource: a },
    navigatorReady: (workspaceID: string) => installed.push(workspaceID),
  };
  const navigator = new FactoryWorkspaceNavigator();
  Object.assign(navigator, {
    workspaceService,
    createRoot: () => first.promise,
  });
  const update = navigator as unknown as { updateRoot: () => Promise<void>; root: unknown };
  const delayed = update.updateRoot();
  workspaceService.workspace = { resource: b };
  const rootB = { children: [{ uri: b }] };
  Object.assign(navigator, { createRoot: async () => rootB });
  await update.updateRoot();
  expect(update.root).toBe(rootB);
  expect(installed).toEqual([b.authority]);
  first.resolve({ children: [{ uri: a }] });
  await delayed;
  expect(update.root).toBe(rootB);
  expect(installed).toEqual([b.authority]);
});
