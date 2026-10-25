import { expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { factoryProcess } from "../fixtures/factory-process";
import { productionBuildEnvironment } from "../../scripts/testing/test-prerequisites";

test("actual Factory chat groups retained activity and preserves native disclosure through reconnect", async () => {
  const owned = await factoryProcess();
  let child: Bun.Subprocess<"ignore", "pipe", "pipe"> | undefined;
  let assets: ReturnType<typeof Bun.serve> | undefined;
  try {
    const directory = resolve(".factory/test-results/chat-collaboration", owned.id);
    const frontend = resolve(directory, "frontend");
    await mkdir(directory, { recursive: true });
    const build = Bun.spawn(
      [
        "node",
        resolve("node_modules/vite/bin/vite.js"),
        "build",
        "--config",
        resolve("apps/factory/vite.config.ts"),
        "--outDir",
        frontend,
      ],
      {
        env: productionBuildEnvironment(process.env),
        stdout: "ignore",
        stderr: "pipe",
      },
    );
    const buildErrors = await new Response(build.stderr).text();
    if (await build.exited)
      throw new Error(`Owned chat frontend build failed: ${buildErrors.slice(-1800)}`);
    assets = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        const path = new URL(request.url).pathname;
        const file = resolve(frontend, path === "/" ? "index.html" : path.slice(1));
        if (!file.startsWith(frontend + sep)) return new Response(null, { status: 404 });
        const content = Bun.file(file);
        if (!(await content.exists())) return new Response(null, { status: 404 });
        return new Response(content, {
          headers: {
            "access-control-allow-origin": owned.base,
            "access-control-allow-credentials": "true",
          },
        });
      },
    });
    await owned.startPlanningCache();
    await owned.start();
    const base = owned.base;
    child = Bun.spawn(
      [
        process.execPath,
        "--no-env-file",
        "node_modules/@playwright/test/cli.js",
        "test",
        "test/browser/implementation-journey.spec.ts",
        "test/browser/chat-conversations.spec.ts",
        "--grep",
        "tool activity is one collapsed line|Coding uses one live read|personal conversation history|shared Coding keeps",
        "--reporter=line",
      ],
      {
        env: {
          ...process.env,
          DATABASE_URL: owned.databaseURL,
          FACTORY_BROWSER_BASE_URL: base,
          FACTORY_CHAT_FRONTEND_DIRECTORY: frontend,
          FACTORY_CHAT_ASSET_ORIGIN: assets.url.origin,
          FACTORY_ADMIN_EMAIL: `owned-${owned.id}@factory.local`,
          FACTORY_ADMIN_PASSWORD: "owned-process-password-not-a-secret",
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [output, error, result] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    await mkdir(".factory/test-results/chat-collaboration", { recursive: true });
    await writeFile(".factory/test-results/chat-collaboration/factory-browser.log", output + error);
    if (result !== 0) console.error((output + error).slice(-12000));
    expect(result).toBe(0);
  } finally {
    if (child?.exitCode === null) {
      child.kill("SIGKILL");
      await child.exited;
    }
    await assets?.stop(true);
    await owned.dispose();
  }
}, 300_000);
