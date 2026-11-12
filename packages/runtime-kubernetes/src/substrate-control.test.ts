import { expect, spyOn, test } from "bun:test";
import { createSubstrateControl } from "./substrate-control";

test("native lifecycle bridge waits for Substrate finalization while reads keep their existing process bound", async () => {
  let options: { timeout?: number; env?: Record<string, string | undefined> } | undefined;
  const spawn = spyOn(Bun, "spawn").mockImplementation((...args: unknown[]) => {
    options = args[1] as typeof options;
    return {
      stdout: new Response("{}").body,
      stderr: new Response("").body,
      exited: Promise.resolve(0),
    } as ReturnType<typeof Bun.spawn>;
  });
  try {
    const call = createSubstrateControl({
      bridge: "/owned/bridge",
      endpoint: "127.0.0.1:1",
      serverName: "api.ate-system.svc",
      caFile: "/owned/ca",
      tokenFile: "/owned/token",
    });
    for (const method of [
      "ResumeActor",
      "SuspendActor",
      "GetActor",
      "CreateActor",
      "DeleteActor",
    ]) {
      await call(method, {});
      expect(options?.timeout).toBe(
        method === "ResumeActor" || method === "SuspendActor" ? 0 : 185_000,
      );
      expect(Object.keys(options?.env ?? {})).toEqual(["PATH"]);
    }
  } finally {
    spawn.mockRestore();
  }
});
