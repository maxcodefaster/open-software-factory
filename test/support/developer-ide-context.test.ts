import { expect, test } from "bun:test";
import { confirmAccessStopped } from "../../apps/factory/src/access-stop";
import * as commandError from "../../apps/factory/src/command-error";
import { selectedSourcePreparation } from "../../apps/factory/src/selected-source-preparation";
import { serverCall } from "../../apps/factory/src/server-functions/result";
import { developerIDEOrigin } from "../../apps/factory/src/workspace/client";
import type { WorkspaceSourceView } from "../../apps/factory/src/workspace/contracts";
import type { DeveloperIDEView } from "../../apps/factory/src/workspace/developer-ide-controller";
import * as developerIDEState from "../../apps/factory/src/workspace/developer-ide-state";
import { authorizedFactoryOrigin } from "../../deploy/theia-ide/factory-ide-extension/src/browser/factory-parent-context";
import { editorCallbacks, editorSolid as solid } from "../fixtures/editor-callbacks";

test("independent IDE selection trusts authenticated context even when grant redemption suppresses referrer", async () => {
  const href =
    "http://user.1.h3000.editor.runtime.localhost:3000/editor/11111111-1111-4111-8111-111111111111/1/?workspace=source";
  const fetcher: Parameters<typeof authorizedFactoryOrigin>[2] = async (input, init) => {
    expect(String(input)).toBe(
      "http://user.1.h3000.editor.runtime.localhost:3000/editor/11111111-1111-4111-8111-111111111111/1/__factory/context",
    );
    expect(init?.credentials).toBe("same-origin");
    return Response.json({ factoryOrigin: "http://127.0.0.1:3000" });
  };
  expect(await authorizedFactoryOrigin(href, "", fetcher)).toBe("http://127.0.0.1:3000");
  expect(await authorizedFactoryOrigin(href, "https://untrusted.invalid", fetcher)).toBe(
    "http://127.0.0.1:3000",
  );
  for (const response of [
    new Response(null, { status: 401 }),
    Response.json({ factoryOrigin: "file:///source" }),
    Response.json({ factoryOrigin: "https://factory.invalid/path" }),
    Response.json({}),
  ])
    await expect(
      authorizedFactoryOrigin(href, "https://untrusted.invalid", async () => response),
    ).rejects.toThrow();
});

function mountedEditor(commands: {
  ensure(): Promise<DeveloperIDEView>;
  get(): Promise<DeveloperIDEView>;
  source?: () => Promise<WorkspaceSourceView>;
  checkSource?: () => Promise<WorkspaceSourceView>;
}) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: Object.assign(new EventTarget(), {
      location: new URL("https://factory.invalid"),
      confirm: () => true,
    }),
  });
  const timers = new Map<number, { callback: () => void; milliseconds: number | undefined }>();
  let nextTimer = 0;
  const component = editorCallbacks<{
    editorState: () => string | undefined;
    editorError: () => string;
    setEditorRetry: (update: (value: number) => number) => void;
    sourceState: () => string | undefined;
    availableSource: () => string | undefined;
    fileError: () => string;
    attachment: () => { epoch: number; url: string } | undefined;
    retrySource: () => Promise<void>;
  }>({
    path: new URL("../../apps/factory/src/workspace/developer-ide-workspace.tsx", import.meta.url)
      .pathname,
    component: "DeveloperIDEWorkspace",
    expose: [
      "editorState",
      "editorError",
      "setEditorRetry",
      "sourceState",
      "availableSource",
      "fileError",
      "attachment",
      "retrySource",
    ],
    imports: {
      "solid-js": solid,
      "../access-stop": { confirmAccessStopped },
      "../command-error": commandError,
      "./developer-ide-origin": { developerIDEOrigin },
      "./developer-ide-state": developerIDEState,
      "../selected-source-preparation": { selectedSourcePreparation },
      "../server-functions/result": { serverCall },
      "../server-functions/workspaces": {
        ensureDeveloperIDE: async () => ({ ok: true, value: await commands.ensure() }),
        getDeveloperIDE: async () => ({ ok: true, value: await commands.get() }),
        ensurePersonalSource: async () => ({ ok: true, value: undefined }),
        getWorkspaceSource: async () => ({ ok: true, value: await commands.source?.() }),
        ensureWorkspaceSource: async () => ({ ok: true, value: await commands.checkSource?.() }),
      },
      "../wait-elapsed": { createWaitElapsed: () => () => 0 },
    },
    stubs: ["../ide-messages"],
    timers: {
      setTimeout: (callback, milliseconds) => {
        timers.set(++nextTimer, { callback, milliseconds });
        return nextTimer;
      },
      clearTimeout: (id) => {
        if (id !== undefined) timers.delete(id);
      },
    },
  });
  const [projectID, setProjectID] = solid.createSignal("project-a");
  const [allowed, setAllowed] = solid.createSignal(true);
  const owned = solid.createRoot((dispose) => ({
    dispose,
    callbacks: component({
      userID: "11111111-1111-4111-8111-111111111111",
      get projectID() {
        return projectID();
      },
      get allowed() {
        return allowed();
      },
      active: true,
      workspaceID: commands.source ? "22222222-2222-4222-8222-222222222222" : undefined,
    }),
  }));
  solid.flush();
  return {
    ...owned.callbacks,
    setProjectID,
    setAllowed,
    async settle() {
      await Bun.sleep(0);
      solid.flush();
    },
    reconnect() {
      const entry = [...timers.entries()].find(([, timer]) => timer.milliseconds === 2_000);
      if (!entry) throw new Error("The editor never waited for its connection");
      timers.delete(entry[0]);
      entry[1].callback();
    },
    dispose() {
      owned.dispose();
      if (previous) Object.defineProperty(globalThis, "window", previous);
      else Reflect.deleteProperty(globalThis, "window");
    },
  };
}

