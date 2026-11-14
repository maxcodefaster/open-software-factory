import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

test("Actor package proof requires a matching native host and cannot start lifecycle or expose a host socket", async () => {
  const directory = await mkdtemp(join(tmpdir(), "factory-native-image-proof-"));
  const calls = join(directory, "calls");
  const image = `sha256:${"a".repeat(64)}`;
  try {
    await writeFile(
      join(directory, "docker"),
      `#!/bin/bash
printf '%s\\n' "$*" >> "$OWNED_CALLS"
if [[ "$1" == image ]]; then printf '%s\\n' "$OWNED_PLATFORM"; exit 0; fi
if [[ "$1" == version ]]; then printf '%s\\n' "$OWNED_HOST_PLATFORM"; exit 0; fi
test "$1" = run
`,
      { mode: 0o700 },
    );
    for (const [platform, host, expected] of [
      ["linux/amd64", "linux/amd64", 0],
      ["linux/arm64", "linux/arm64", 0],
      ["linux/amd64", "linux/arm64", 1],
      ["linux/arm64", "linux/amd64", 1],
      ["linux/riscv64", "linux/riscv64", 1],
    ] as const) {
      await writeFile(calls, "");
      const process = Bun.spawn(["bash", "scripts/runtime/substrate-image-proof.sh", image], {
        env: {
          ...globalThis.process.env,
          PATH: `${directory}:${globalThis.process.env["PATH"]}`,
          OWNED_CALLS: calls,
          OWNED_PLATFORM: platform,
          OWNED_HOST_PLATFORM: host,
        },
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(await process.exited).toBe(expected);
      const observed = await readFile(calls, "utf8");
      if (expected) expect(observed).not.toContain("run --rm");
      else {
        expect(observed).toContain(`--entrypoint /bin/sh ${image}`);
        for (const flag of [
          "--network=none",
          "--read-only",
          "--cap-drop=ALL",
          "--user 1000:1000",
          "--security-opt=no-new-privileges",
        ])
          expect(observed).toContain(flag);
        expect(observed).not.toMatch(/--privileged|--volume|--mount/);
        const output = JSON.parse((await new Response(process.stdout).text()).trim());
        expect(output.nativeActorLifecycle).toBe(false);
        expect(output.platform).toBe(platform);
      }
    }
    const script = await readFile(resolve("scripts/runtime/substrate-image-proof.sh"), "utf8");
    expect(script).not.toContain("native-parent");
    expect(script).not.toContain('start.sh" ');
    const syntax = Bun.spawn(["bash", "-n", "scripts/runtime/substrate-image-proof.sh"], {
      stdout: "ignore",
      stderr: "pipe",
    });
    expect(await syntax.exited).toBe(0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
