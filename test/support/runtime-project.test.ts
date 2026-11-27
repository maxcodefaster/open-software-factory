import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parse } from "yaml";
import { parseSubstrateProjectTemplate } from "#runtime-kubernetes/substrate-project-template";
import { parseSystemContract } from "#system-contract/system-contract";
import {
  configurationPath,
  validateConfiguration,
} from "../../apps/factory/src/setup/configuration";
import { configuredRuntimeProjectFiles, runtimeProjectFiles } from "../fixtures/runtime-project";
import { controlledStarterInput, installControlledStarterCatalog } from "../fixtures/starter";

test.each(["linux/arm64", "linux/amd64"])(
  "runtime fixture materializes the explicit %s image in its native source, without legacy files",
  async (platform) => {
    const images = { ...controlledStarterInput.images, platform };
    const files = await runtimeProjectFiles({ platform, images });
    const content = (path: string) => {
      const file = files.find((file) => file.path === path);
      if (!file) throw new Error(`Missing native fixture source ${path}`);
      return file.content;
    };
    const native = parseSubstrateProjectTemplate(content(".factory/actor-template.json"));
    expect(native.containers).toEqual([
      {
        name: "work",
        image: images.development,
        volumeMounts: [
          { name: "source", mountPath: "/workspace" },
          { name: "fixture-data", mountPath: "/data" },
        ],
      },
    ]);
    expect(native.volumes.map((volume) => volume.name)).toEqual(["source", "fixture-data"]);
    expect(content(".factory/actor-template.json")).not.toContain("unpublished-starter-work");
    const system = parseSystemContract(content(".factory/system.json"));
    expect(system.primaryApp).toBe("web");
    expect(system.apps.map((app) => [app.id, app.command, app.port])).toEqual([
      ["support", ["node", "support.mjs"], 4100],
      ["web", ["node", "src/server.mjs"], 4300],
      ["worker", ["node", "src/worker.mjs"], 4310],
    ]);
    expect(() =>
      validateConfiguration(
        files.filter((file) => configurationPath(file.path)),
        files.map((file) => file.path),
      ),
    ).not.toThrow();
    expect(files.some((file) => /devcontainer|compose|Dockerfile/.test(file.path))).toBe(false);
    expect(content(".forgejo/workflows/factory-verification.yml")).toContain("git rev-parse HEAD");
    expect(content(".forgejo/workflows/factory-verification.yml")).not.toContain("/workspace/");
    const workflow = parse(content(".forgejo/workflows/factory-verification.yml"));
    expect(
      workflow.jobs.verify.steps.map(
        (step: { "working-directory": string }) => step["working-directory"],
      ),
    ).toEqual(["${{ env.FACTORY_CHECKOUT_ROOT }}", "${{ env.FACTORY_CHECKOUT_ROOT }}"]);
    expect(content("support.mjs")).not.toContain("chown");
    expect(content("src/server.mjs")).toContain("http://127.0.0.1:4100/");
  },
);

test("runtime fixture has no image-publication or architecture fallback", async () => {
  await expect(runtimeProjectFiles({ platform: "linux/arm64", images: undefined })).rejects.toThrow(
    "Publish",
  );
  await expect(
    runtimeProjectFiles({ platform: "linux/amd64", images: controlledStarterInput.images }),
  ).rejects.toThrow("selected native runtime");
});

test("configured live fixture uses the selected native architecture and never the removed cache", async () => {
  const root = await mkdtemp(join(tmpdir(), "factory-native-fixture-catalog-"));
  const file = join(root, "native.json");
  const previous = process.env["FACTORY_STARTER_IMAGES"];
  try {
    for (const architecture of ["arm64", "amd64"]) {
      await writeFile(
        file,
        JSON.stringify({
          runtime: { version: { attributes: [{ key: "architecture", value: architecture }] } },
        }),
      );
      process.env["FACTORY_STARTER_IMAGES"] = JSON.stringify({
        ...controlledStarterInput.images,
        platform: `linux/${architecture}`,
      });
      expect(await configuredRuntimeProjectFiles(file)).toHaveLength(9);
    }
    process.env["FACTORY_STARTER_IMAGES"] = JSON.stringify(controlledStarterInput.images);
    await expect(configuredRuntimeProjectFiles(file)).rejects.toThrow("selected native runtime");
    delete process.env["FACTORY_STARTER_IMAGES"];
    await expect(configuredRuntimeProjectFiles(file)).rejects.toThrow("Publish");
  } finally {
    if (previous === undefined) delete process.env["FACTORY_STARTER_IMAGES"];
    else process.env["FACTORY_STARTER_IMAGES"] = previous;
    await rm(root, { recursive: true, force: true });
  }
});