test("a mounted editor observes a lost ensure acknowledgement instead of replaying admission after Stop", async () => {
  const calls: string[] = [];
  const view: DeveloperIDEView = {
    serviceID: "retained-editor",
    epoch: 15,
    state: "stopped",
    failure: null,
  };
  const editor = mountedEditor({
    async ensure() {
      calls.push("ensure");
      if (calls.length === 1) throw new Error(commandError.unreachableMessage);
      return { ...view, epoch: 16, state: "ready" };
    },
    async get() {
      calls.push("get");
      return view;
    },
  });
  try {
    await editor.settle();
    expect(calls).toEqual(["ensure"]);
    // The original admission persisted, but its response was lost. Owner Stop
    // completed while this same document waited for the network to return.
    editor.reconnect();
    await editor.settle();
    expect(calls).toEqual(["ensure", "get"]);
    expect(editor.editorState()).toBe("stopped");
    expect(editor.editorError()).toContain("stopped");
  } finally {
    editor.dispose();
  }
});

test("a retained editor does not reuse opening demand on Project or access changes; explicit retry still admits", async () => {
  const calls: string[] = [];
  let view: DeveloperIDEView = {
    serviceID: "retained-editor",
    epoch: 15,
    state: "ready",
    failure: null,
  };
  const editor = mountedEditor({
    async ensure() {
      calls.push("ensure");
      if (view.state === "stopped") view = { ...view, epoch: 16, state: "ready" };
      return view;
    },
    async get() {
      calls.push("get");
      return view;
    },
  });
  try {
    await editor.settle();
    expect(calls).toEqual(["ensure"]);
    view = { ...view, state: "stopped" };
    editor.setProjectID("project-b");
    solid.flush();
    await editor.settle();
    expect(calls).toEqual(["ensure", "get"]);
    expect(editor.editorState()).toBe("stopped");
    editor.setAllowed(false);
    solid.flush();
    editor.setAllowed(true);
    solid.flush();
    await editor.settle();
    expect(calls).toEqual(["ensure", "get", "get"]);
    expect(editor.editorState()).toBe("stopped");
    editor.setEditorRetry((value) => value + 1);
    solid.flush();
    await editor.settle();
    expect(calls).toEqual(["ensure", "get", "get", "ensure"]);
    expect(editor.editorState()).toBe("ready");
    expect(view.epoch).toBe(16);
  } finally {
    editor.dispose();
  }
});

test("a paused Source is selected promptly without waiting for native wake or replacing its editor", async () => {
  const source: WorkspaceSourceView = {
    workspaceID: "22222222-2222-4222-8222-222222222222",
    serviceID: "retained-source",
    epoch: 1,
    state: "paused",
    failure: null,
  };
  let reads = 0,
    checks = 0,
    opens = 0;
  const editor = mountedEditor({
    async ensure() {
      opens++;
      return { serviceID: "retained-editor", epoch: 15, state: "ready", failure: null };
    },
    async get() {
      throw new Error("No replacement editor should be requested");
    },
    async source() {
      reads++;
      return source;
    },
    async checkSource() {
      checks++;
      return source;
    },
  });
  try {
    await editor.settle();
    expect(editor.sourceState()).toBe("paused");
    expect(editor.availableSource()).toBe(source.workspaceID);
    expect(editor.fileError()).toBe("");
    const frame = editor.attachment();
    expect(frame?.epoch).toBe(15);
    await editor.retrySource();
    await editor.settle();
    expect(editor.availableSource()).toBe(source.workspaceID);
    expect(editor.attachment()).toBe(frame);
    expect(reads).toBe(1);
    expect(checks).toBe(1);
    expect(opens).toBe(1);
  } finally {
    editor.dispose();
  }
});
