import { expect, test } from "bun:test";
import {
  factoryTerminalPath,
  factoryTerminalClosePath,
  factoryProcessActionPath,
  FactoryRuntimeContext,
} from "../../deploy/theia-ide/factory-ide-extension/src/browser/factory-runtime-context";
import { fixtureValue } from "../fixtures/value";

const base =
  "http://developer.1.h3000.editor.runtime.localhost:3000/editor/11111111-1111-4111-8111-111111111111/1/";
const runtime = {
  workspaceID: "22222222-2222-4222-8222-222222222222",
  attemptID: "33333333-3333-4333-8333-333333333333",
};

test("independent editor terminal attach, reconnect and Close capture their original Workspace and Runtime Attempt", () => {
  const previous = globalThis.window;
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: { location: new URL(base) },
  });
  try {
    expect(factoryTerminalPath(runtime, "terminal-a", base)).toBe(
      `/editor/11111111-1111-4111-8111-111111111111/1/__factory/workspaces/${runtime.workspaceID}/runtime/${runtime.attemptID}/terminal/terminal-a`,
    );
    expect(factoryTerminalClosePath(runtime, "terminal-a", base)).toBe(
      `/editor/11111111-1111-4111-8111-111111111111/1/__factory/workspaces/${runtime.workspaceID}/runtime/${runtime.attemptID}/terminals/terminal-a`,
    );
    expect(factoryProcessActionPath(runtime, "app-web", "restart", base)).toBe(
      `/editor/11111111-1111-4111-8111-111111111111/1/__factory/workspaces/${runtime.workspaceID}/runtime/${runtime.attemptID}/processes/app-web/restart`,
    );
  } finally {
    Object.defineProperty(globalThis, "window", { configurable: true, value: previous });
  }
});

test("source selection only reads compute state and discards an old Workspace's delayed answer", async () => {
  const first = Promise.withResolvers<Response>();
  const calls: Array<{ path: string; method: string }> = [];
  const other = "44444444-4444-4444-8444-444444444444";
  const context = new FactoryRuntimeContext(
    () => base,
    async (input, init) => {
      calls.push({ path: String(input), method: init?.method ?? "GET" });
      if (String(input).includes(runtime.workspaceID)) return first.promise;
      return Response.json({
        workspaceID: other,
        attemptID: null,
        state: "stopped",
        failure: null,
      });
    },
  );
  context.select(runtime.workspaceID);
  context.select(other);
  await Bun.sleep(0);
  expect(context.value?.workspaceID).toBe(other);
  expect(context.value?.state).toBe("stopped");
  first.resolve(Response.json({ ...runtime, state: "ready", failure: null }));
  await Bun.sleep(0);
  expect(context.value?.workspaceID).toBe(other);
  expect(calls.map((call) => call.method)).toEqual(["GET", "GET"]);
  expect(calls.every((call) => !call.path.endsWith("/ensure"))).toBe(true);
});

test("only explicit preparation starts compute and its lost response cannot affect another selected Workspace", async () => {
  const preparing = Promise.withResolvers<Response>();
  const calls: string[] = [];
  const other = "44444444-4444-4444-8444-444444444444";
  const context = new FactoryRuntimeContext(
    () => base,
    async (input, init) => {
      calls.push(init?.method ?? "GET");
      if (init?.method === "POST") return preparing.promise;
      return Response.json({
        workspaceID: String(input).includes(other) ? other : runtime.workspaceID,
        attemptID: null,
        state: "stopped",
        failure: null,
      });
    },
  );
  context.select(runtime.workspaceID);
  await Bun.sleep(0);
  expect(calls).toEqual(["GET"]);
  const requested = context.prepare();
  expect(context.value?.state).toBe("starting");
  await context.prepare();
  expect(calls).toEqual(["GET", "POST"]);
  context.select(other);
  await Bun.sleep(0);
  preparing.resolve(Response.json({ ...runtime, state: "ready", failure: null }));
  await requested;
  expect(context.value?.workspaceID).toBe(other);
  expect(context.value?.state).toBe("stopped");
  expect(calls).toEqual(["GET", "POST", "GET"]);
});

