import { expect, test } from "bun:test";
import {
  FactoryRuntimeContext,
  factoryProcessActionPath,
  factoryTerminalClosePath,
  factoryTerminalPath,
  runtimePreparationCopy,
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

test("editable Source and writing authority stay read-only until explicit compute preparation", async () => {
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
  context.select(runtime.workspaceID);
  await Bun.sleep(0);
  expect(calls).toEqual(["GET"]);
  context.setWritable("44444444-4444-4444-8444-444444444444", true);
  expect(calls).toEqual(["GET"]);
  context.setWritable(runtime.workspaceID, true);
  await Bun.sleep(0);
  context.setWritable(runtime.workspaceID, true);
  await context.observe();
  await context.use();
  expect(context.value?.state).toBe("stopped");
  expect(calls.filter((method) => method === "POST")).toHaveLength(0);
  await context.prepare();
  expect(context.value?.state).toBe("ready");
  expect(calls.filter((method) => method === "POST")).toHaveLength(1);
});

test("an observation-only IDE cannot reuse its old opening demand after Coding Stop", async () => {
  let state = "ready";
  const calls: string[] = [];
  const context = new FactoryRuntimeContext(
    () => base,
    async (_input, init) => {
      calls.push(init?.method ?? "GET");
      if (init?.method === "POST") state = "ready";
      return Response.json({ ...runtime, state, failure: null });
    },
  );
  // The IDE was opened while the Agent held writing authority. It is still
  // observing the same Workspace when a later explicit Stop completes.
  context.select(runtime.workspaceID);
  context.setWritable(runtime.workspaceID, false);
  await Bun.sleep(0);
  expect(context.value?.state).toBe("ready");
  state = "stopped";
  await context.observe();
  context.setWritable(runtime.workspaceID, true);
  await Bun.sleep(0);
  await context.observe();
  expect(context.value?.state).toBe("stopped");
  expect(calls.filter((method) => method === "POST")).toHaveLength(0);
  // Typing in the Source editor is activity, not a new compute request.
  await context.use();
  await Bun.sleep(0);
  expect(context.value?.state).toBe("stopped");
  expect(calls.filter((method) => method === "POST")).toHaveLength(0);
  await context.prepare();
  expect(context.value?.state).toBe("ready");
  expect(calls.filter((method) => method === "POST")).toHaveLength(1);
});

test("read-only selection of stopped Source does not wait indefinitely to start on authority changes", async () => {
  let state = "stopped";
  const calls: string[] = [];
  const context = new FactoryRuntimeContext(
    () => base,
    async (_input, init) => {
      calls.push(init?.method ?? "GET");
      if (init?.method === "POST") state = "ready";
      return Response.json({ ...runtime, state, failure: null });
    },
  );
  context.select(runtime.workspaceID);
  context.setWritable(runtime.workspaceID, false);
  await Bun.sleep(0);
  context.setWritable(runtime.workspaceID, true);
  await Bun.sleep(0);
  expect(context.value?.state).toBe("stopped");
  expect(calls.filter((method) => method === "POST")).toHaveLength(0);
  // Reopening Source still does not prepare compute.
  context.select(runtime.workspaceID);
  context.setWritable(runtime.workspaceID, true);
  await Bun.sleep(0);
  expect(context.value?.state).toBe("stopped");
  expect(calls.filter((method) => method === "POST")).toHaveLength(0);
});

test("Source activity never wakes compute; explicit preparation resumes the original paused Attempt", async () => {
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
  context.select(runtime.workspaceID);
  context.setWritable(runtime.workspaceID, true);
  await Bun.sleep(0);
  state = "paused";
  await context.observe();
  await context.observe();
  expect(context.value?.state).toBe("paused");
  expect(calls.filter((call) => call.startsWith("POST"))).toHaveLength(0);
  await context.use();
  await Bun.sleep(0);
  expect(context.value?.state).toBe("paused");
  expect(calls.filter((call) => call === "POST:ensure")).toHaveLength(0);
  await context.prepare();
  expect(context.value?.attemptID).toBe(runtime.attemptID);
  expect(context.value?.state).toBe("ready");
  expect(calls.filter((call) => call === "POST:ensure")).toHaveLength(1);
  // The browser can still show ready while the server has just paused.
  state = "paused";
  await context.use();
  await Bun.sleep(0);
  expect(context.value?.state).toBe("paused");
  expect(calls.filter((call) => call === "POST:ensure")).toHaveLength(1);
});

test("failed explicit preparation is visible and is never repeated by observations or typing", async () => {
  const calls: string[] = [];
  const context = new FactoryRuntimeContext(
    () => base,
    async (_input, init) => {
      calls.push(init?.method ?? "GET");
      if (init?.method === "POST") throw new Error("Original Start outcome is unconfirmed");
      return Response.json({ ...runtime, state: "stopped", failure: null });
    },
  );
  context.select(runtime.workspaceID);
  context.setWritable(runtime.workspaceID, true);
  await Bun.sleep(0);
  expect(context.value?.state).toBe("stopped");
  await context.prepare();
  expect(context.value?.state).toBe("failed");
  expect(context.value?.failure).toContain("unconfirmed");
  await context.observe();
  await context.use();
  context.setWritable(runtime.workspaceID, true);
  expect(calls.filter((method) => method === "POST")).toHaveLength(1);
});

test("every compute state is described honestly in the Run, Git and Terminal panels", () => {
  const copy = (state: string, failure: string | null = null) =>
    runtimePreparationCopy({ ...runtime, state, failure });
  expect(runtimePreparationCopy(undefined)).toBe("Select a Workspace to use its environment.");
  expect(copy("stopped")).toBe(
    "Environment stopped. Start it when you need a terminal or preview.",
  );
  expect(copy("paused")).toBe(
    "Environment paused. Resume to use terminals or previews — opening files resumes it automatically.",
  );
  expect(copy("pausing")).toBe("Pausing environment for everyone… Your files are saved.");
  expect(copy("starting")).toBe("Starting environment… Your open files stay intact.");
  expect(copy("resuming")).toBe("Starting environment… Your open files stay intact.");
  expect(copy("stopping")).toBe("Stopping environment… Your open files stay intact.");
  expect(copy("cleanup-failed")).toBe(
    "Previous environment shutdown is unconfirmed. Start is paused until cleanup completes; your files are safe.",
  );
  expect(copy("cleanup-failed")).not.toContain("Stopping");
  expect(copy("failed", "Dev Container build failed")).toBe("Dev Container build failed");
  expect(copy("resuming", `restore failed ${"criu log line ".repeat(60)}`)).toBe(
    "Could not confirm environment resume. Your files are safe — check status before retrying.",
  );
  expect(
    copy("failed", `restore failed ${"criu log line ".repeat(60)}`).length,
  ).toBeLessThanOrEqual(241);
});

test("a capacity-wait rejection on ensure stays visible across starting observations until ready or retried", async () => {
  const capacityError =
    "Waiting for available compute capacity — no worker has room for this Workspace yet. Your files are safe; retry shortly.";
  let serverState = "stopped";
  let capacityAvailable = false;
  const calls: string[] = [];
  const context = new FactoryRuntimeContext(
    () => base,
    async (_input, init) => {
      const method = init?.method ?? "GET";
      calls.push(method);
      if (method === "POST") {
        serverState = "starting";
        if (!capacityAvailable) return Response.json({ error: capacityError }, { status: 503 });
        serverState = "ready";
        return Response.json({ ...runtime, state: "ready", failure: null }, { status: 202 });
      }
      return Response.json({ ...runtime, state: serverState, failure: null });
    },
  );
  context.select(runtime.workspaceID);
  context.setWritable(runtime.workspaceID, true);
  await Bun.sleep(0);
  expect(context.value?.state).toBe("stopped");
  await context.prepare();
  expect(context.value).toMatchObject({ state: "failed", failure: capacityError });
  expect(runtimePreparationCopy(context.value)).toBe(capacityError);
  // Periodic observation sees the persisted "starting" attempt with failure=null.
  // It must keep surfacing the capacity wait without hanging in a polling loop.
  await context.observe();
  expect(context.value).toMatchObject({
    attemptID: runtime.attemptID,
    state: "failed",
    failure: capacityError,
  });
  expect(runtimePreparationCopy(context.value)).toBe(capacityError);
  expect(calls).toEqual(["GET", "POST", "GET"]);
  // Retrying once capacity frees up clears the preparation failure and reaches ready.
  capacityAvailable = true;
  await context.prepare();
  expect(context.value).toMatchObject({
    attemptID: runtime.attemptID,
    state: "ready",
    failure: null,
  });
  // A later pause must not resurrect the earlier preparation failure.
  serverState = "paused";
  await context.observe();
  expect(context.value).toMatchObject({
    attemptID: runtime.attemptID,
    state: "paused",
    failure: null,
  });
});

test("a native failure settles without offering an unsupported destructive recovery", async () => {
  const calls: string[] = [];
  const context = new FactoryRuntimeContext(
    () => base,
    async (input, init) => {
      const method = init?.method ?? "GET";
      calls.push(`${method} ${String(input).split("/runtime")[1] ?? ""}`);
      return Response.json({
        ...runtime,
        state: "failed",
        failure: "Native execution crashed; the original Actor was retained",
      });
    },
  );
  context.select(runtime.workspaceID);
  await Bun.sleep(30);
  // Settled: the read loop stops instead of polling until its deadline.
  expect(context.value).toMatchObject({ state: "failed" });
  const reads = calls.length;
  await Bun.sleep(1100);
  expect(calls.length).toBe(reads);
  expect(runtimePreparationCopy(context.value)).toContain("original Actor was retained");
  expect(runtimePreparationCopy(context.value)).not.toContain("Start fresh");
  expect("startFresh" in context).toBe(false);
  expect(calls.filter((call) => call.startsWith("POST"))).toHaveLength(0);
});

test("an unknown restore outcome stays quarantined with no Start fresh", async () => {
  const calls: string[] = [];
  const context = new FactoryRuntimeContext(
    () => base,
    async (input, init) => {
      calls.push(`${init?.method ?? "GET"} ${String(input)}`);
      return Response.json({
        ...runtime,
        state: "resuming",
        failure: "Factorybox resume outcome is unconfirmed: reply lost",
      });
    },
  );
  context.select(runtime.workspaceID);
  context.setWritable(runtime.workspaceID, true);
  await Bun.sleep(50);
  expect(calls.every((call) => call.startsWith("GET"))).toBe(true);
  expect(runtimePreparationCopy(context.value)).toContain("Could not confirm environment resume");
  expect(runtimePreparationCopy(context.value)).not.toContain("Start fresh");
});

test("Pause shows pending immediately, keeps the original Attempt and resumes only explicitly", async () => {
  const pending = Promise.withResolvers<Response>();
  const calls: Array<{ path: string; method: string; body: unknown }> = [];
  let state = "ready";
  const context = new FactoryRuntimeContext(
    () => base,
    async (input, init) => {
      const path = String(input);
      calls.push({
        path,
        method: init?.method ?? "GET",
        body: typeof init?.body === "string" ? JSON.parse(init.body) : null,
      });
      if (path.endsWith("/pause")) return pending.promise;
      if (path.endsWith("/ensure")) state = "ready";
      return Response.json({ ...runtime, state, failure: null });
    },
  );
  context.select(runtime.workspaceID);
  context.setWritable(runtime.workspaceID, true);
  await Bun.sleep(0);
  const paused = context.pause();
  expect(context.value).toMatchObject({ ...runtime, state: "pausing" });
  expect(runtimePreparationCopy(context.value)).toContain("Pausing");
  await context.pause();
  expect(calls.filter((call) => call.path.endsWith("/pause"))).toHaveLength(1);
  expect(calls.at(-1)).toMatchObject({
    method: "POST",
    body: { requestID: expect.any(String) },
  });
  state = "paused";
  pending.resolve(Response.json({ id: runtime.attemptID, state }));
  await paused;
  expect(context.value).toMatchObject({ ...runtime, state: "paused" });
  expect(runtimePreparationCopy(context.value)).toContain("opening files resumes it automatically");
  expect(calls.filter((call) => call.path.endsWith("/ensure"))).toHaveLength(0);
  await context.prepare();
  expect(context.value).toMatchObject({ ...runtime, state: "ready" });
  expect(calls.filter((call) => call.path.endsWith("/ensure"))).toHaveLength(1);
});

test("a lost Pause reply retains its exact requestID and never becomes a new Start or Pause", async () => {
  const requests: string[] = [];
  let lost = true;
  let observationLost = false;
  const context = new FactoryRuntimeContext(
    () => base,
    async (input, init) => {
      if (String(input).endsWith("/pause")) {
        requests.push(JSON.parse(String(init?.body)).requestID);
        if (lost) throw new Error("Owned lost Pause response");
        return Response.json({ state: "uncertain" });
      }
      expect(init?.method).not.toBe("POST");
      if (observationLost) throw new Error("Owned lost compute observation");
      return Response.json({ ...runtime, state: "ready", failure: null });
    },
  );
  context.select(runtime.workspaceID);
  context.setWritable(runtime.workspaceID, true);
  await Bun.sleep(0);
  await context.pause();
  expect(context.value).toMatchObject({ ...runtime, state: "pause-uncertain" });
  expect(context.value?.failure).toContain(requests[0]);
  await context.prepare();
  await context.observe();
  await context.use();
  observationLost = true;
  await context.observe();
  await context.prepare();
  expect(requests).toHaveLength(1);
  expect(context.value?.state).toBe("pause-uncertain");
  expect(context.value?.attemptID).toBe(runtime.attemptID);
  observationLost = false;
  context.select(runtime.workspaceID);
  context.setWritable(runtime.workspaceID, true);
  await Bun.sleep(0);
  await context.prepare();
  expect(requests).toHaveLength(1);
  expect(context.value?.state).toBe("pause-uncertain");
  lost = false;
  await context.pause();
  expect(requests).toHaveLength(2);
  expect(new Set(requests).size).toBe(1);
  expect(context.value?.state).toBe("pause-uncertain");
});

test("observers cannot pause and a delayed Pause cannot replace another selected Workspace", async () => {
  const pending = Promise.withResolvers<Response>();
  const other = "44444444-4444-4444-8444-444444444444";
  const writes: string[] = [];
  const context = new FactoryRuntimeContext(
    () => base,
    async (input, init) => {
      if (init?.method === "POST") {
        writes.push(String(input));
        return pending.promise;
      }
      return Response.json({
        ...runtime,
        workspaceID: String(input).includes(other) ? other : runtime.workspaceID,
        state: "ready",
        failure: null,
      });
    },
  );
  context.select(runtime.workspaceID);
  await Bun.sleep(0);
  await context.pause();
  expect(writes).toHaveLength(0);
  context.setWritable(runtime.workspaceID, true);
  const paused = context.pause();
  context.select(other);
  await Bun.sleep(0);
  pending.resolve(Response.json({ id: runtime.attemptID, state: "paused" }));
  await paused;
  expect(context.value).toMatchObject({ workspaceID: other, state: "ready" });
  expect(writes).toHaveLength(1);
});
