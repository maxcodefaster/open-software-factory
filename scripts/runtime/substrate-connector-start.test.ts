import { expect, test } from "bun:test";

test("native Connector entrypoint refuses absent workload and non-profile namespace paths before entering anything", async () => {
  for (const [args, state] of [
    [[], "/run/user/1000/docker-direct"],
    [["must-not-run"], "/unowned/namespace"],
    [["must-not-run"], ""],
  ] as const) {
    const p = Bun.spawn(["sh", "deploy/substrate/rootless/connector.sh", ...args], {
      env: { PATH: process.env["PATH"] ?? "/usr/bin:/bin", DOCKERD_ROOTLESSKIT_STATE_DIR: state },
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(await p.exited).not.toBe(0);
    expect(await new Response(p.stdout).text()).toBe("");
  }
});