test("quiet runtime observation follows externally started compute without resetting an unchanged editor", async () => {
  let ready = false;
  const calls: string[] = [];
  const context = new FactoryRuntimeContext(
    () => base,
    async (_input, init) => {
      calls.push(init?.method ?? "GET");
      return Response.json({
        workspaceID: runtime.workspaceID,
        attemptID: ready ? runtime.attemptID : null,
        state: ready ? "ready" : "stopped",
        failure: null,
      });
    },
  );
  const states: string[] = [];
  context.subscribe((value) => {
    if (value) states.push(value.state);
  });
  context.select(runtime.workspaceID);
  await Bun.sleep(0);
  await context.observe();
  expect(states).toEqual(["loading", "stopped"]);
  ready = true;
  await context.observe();
  await context.observe();
  expect(states).toEqual(["loading", "stopped", "ready"]);
  expect(context.value?.attemptID).toBe(runtime.attemptID);
  expect(calls.every((method) => method === "GET")).toBe(true);
});

test("deliberately opening an editable Workspace starts once after writing authority arrives", async () => {
  let state = "stopped";
  const calls: string[] = [];
  const context = new FactoryRuntimeContext(
    () => base,
    async (_input, init) => {
      calls.push(init?.method ?? "GET");
      if (init?.method === "POST") state = "ready";
      return Response.json({
        ...runtime,
        attemptID: state === "ready" ? runtime.attemptID : null,
        state,
        failure: null,
      });
    },
  );
  context.select(runtime.workspaceID, true);
  await Bun.sleep(0);
  expect(calls).toEqual(["GET"]);
  context.setWritable("44444444-4444-4444-8444-444444444444", true);
  expect(calls).toEqual(["GET"]);
  context.setWritable(runtime.workspaceID, true);
  await Bun.sleep(0);
  context.setWritable(runtime.workspaceID, true);
  await context.observe();
  expect(context.value?.state).toBe("ready");
  expect(calls.filter((method) => method === "POST")).toHaveLength(1);
});

test("idle observation never wakes compute; real use resumes the original paused Attempt", async () => {
  let state = "ready";
  const calls: string[] = [];
  const context = new FactoryRuntimeContext(
    () => base,
    async (input, init) => {
      const action = fixtureValue(
        String(input).split("/").at(-1),
        'String(input).split("/").at(-1)',
      );
      calls.push(`${init?.method ?? "GET"}:${action}`);
      if (action === "activity") return new Response(null, { status: 409 });
      if (init?.method === "POST") state = "ready";
      return Response.json({ ...runtime, state, failure: null });
    },
  );
  context.select(runtime.workspaceID, true);
  context.setWritable(runtime.workspaceID, true);
  await Bun.sleep(0);
  state = "paused";
  await context.observe();
  await context.observe();
  expect(context.value?.state).toBe("paused");
  expect(calls.filter((call) => call.startsWith("POST"))).toHaveLength(0);
  await context.use();
  await Bun.sleep(0);
  expect(context.value?.attemptID).toBe(runtime.attemptID);
  expect(context.value?.state).toBe("ready");
  expect(calls.filter((call) => call === "POST:ensure")).toHaveLength(1);
  // The browser can still show ready while the server has just paused.
  state = "paused";
  await context.use();
  await Bun.sleep(0);
  expect(calls.filter((call) => call === "POST:ensure")).toHaveLength(2);
});

test("failed automatic preparation is visible and is never repeated by observations or typing", async () => {
  const calls: string[] = [];
  const context = new FactoryRuntimeContext(
    () => base,
    async (_input, init) => {
      calls.push(init?.method ?? "GET");
      if (init?.method === "POST") throw new Error("Original Start outcome is unconfirmed");
      return Response.json({ ...runtime, state: "stopped", failure: null });
    },
  );
  context.select(runtime.workspaceID, true);
  context.setWritable(runtime.workspaceID, true);
  await Bun.sleep(0);
  expect(context.value?.state).toBe("failed");
  expect(context.value?.failure).toContain("unconfirmed");
  await context.observe();
  await context.use();
  context.setWritable(runtime.workspaceID, true);
  expect(calls.filter((method) => method === "POST")).toHaveLength(1);
});
