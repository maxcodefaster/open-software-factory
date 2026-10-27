import { expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServiceForward } from "../../packages/runtime-kubernetes/src/service-forward";

test("source and editor wait for a slow forwarding handshake in the installation's context", async () => {
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
const editor=process.argv.some(value=>value.startsWith("factory-editor-"));
await Bun.write(${JSON.stringify(directory)}+"/"+(editor?"editor":"source")+".json",JSON.stringify(process.argv.slice(2)));
await Bun.sleep(11_000);
console.log("Forwarding from 127.0.0.1:"+(editor?45001:45002)+" -> "+(editor?4400:4600));
await Bun.sleep(60_000);
`,
    );
    await chmod(executable, 0o755);
    process.env["PATH"] = `${directory}:${previous.PATH ?? ""}`;
    process.env["FACTORY_KUBERNETES_CONTEXT"] = "owned-forward-context";
    forwards.push(
      startServiceForward("editor", `factory-editor-${"1".repeat(32)}`, "editor-1"),
      startServiceForward("source", `factory-box-${"2".repeat(32)}`, `source-${"3".repeat(32)}-1`),
    );
    expect(await Promise.all(forwards.map((forward) => forward.endpoint))).toEqual([
      "http://127.0.0.1:45001",
      "http://127.0.0.1:45002",
    ]);
    for (const [role, namespace, pod, port] of [
      ["editor", `factory-editor-${"1".repeat(32)}`, "editor-1", "0:4400"],
      ["source", `factory-box-${"2".repeat(32)}`, `source-${"3".repeat(32)}-1`, "0:4600"],
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
