import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parse } from "yaml";
import { parseSubstrateProjectTemplate } from "#runtime-kubernetes/substrate-project-template";
import imagePins from "../../../../deploy/helm/factory/image-pins.json";
import upstream from "../../../../upstream.json";
import { configurationPath, validateConfiguration } from "./configuration";
import { starterFiles } from "./starter";

const images = {
  platform: "linux/arm64",
  development: `registry.example.test/starter-work@sha256:${"a".repeat(64)}`,
  postgres: `registry.example.test/starter-postgres@sha256:${"b".repeat(64)}`,
};
const selected = { platform: images.platform, images };

test("Starter ignores generated output, but admits its authored native configuration to Git", async () => {
  const files = await starterFiles(selected);
  const ignore = files.find((file) => file.path === ".gitignore");
  if (!ignore) throw new Error("Authored Starter ignore rules are missing");
  const directory = await mkdtemp(join(tmpdir(), "factory-starter-native-"));
  const generated = ".tanstack/generated.json";
  const git = async (...args: string[]) => {
    const child = Bun.spawn(["git", ...args], { cwd: directory, stdout: "pipe", stderr: "pipe" });
    const text = await new Response(child.stdout).text();
    const stderr = await new Response(child.stderr).text();
    if ((await child.exited) !== 0) throw new Error(`Owned Starter Git fixture failed: ${stderr}`);
    return text;
  };
  try {
    await writeFile(join(directory, ".gitignore"), ignore.content);
    await mkdir(join(directory, ".tanstack"));
    await mkdir(join(directory, ".factory"));
    await writeFile(join(directory, generated), "{}\n");
    const template = files.find((file) => file.path === ".factory/actor-template.json");
    if (!template) throw new Error("Native Starter template is missing");
    await writeFile(join(directory, template.path), template.content);
    await git("init", "--initial-branch=main");
    await git("add", "--all");
    expect((await git("ls-files")).split("\n")).not.toContain(generated);
    expect((await git("ls-files")).split("\n")).toContain(template.path);
    await git("add", "--force", generated);
    expect((await git("ls-files")).split("\n")).toContain(generated);
    expect(await readFile(join(directory, generated), "utf8")).toBe("{}\n");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test.each(["linux/arm64", "linux/amd64"])(
  "Starter materializes an admitted direct-container template from the %s catalog",
  async (platform) => {
    const files = await starterFiles({ platform, images: { ...images, platform } });
    const content = (path: string) => {
      const file = files.find((file) => file.path === path);
      if (!file) throw new Error(`Starter file missing: ${path}`);
      return file.content;
    };
    const template = parseSubstrateProjectTemplate(content(".factory/actor-template.json"));
    expect(template.containers).toEqual([
      {
        name: "work",
        image: images.development,
        command: ["/bin/sh", "-ec", "npm ci && npm run db:wait && npm run db:migrate"],
        volumeMounts: [{ name: "source", mountPath: "/workspace" }],
      },
      {
        name: "postgres",
        image: images.postgres,
        command: ["/usr/local/bin/docker-entrypoint.sh", "postgres", "-h", "127.0.0.1"],
        env: [
          { name: "POSTGRES_DB", value: "app" },
          { name: "POSTGRES_USER", value: "app" },
          { name: "PGDATA", value: "/data/pgdata" },
        ],
        volumeMounts: [{ name: "database", mountPath: "/data" }],
      },
    ]);
    expect(template.volumes).toEqual([
      { name: "source", durableDir: {} },
      { name: "database", durableDir: {} },
    ]);
    expect(files.some((file) => /devcontainer|compose\.ya?ml/.test(file.path))).toBe(false);
    expect(() =>
      validateConfiguration(
        files.filter((file) => configurationPath(file.path)),
        files.map((file) => file.path),
      ),
    ).not.toThrow();
    const workflow = parse(content(".forgejo/workflows/factory-verification.yml"));
    expect(workflow.jobs.verify.steps).toEqual([
      {
        name: "Confirm the assigned commit",
        "working-directory": `\${{ env.FACTORY_CHECKOUT_ROOT }}`,
        run: `test "$(git rev-parse HEAD)" = "\${{ forgejo.event.pull_request.head.sha }}"`,
      },
      {
        name: "Check the starter",
        "working-directory": `\${{ env.FACTORY_CHECKOUT_ROOT }}`,
        run: "npm run check",
      },
    ]);
    expect(JSON.parse(content(".factory/system.json")).apps[0].command).toEqual([
      "npm",
      "run",
      "dev",
    ]);
    const workRecipe = content(".factory/images/work/Dockerfile");
    expect(workRecipe).toStartWith(`FROM ${upstream.nodeDevelopment.image}\n`);
    expect(workRecipe).toContain("ca-certificates git");
    expect(workRecipe).toContain('test "$(id -u node)" = 1000');
    expect(workRecipe).toEndWith("USER 1000:1000\n");
    expect(content(".factory/images/postgres/Dockerfile")).toBe(
      `FROM ${imagePins.postgres}\nUSER postgres\n`,
    );
    expect(content("src/db/wait.ts")).toContain("SELECT 1");
    expect(content("src/db/readiness.ts")).toContain("attempt === 29");
    expect(content("src/db/readiness.ts")).not.toContain("migrate(");
  },
);

test("Starter creation fails closed without an explicit catalog or for the wrong native platform", async () => {
  await expect(starterFiles({ platform: "linux/arm64", images: undefined })).rejects.toThrow(
    "Publish",
  );
  await expect(starterFiles({ platform: "linux/amd64", images })).rejects.toThrow(
    "selected native runtime",
  );
});

test("ordinary Starter creation derives its catalog platform from the selected Substrate runtime", async () => {
  const directory = await mkdtemp(join(tmpdir(), "factory-starter-selection-"));
  const previousCatalog = process.env["FACTORY_STARTER_IMAGES"];
  const previousConfiguration = process.env["FACTORY_SUBSTRATE_WORKSPACES_CONFIGURATION"];
  const configuration = join(directory, "native.json");
  try {
    delete process.env["FACTORY_STARTER_IMAGES"];
    delete process.env["FACTORY_SUBSTRATE_WORKSPACES_CONFIGURATION"];
    await expect(starterFiles()).rejects.toThrow("Starter creation requires");
    process.env["FACTORY_SUBSTRATE_WORKSPACES_CONFIGURATION"] = configuration;
    for (const architecture of ["arm64", "amd64"]) {
      await writeFile(
        configuration,
        JSON.stringify({
          runtime: { version: { attributes: [{ key: "architecture", value: architecture }] } },
        }),
      );
      process.env["FACTORY_STARTER_IMAGES"] = JSON.stringify({
        ...images,
        platform: `linux/${architecture}`,
      });
      expect(
        (await starterFiles()).find((file) => file.path === ".factory/actor-template.json"),
      ).toBeDefined();
    }
    process.env["FACTORY_STARTER_IMAGES"] = JSON.stringify(images);
    await expect(starterFiles()).rejects.toThrow("selected native runtime");
  } finally {
    if (previousCatalog === undefined) delete process.env["FACTORY_STARTER_IMAGES"];
    else process.env["FACTORY_STARTER_IMAGES"] = previousCatalog;
    if (previousConfiguration === undefined)
      delete process.env["FACTORY_SUBSTRATE_WORKSPACES_CONFIGURATION"];
    else process.env["FACTORY_SUBSTRATE_WORKSPACES_CONFIGURATION"] = previousConfiguration;
    await rm(directory, { recursive: true, force: true });
  }
});

test("the Starter's actual SQL-readiness policy passes its fast isolated Node tests", async () => {
  const child = Bun.spawn(["node", "--test", "test/readiness.test.ts"], {
    cwd: resolve(import.meta.dir, "../../../../templates/starter-app"),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exit, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  expect({ exit, stderr }).toEqual({ exit: 0, stderr: "" });
  expect(stdout).toContain("tests 4");
  expect(stdout).toContain("fail 0");
});

test("the native Starter retains the selected toolchain, application, auth and test sources", async () => {
  const files = await starterFiles(selected);
  const content = (path: string) => {
    const file = files.find((file) => file.path === path);
    if (!file) throw new Error(`Starter file missing: ${path}`);
    return file.content;
  };
  const manifest = JSON.parse(content("package.json"));
  const factory = await Bun.file(new URL("../../../../package.json", import.meta.url)).json();
  expect(manifest.engines.node).toBe(upstream.nodeDevelopment.version);
  expect(manifest.scripts["db:wait"]).toBe("node src/db/wait.ts");
  for (const name of ["solid-js", "@solidjs/web"]) {
    expect(manifest.dependencies[name]).toBe(factory.dependencies[name]);
    expect(manifest.dependencies[name]).toMatch(/^2\.\d+\.\d+$/);
  }
  expect(manifest.devDependencies["@solidjs/vite-plugin"]).toBe(
    factory.devDependencies["@solidjs/vite-plugin"],
  );
  expect(manifest.devDependencies["@solidjs/vite-plugin"]).toMatch(/^3\.\d+\.\d+$/);
  for (const name of ["@tanstack/solid-router", "@tanstack/solid-start"])
    expect(manifest.dependencies[name]).toBe(factory.dependencies[name]);
  for (const name of ["@solidjs/compiler", "@solidjs/signals"]) {
    expect(manifest.overrides[name]).toBe(factory.overrides[name]);
    expect(manifest.overrides[name]).toMatch(/^2\.\d+\.\d+$/);
  }
  const lock = JSON.parse(content("package-lock.json"));
  expect(lock.packages[""].dependencies).toEqual(manifest.dependencies);
  expect(lock.packages[""].devDependencies).toEqual(manifest.devDependencies);
  expect(content("src/auth.ts")).toContain("betterAuth(");
  expect(content("test/auth.test.ts")).toContain("production HTTP routing");
  expect(
    files.some((file) => /(^|\/)(node_modules|dist|\.output|\.tanstack)\//.test(file.path)),
  ).toBe(false);
  expect(files.some((file) => /(^|\/)\.env/.test(file.path))).toBe(false);
});
