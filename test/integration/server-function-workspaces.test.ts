import { expect, test } from "bun:test";
import { decodeFactoryResponse as decodeResponse } from "../fixtures/server-functions";
import { CommandError } from "../../apps/factory/src/command-error";
import type { FactoryServices } from "../../apps/factory/src/server-functions/context";
import { type ServerResult, serverCall } from "../../apps/factory/src/server-functions/result";
import { recoverWorkspaceSource } from "../../apps/factory/src/source-recovery";
import { createWorkspaceService } from "../../apps/factory/src/workspace/service";
import { compiledFactoryEndpoint, factoryFunctionRequest } from "../fixtures/server-functions";

test("compiled Workspace lifecycle uses the existing controllers, confirms Stop before another epoch and does not cancel admitted work", async () => {
  const origin = "https://owned-workspaces.test",
    actor = crypto.randomUUID();
  const project = crypto.randomUUID(),
    change = crypto.randomUUID(),
    workspace = crypto.randomUUID();
  let maintenance = true,
    allowed = true,
    authenticated = true;
  let state: "failed" | "stop-intended" | "stopped" | "ready" = "failed",
    stopReads = 0;
  const effects: unknown[][] = [];
  const admitted = Promise.withResolvers<void>(),
    released = Promise.withResolvers<void>();
  const source = () => ({
    workspaceID: workspace,
    label: "Owned source",
    serviceID: "owned-source",
    epoch: state === "ready" ? 2 : 1,
    state,
    failure: state === "failed" ? "Owned preparation failed" : null,
  });
  const editor = { serviceID: "owned-editor", epoch: 1, state: "ready" as const, failure: null };
  const authority = () => {
    if (!allowed) throw new CommandError("forbidden", "Developer access required");
  };
  const service = createWorkspaceService({
    sources: {
      async get(...args) {
        authority();
        if (state === "stop-intended" && ++stopReads >= 2) state = "stopped";
        effects.push(["source-read", ...args, state]);
        return source();
      },
      async ensure(...args) {
        authority();
        if (state !== "stopped") throw new CommandError("conflict", "Stop is unconfirmed");
        effects.push(["source-ensure", ...args]);
        state = "ready";
        return source();
      },
      async ensurePersonal(...args) {
        authority();
        effects.push(["personal", ...args]);
        return source();
      },
      async ensureChange(...args) {
        authority();
        effects.push(["change", ...args]);
        return source();
      },
      async stop(...args) {
        authority();
        effects.push(["source-stop", ...args]);
        state = "stop-intended";
      },
    },
    editors: {
      async get(...args) {
        authority();
        effects.push(["editor-read", ...args]);
        return editor;
      },
      async ensure(...args) {
        authority();
        effects.push(["editor-ensure", ...args]);
        return editor;
      },
      async stop(...args) {
        // The owner must still be able to stop after losing the last Developer role.
        effects.push(["editor-stop", ...args]);
        admitted.resolve();
        await released.promise;
      },
    },
    revokeEditor: (...args) => {
      effects.push(["revoke-editor", ...args]);
    },
  });
  const endpoint = await compiledFactoryEndpoint({
    origin,
    services: { workspaces: service } as unknown as FactoryServices,
    session: async () => (authenticated ? { user: { id: actor } } : null),
    maintenance: async () => maintenance,
    requireFresh: async () => {},
  });
  async function call<T = unknown>(name: string, args: unknown[], signal?: AbortSignal) {
    const result = await decodeResponse<ServerResult<T>>(
      await endpoint(await factoryFunctionRequest(origin, name, args, {}, signal)),
    );
    if (!result) throw new Error("Owned Workspace command returned no result");
    return serverCall(Promise.resolve(result));
  }
  for (const [name, args] of [
    ["ensureWorkspaceSource", [workspace]],
    ["ensurePersonalSource", [project]],
    ["ensureChangeSource", [change]],
    ["ensureDeveloperIDE", [project]],
    ["stopWorkspaceSource", [workspace]],
    ["stopDeveloperIDE", []],
  ] as Array<[string, unknown[]]>)
    await expect(call(name, args)).rejects.toMatchObject({ status: 503 });
  expect(effects).toEqual([]);
  expect(await call("getWorkspaceSource", [workspace])).toMatchObject({
    epoch: 1,
    state: "failed",
  });
  expect(await call("getDeveloperIDE", [])).toMatchObject(editor);
  maintenance = false;
  effects.length = 0;
  for (const name of [
    "getWorkspaceSource",
    "ensureWorkspaceSource",
    "ensurePersonalSource",
    "ensureChangeSource",
    "stopWorkspaceSource",
    "ensureDeveloperIDE",
  ])
    await expect(call(name, ["not-an-identity"])).rejects.toMatchObject({ status: 400 });
  expect(effects).toEqual([]);
  await call("ensurePersonalSource", [project]);
  await call("ensureChangeSource", [change]);
  await call("ensureDeveloperIDE", [project]);
  expect(effects).toEqual([
    ["personal", project, actor],
    ["change", change, actor],
    ["editor-ensure", project, actor],
  ]);
  effects.length = 0;
  const cancellation = new AbortController();
  await recoverWorkspaceSource(workspace, true, cancellation.signal, {
    stop: (id, signal) => call("stopWorkspaceSource", [id], signal),
    read: (id, signal) => call<ReturnType<typeof source>>("getWorkspaceSource", [id], signal),
    ensure: (id, signal) => call("ensureWorkspaceSource", [id], signal),
    wait: async () => {},
  });
  expect(effects).toEqual([
    ["source-stop", workspace, actor],
    ["source-read", workspace, actor, "stop-intended"],
    ["source-read", workspace, actor, "stopped"],
    ["source-ensure", workspace, actor],
  ]);
  allowed = false;
  await expect(call("ensureDeveloperIDE", [project])).rejects.toMatchObject({ status: 403 });
  const stop = new AbortController();
  const pending = call("stopDeveloperIDE", [], stop.signal);
  void pending.catch(() => {});
  await admitted.promise;
  stop.abort();
  expect(effects.at(-1)).toEqual(["editor-stop", actor]);
  released.resolve();
  await pending.catch(() => undefined);
  expect(effects.at(-1)).toEqual(["revoke-editor", actor]);
  expect(effects.filter((effect) => effect[0] === "editor-stop")).toHaveLength(1);
  authenticated = false;
  expect((await endpoint(await factoryFunctionRequest(origin, "getDeveloperIDE", []))).status).toBe(
    401,
  );
});
