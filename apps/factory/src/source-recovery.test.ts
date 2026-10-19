import { expect, test } from "bun:test";
import { recoverWorkspaceSource } from "./source-recovery";

function commands(states: Array<"stop-intended" | "stopped" | "failed"> = ["stopped"]) {
  const calls: string[] = [];
  return {
    calls,
    stop: async (workspace: string) => {
      calls.push(`stop:${workspace}`);
    },
    read: async (workspace: string) => {
      const state = states.shift();
      if (!state) throw Error("Unexpected source poll");
      calls.push(`read:${workspace}:${state}`);
      return { state };
    },
    ensure: async (workspace: string) => {
      calls.push(`ensure:${workspace}`);
    },
    wait: async () => {},
  };
}

test("an ordinary file-access retry re-observes the same source intent without Stop", async () => {
  const api = commands();
  await recoverWorkspaceSource("retained-workspace", false, new AbortController().signal, api);
  expect(api.calls).toEqual(["ensure:retained-workspace"]);
});

test("an explicit file-access restart confirms Stop before ensuring the frozen Workspace", async () => {
  const api = commands(["stop-intended", "stopped"]);
  await recoverWorkspaceSource("retained-workspace", true, new AbortController().signal, api);
  expect(api.calls).toEqual([
    "stop:retained-workspace",
    "read:retained-workspace:stop-intended",
    "read:retained-workspace:stopped",
    "ensure:retained-workspace",
  ]);
});

test("failed or cancelled Stop never starts another source access epoch", async () => {
  const failed = commands(["failed"]);
  await expect(
    recoverWorkspaceSource("retained-workspace", true, new AbortController().signal, failed),
  ).rejects.toThrow("Stop was not confirmed");
  expect(failed.calls.some((call) => call.startsWith("ensure:"))).toBe(false);
  const cancelled = new AbortController();
  const stopped = Promise.withResolvers<void>();
  const api = commands();
  api.stop = async (workspace) => {
    api.calls.push(`stop:${workspace}`);
    await stopped.promise;
  };
  const recovery = recoverWorkspaceSource("old-workspace", true, cancelled.signal, api);
  cancelled.abort(new Error("Workspace selection changed"));
  stopped.resolve();
  await expect(recovery).rejects.toThrow("Workspace selection changed");
  expect(api.calls).toEqual(["stop:old-workspace"]);
});

test("a late stopped observation cannot start source access after selection changes", async () => {
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const cancel = new AbortController();
  const api = commands();
  api.read = async (workspace) => {
    api.calls.push(`read:${workspace}:pending`);
    entered.resolve();
    await release.promise;
    return { state: "stopped" };
  };
  const recovery = recoverWorkspaceSource("old-workspace", true, cancel.signal, api);
  await entered.promise;
  cancel.abort(new Error("Workspace selection changed"));
  release.resolve();
  await expect(recovery).rejects.toThrow("Workspace selection changed");
  expect(api.calls).toEqual(["stop:old-workspace", "read:old-workspace:pending"]);
});
