import { expect, test } from "bun:test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { readRuntimeRegistryCA } from "../../packages/runtime-kubernetes/src/client";
import { configuredFactoryboxRuntimeProfile } from "../../packages/runtime-kubernetes/src/factorybox-runtime";
import { createConformanceRuntime } from "../../scripts/runtime/factorybox-conformance";
import { factoryboxFixtureCommand, observeFactoryboxFixture } from "../fixtures/factorybox-runtime";

test.skipIf(process.env["FACTORY_RUN_FACTORYBOX_FIXTURE_PROOF"] !== "1")(
  "Factorybox fixture transport inspects its actual Sandbox and retains a private RAM actor through Pause",
  async () => {
    const owner = crypto.randomUUID();
    const artifacts = resolve(".factory/test-results/factorybox-fixture", owner);
    await mkdir(artifacts, { recursive: true });
    for (const [name, path] of [
      ["fixture-source.ts", "test/support/factorybox-fixture.live.test.ts"],
      ["transport-source.ts", "test/fixtures/factorybox-runtime.ts"],
      ["preparer-source.py", "packages/runtime-kubernetes/src/factorybox/prepare.py"],
    ] as const)
      await writeFile(resolve(artifacts, name), await readFile(path, "utf8"), {
        flag: "wx",
        mode: 0o400,
      });
    const image = (
      process.env["FACTORY_RUNTIME_CONFORMANCE_IMAGE"] ??
      (await readFile(".factory/runtime-host-image", "utf8"))
    ).trim();
    const runtime = createConformanceRuntime(
      owner,
      image,
      configuredFactoryboxRuntimeProfile(),
      await readRuntimeRegistryCA(),
      artifacts,
    );
    try {
      await runtime.prepare();
      const target = runtime.target();
      const command = (args: string[]) => factoryboxFixtureCommand(target, args);
      // These assertions run inside the Sandbox, not in an ambient worker
      // Docker daemon. An unused seed owns no checkout, runtime state or tokens.
      expect((await command(["docker", "ps", "--all", "--quiet"])).trim()).toBe("");
      expect((await command(["docker", "volume", "ls", "--quiet"])).trim()).toBe("");
      expect(
        (
          await command([
            "sh",
            "-ec",
            "test ! -e /home/coder/project && test ! -e /home/coder/connector-state && test ! -e /run/factory-parent-token && test ! -e /run/factory-child-token && echo clean",
          ])
        ).trim(),
      ).toBe("clean");
      const actor =
        'const nonce=require("node:crypto").randomUUID();let counter=0;setInterval(()=>counter++,10);require("node:http").createServer((req,res)=>res.end(JSON.stringify({nonce,pid:process.pid,counter}))).listen(19471,"127.0.0.1");';
      await command([
        "node",
        "-e",
        `const child=require("node:child_process").spawn(process.execPath,["-e",${JSON.stringify(actor)}],{detached:true,stdio:"ignore"});child.unref();`,
      ]);
      const sample = async () =>
        JSON.parse(
          await command([
            "node",
            "-e",
            'let tries=0;function read(){const req=require("node:http").get("http://127.0.0.1:19471",res=>res.pipe(process.stdout));req.setTimeout(5000,()=>req.destroy(new Error("actor timeout")));req.on("error",()=>{if(++tries<10)setTimeout(read,100);else process.exit(1);});}read();',
          ]),
        ) as { nonce: string; pid: number; counter: number };
      const before = await sample();
      const original = await observeFactoryboxFixture(target);
      const pauseResume = await runtime.pauseResume();
      const after = await sample();
      const resumed = await observeFactoryboxFixture(target);
      expect(resumed.record.owner).toBe(original.record.owner);
      expect(resumed.record.runtime_id).toBe(original.record.runtime_id);
      expect(after.nonce).toBe(before.nonce);
      expect(after.pid).toBe(before.pid);
      expect(after.counter).toBeGreaterThan(before.counter);
      await writeFile(
        resolve(artifacts, "fixture-transport.json"),
        `${JSON.stringify({ owner, original, resumed, before, after, snapshotID: pauseResume.snapshotID }, null, 2)}\n`,
        { flag: "wx", mode: 0o600 },
      );
      await runtime.passed();
    } catch (cause) {
      await writeFile(
        resolve(artifacts, "failure.json"),
        `${JSON.stringify({ owner, error: cause instanceof Error ? cause.message : String(cause) })}\n`,
        { flag: "wx", mode: 0o600 },
      );
      throw cause;
    } finally {
      await runtime.cleanup();
    }
  },
  420_000,
);