test("controlled Starter setup cannot replace live images and restores exact inherited settings", async () => {
  const root = await mkdtemp(join(tmpdir(), "factory-controlled-starter-"));
  const file = join(root, "native.json");
  const catalogKey = "FACTORY_STARTER_IMAGES";
  const configurationKey = "FACTORY_SUBSTRATE_WORKSPACES_CONFIGURATION";
  const previous = [process.env[catalogKey], process.env[configurationKey]];
  let restore = () => {};
  try {
    const runtime = {
      version: { attributes: [{ key: "architecture", value: "arm64" }] },
    };
    await writeFile(file, JSON.stringify({ deployment: "fresh-workspaces", runtime }));
    await expect(installControlledStarterCatalog(file)).rejects.toThrow("live native installation");
    expect([process.env[catalogKey], process.env[configurationKey]]).toEqual(previous);
    await writeFile(file, JSON.stringify({ deployment: "owned-test", runtime }));
    restore = await installControlledStarterCatalog(file);
    expect(JSON.parse(process.env[catalogKey] ?? "{}").platform).toBe("linux/arm64");
    expect(process.env[configurationKey]).toBe(file);
  } finally {
    restore();
    expect([process.env[catalogKey], process.env[configurationKey]]).toEqual(previous);
    await rm(root, { recursive: true, force: true });
  }
});

test("authored runtime fixture repository checks run without dependencies or native setup", async () => {
  const child = Bun.spawn(["npm", "run", "check"], {
    cwd: resolve("test/fixtures/runtime-project"),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
  expect({ code, stderr }).toEqual({ code: 0, stderr: "" });
  const legacy = await readdir("test/fixtures/runtime-project/.devcontainer").catch(() => []);
  expect(legacy).toEqual([]);
});

test("actual fixture Web reports dependency startup honestly and reaches its loopback Support", async () => {
  const root = await mkdtemp(join(tmpdir(), "factory-native-loopback-"));
  const children: ReturnType<typeof Bun.spawn>[] = [];
  const reservation = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
  const supportPort = reservation.port;
  await reservation.stop(true);
  if (!supportPort) throw new Error("Missing owned loopback port");
  async function start(path: string) {
    const child = Bun.spawn(["node", path], { stdout: "pipe", stderr: "pipe" });
    children.push(child);
    const reader = child.stdout.getReader();
    const first = await reader.read();
    reader.releaseLock();
    const port = Number(
      Buffer.from(first.value ?? [])
        .toString()
        .trim(),
    );
    if (!(port > 0)) throw new Error("Owned fixture listener is unconfirmed");
    return { child, base: `http://127.0.0.1:${port}` };
  }
  try {
    await mkdir(join(root, "src"));
    const webSource = await readFile("test/fixtures/runtime-project/src/server.mjs", "utf8");
    await writeFile(
      join(root, "src/server.mjs"),
      webSource
        .replace("http://127.0.0.1:4100/", `http://127.0.0.1:${supportPort}/`)
        .replace(
          'server.listen(4300, "0.0.0.0");',
          'server.listen(0, "127.0.0.1", () => console.log(server.address().port));',
        ),
    );
    await writeFile(join(root, "src/version.txt"), "one\n");
    const web = await start(join(root, "src/server.mjs"));
    const pending = await fetch(`${web.base}/health`);
    expect(pending.status).toBe(503);
    expect(await pending.json()).toEqual({ status: "starting" });
    const supportSource = await readFile("test/fixtures/runtime-project/support.mjs", "utf8");
    await writeFile(
      join(root, "support.mjs"),
      supportSource.replace(
        'server.listen(4100, "127.0.0.1");',
        `server.listen(${supportPort}, "127.0.0.1", () => console.log(server.address().port));`,
      ),
    );
    const support = await start(join(root, "support.mjs"));
    const healthy = await fetch(`${web.base}/health`);
    expect(healthy.status).toBe(200);
    expect(await healthy.json()).toEqual({ status: "ok", support: "support-ready" });
    support.child.kill("SIGTERM");
    await support.child.exited;
    expect((await fetch(`${web.base}/health`)).status).toBe(503);
    expect((await fetch(`${web.base}/source`)).status).toBe(200);
    expect(web.child.exitCode).toBeNull();
  } finally {
    for (const child of children) {
      if (child.exitCode === null) child.kill("SIGTERM");
      await child.exited;
    }
    await rm(root, { recursive: true, force: true });
  }
}, 10_000);
