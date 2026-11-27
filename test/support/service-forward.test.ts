import { expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServiceForward } from "#runtime-kubernetes/service-forward";

test("the editor waits for a slow forwarding handshake in the installation's context", async () => {
  const directory = await mkdtemp(join(tmpdir(), "factory-owned-forward-"));
  const previous = {
    PATH: process.env["PATH"],
    FACTORY_KUBERNETES_CONTEXT: process.env["FACTORY_KUBERNETES_CONTEXT"],
  };
  const forwards: ReturnType<typeof startServiceForward>[] = [];
  try {
    const executable = join(directory, "kubectl");
    await Bun.write(
      executable,
      `#!${process.execPath}
await Bun.write(${JSON.stringify(directory)}+"/editor.json",JSON.stringify(process.argv.slice(2)));
await Bun.sleep(11_000);
console.log("Forwarding from 127.0.0.1:45001 -> 4400");
await Bun.sleep(60_000);
`,
    );
    await chmod(executable, 0o755);
    process.env["PATH"] = `${directory}:${previous.PATH ?? ""}`;
    process.env["FACTORY_KUBERNETES_CONTEXT"] = "owned-forward-context";
    forwards.push(startServiceForward(`factory-editor-${"1".repeat(32)}`, "editor-1"));
    expect(await Promise.all(forwards.map((forward) => forward.endpoint))).toEqual([
      "http://127.0.0.1:45001",
    ]);
    for (const [role, namespace, pod, port] of [
      ["editor", `factory-editor-${"1".repeat(32)}`, "editor-1", "0:4400"],
    ] as const) {
      expect(JSON.parse(await readFile(join(directory, `${role}.json`), "utf8"))).toEqual([
        "--context",
        "owned-forward-context",
        "port-forward",
        "--address",
        "127.0.0.1",
        "-n",
        namespace,
        `pod/${pod}`,
        port,
      ]);
    }
    expect(forwards.every((forward) => !forward.cancel.signal.aborted)).toBe(true);
  } finally {
    for (const forward of forwards) forward.child.kill();
    await Promise.all(forwards.map((forward) => forward.child.exited));
    expect(forwards.every((forward) => forward.cancel.signal.aborted)).toBe(true);
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(directory, { recursive: true, force: true });
  }
}, 30_000);
