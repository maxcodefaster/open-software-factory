import { expect, test } from "bun:test";
import {
  factoryTerminalPath,
  factoryTerminalClosePath,
  factoryProcessActionPath,
  FactoryRuntimeContext,
} from "../../deploy/theia-ide/factory-ide-extension/src/browser/factory-runtime-context";

const base =
  "http://developer.1.editor.runtime.localhost:3000/editor/11111111-1111-4111-8111-111111111111/1/";
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
