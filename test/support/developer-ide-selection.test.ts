import { expect, mock, test } from "bun:test";
import URI from "../../deploy/theia-ide/node_modules/@theia/core/lib/common/uri";
import { FileStat } from "../../deploy/theia-ide/node_modules/@theia/filesystem/lib/common/files";
import type { WorkspaceNode } from "../../deploy/theia-ide/node_modules/@theia/navigator/lib/browser/navigator-tree";

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
