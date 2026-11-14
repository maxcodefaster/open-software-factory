import { expect, test } from "bun:test";
import { recoverWorkspaceSource } from "./source-recovery";

function commands() {
  const calls: string[] = [];
  return {
    calls,
    ensure: async (workspace: string) => {
      calls.push(`ensure:${workspace}`);
    },
  };
}

test("an ordinary file-access retry re-observes the same source intent without Stop", async () => {
  const api = commands();
  await recoverWorkspaceSource("retained-workspace", new AbortController().signal, api);
  expect(api.calls).toEqual(["ensure:retained-workspace"]);
});

test("an unavailable Source is not silently retried or replaced", async () => {
  const api = commands();
  api.ensure = async (workspace) => {
    api.calls.push(`ensure:${workspace}`);
    throw Error("Source owner is still unavailable; keep the editor buffer");
  };
  await expect(
    recoverWorkspaceSource("retained-workspace", new AbortController().signal, api),
  ).rejects.toThrow("Source owner is still unavailable");
  expect(api.calls).toEqual(["ensure:retained-workspace"]);
});

test("a cancelled selection does not query another Source owner", async () => {
  const cancelled = new AbortController();
  const api = commands();
  cancelled.abort(new Error("Workspace selection changed"));
  await expect(recoverWorkspaceSource("old-workspace", cancelled.signal, api)).rejects.toThrow(
    "Workspace selection changed",
  );
  expect(api.calls).toEqual([]);
});

test("a late Source observation cannot rebind the editor after selection changes", async () => {
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const cancel = new AbortController();
  const api = commands();
  api.ensure = async (workspace) => {
    api.calls.push(`ensure:${workspace}`);
    entered.resolve();
    await release.promise;
  };
  const recovery = recoverWorkspaceSource("old-workspace", cancel.signal, api);
  await entered.promise;
  cancel.abort(new Error("Workspace selection changed"));
  release.resolve();
  await expect(recovery).rejects.toThrow("Workspace selection changed");
  expect(api.calls).toEqual(["ensure:old-workspace"]);
});
