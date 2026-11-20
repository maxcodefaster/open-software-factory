import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("conversion workers inherit neither Factory credentials nor parent preloads", async () => {
  const directory = await mkdtemp(join(tmpdir(), "factory-conversion-isolation-"));
  let child: Bun.Subprocess<"ignore", "pipe", "pipe"> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const preload = join(directory, "preload.mjs");
    const runner = join(directory, "runner.mjs");
    await writeFile(preload, `globalThis.factoryConversionPreloaded = true;`);
    await writeFile(
      runner,
      `
      import assert from "node:assert/strict";
      import { processAttachment } from ${JSON.stringify(new URL("./process.ts", import.meta.url).href)};
      assert.equal(globalThis.factoryConversionPreloaded, true);
      assert.equal(process.env.FACTORY_CONVERSION_TEST_CREDENTIAL, "owned-test-credential");
      const probe = URL.createObjectURL(new Blob([\`
        self.onmessage = () => self.postMessage({
          result: {
            text: JSON.stringify({
              credential: process.env.FACTORY_CONVERSION_TEST_CREDENTIAL ?? null,
              preloaded: globalThis.factoryConversionPreloaded ?? false,
            }),
            previews: [],
          },
        });
      \`], { type: "text/javascript" }));
      const OriginalWorker = globalThis.Worker;
      // Confirm the probe observes credentials and an executed preload when passed explicitly.
      const control = new OriginalWorker(probe, {
        env: { FACTORY_CONVERSION_TEST_CREDENTIAL: "owned-test-credential" },
        preload: [${JSON.stringify(preload)}],
      });
      try {
        await new Promise((resolve, reject) => {
          control.onerror = reject;
          control.onmessage = (event) => {
            try {
              assert.deepEqual(JSON.parse(event.data.result.text), {
                credential: "owned-test-credential",
                preloaded: true,
              });
              resolve();
            } catch (cause) {
              reject(cause);
            }
          };
          control.postMessage({});
        });
      } finally {
        control.terminate();
      }
      let options;
      globalThis.Worker = new Proxy(OriginalWorker, {
        construct(target, args) {
          assert.equal(args[0], ${JSON.stringify(new URL("./conversion-worker.ts", import.meta.url).href)});
          options = args[1];
          return Reflect.construct(target, [probe, options]);
        },
      });
      try {
        const result = await processAttachment(new TextEncoder().encode("context"), "text/plain");
        assert.deepEqual(JSON.parse(result.text), { credential: null, preloaded: false });
        assert.deepEqual(options.env, {});
        assert.deepEqual(options.preload, []);
      } finally {
        globalThis.Worker = OriginalWorker;
        URL.revokeObjectURL(probe);
      }
      `,
    );
    child = Bun.spawn([process.execPath, "--no-env-file", "--preload", preload, runner], {
      env: { FACTORY_CONVERSION_TEST_CREDENTIAL: "owned-test-credential" },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    timer = setTimeout(() => child?.kill(), 5_000);
    const [exit, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
    expect(stderr).toBe("");
    expect(exit).toBe(0);
  } finally {
    if (timer) clearTimeout(timer);
    child?.kill();
    await child?.exited;
    await rm(directory, { recursive: true, force: true });
  }
});
