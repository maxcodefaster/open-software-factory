import { expect, test } from "bun:test";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import upstream from "../../upstream.json";
import { prepareForgejoFixture, requireForgeFixtureInstallation } from "./forge-fixture";
import { type DisposableInstallation, installationDirectory } from "./installation";
import { nativeStarterImages } from "./starter-images";

const contents = {
  ".devcontainer/compose.yaml": `services:\n  app:\n    image: ${upstream.nodeDevelopment.image}\n`,
  ".forgejo/workflows/factory-verification.yml": "name: Factory Verification\n",
  ".factory/system.json": '{"schema":1}\n',
  "src/worker.mjs": "console.log('fixture worker');\n",
};
const installation: DisposableInstallation = {
  version: 2,
  disposable: true,
  name: "forge-fixture-test",
  owner: "3f0ceca8-880a-4ed7-97b5-6e76be5a1f98",
  phase: "active",
  ports: { factory: 41201, postgres: 41202, forgejo: 41203, zero: 41204 },
  runtimeImage: `registry.invalid/host@sha256:${"a".repeat(64)}`,
  browserImage: `registry.invalid/browser@sha256:${"b".repeat(64)}`,
};

class Forge {
  repositoryExists = true;
  mainExists = true;
  files: Record<string, string> = { ...contents };
  updateStatus = 200;
  repositoryStatus = 200;
  calls: { path: string; method: string; body: Record<string, unknown> | undefined }[] = [];
  fetch = async (input: string, options: RequestInit) => {
    const url = new URL(input);
    expect(url.origin).toBe(`http://127.0.0.1:${installation.ports.forgejo}`);
    expect(new Headers(options.headers).get("authorization")).toBe("Bearer fixture-token");
    const path = url.pathname;
    const method = options.method ?? "GET";
    const body = options.body ? JSON.parse(String(options.body)) : undefined;
    this.calls.push({ path, method, body });
    const repository = "/api/v1/repos/factory-mutation/runtime-fixture";
    if (path === "/api/v1/user/repos" && method === "POST") {
      this.repositoryExists = true;
      return Response.json({});
    }
    if (path === repository)
      return new Response(null, {
        status: this.repositoryExists ? this.repositoryStatus : 404,
      });
    if (path === `${repository}/branches/main`)
      return new Response(null, { status: this.mainExists ? 200 : 404 });
    if (path.startsWith(`${repository}/contents/`)) {
      const file = path.slice(`${repository}/contents/`.length);
      if (method === "GET") {
        expect(url.searchParams.get("ref")).toBe("main");
        const content = this.files[file];
        return content === undefined
          ? new Response(null, { status: 404 })
          : Response.json({ content: Buffer.from(content).toString("base64"), sha: "old-blob" });
      }
      if (method === "PUT" && this.updateStatus !== 200)
        return new Response(null, { status: this.updateStatus });
      if (method === "PUT" || method === "POST") {
        this.files[file] = Buffer.from(body.content, "base64").toString();
        return Response.json({});
      }
    }
    throw new Error(`Unexpected fixture endpoint: ${method} ${path}`);
  };
}

async function fixture(
  run: (
    input: Parameters<typeof prepareForgejoFixture>[0],
    forge: Forge,
    commands: string[][],
  ) => Promise<void>,
) {
  const root = await mkdtemp(resolve(tmpdir(), "factory-forge-fixture-"));
  try {
    for (const [path, content] of Object.entries(contents)) {
      const target = resolve(root, "test/fixtures/runtime-project", path);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, content);
    }
    const forge = new Forge();
    const commands: string[][] = [];
    await run(
      {
        root,
        installation,
        confirmation: installation.name,
        token: "fixture-token",
        starterImages: nativeStarterImages(),
        fetch: forge.fetch,
        command: async (args) => {
          commands.push(args);
          if (args[0] === "cp") await cp(args[2] ?? "", args[3] ?? "", { recursive: true });
          return "";
        },
      },
      forge,
      commands,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("fixture preparation requires a confirmed active disposable installation before any effects", async () => {
  await fixture(async (input, forge, commands) => {
    for (const value of [
      { installation: null, confirmation: installation.name },
      { installation, confirmation: undefined },
      { installation, confirmation: "different-installation" },
      {
        installation: { ...installation, phase: "reset" as const },
        confirmation: installation.name,
      },
      {
        installation: { ...installation, phase: "reset-intent" as const },
        confirmation: installation.name,
      },
    ])
      await expect(prepareForgejoFixture({ ...input, ...value })).rejects.toThrow(
        "active disposable installation",
      );
    expect(forge.calls).toEqual([]);
    expect(commands).toEqual([]);
    expect(requireForgeFixtureInstallation(installation, installation.name)).toBe(installation);
  });
});

test("fixture preparation refuses a missing retained token without effects", async () => {
  await fixture(async (input, forge, commands) => {
    await expect(prepareForgejoFixture({ ...input, token: " " })).rejects.toThrow(
      "Retained Forgejo fixture token",
    );
    expect(forge.calls).toEqual([]);
    expect(commands).toEqual([]);
  });
});

test("matching fixture files cause no Forgejo writes or local Git commands", async () => {
  await fixture(async (input, forge, commands) => {
    await prepareForgejoFixture(input);
    expect(forge.calls).toHaveLength(6);
    expect(forge.calls.every((call) => call.method === "GET")).toBe(true);
    expect(commands).toEqual([]);
  });
});

test("explicit fixture repair updates only the selected file at its observed blob", async () => {
  await fixture(async (input, forge) => {
    forge.files[".factory/system.json"] = "old contract";
    await prepareForgejoFixture(input);
    const writes = forge.calls.filter((call) => call.method !== "GET");
    expect(writes).toHaveLength(1);
    expect(writes[0]).toEqual({
      path: "/api/v1/repos/factory-mutation/runtime-fixture/contents/.factory/system.json",
      method: "PUT",
      body: {
        branch: "main",
        message: "Update Factory System Contract",
        content: Buffer.from(contents[".factory/system.json"]).toString("base64"),
        sha: "old-blob",
      },
    });
    expect(forge.files).toEqual(contents);
  });
});

test.each([403, 409, 500])(
  "fixture update HTTP %s preserves branch protection and local files without retry",
  async (status) => {
    await fixture(async (input, forge, commands) => {
      const destination = resolve(
        installationDirectory(input.root, installation.name),
        "runtime-fixture-repository",
      );
      await mkdir(resolve(destination, ".git"), { recursive: true });
      const retained = resolve(destination, "retained-user-file");
      await writeFile(retained, "retained");
      forge.files[".devcontainer/compose.yaml"] = "protected old compose";
      forge.updateStatus = status;
      await expect(prepareForgejoFixture(input)).rejects.toThrow(`update failed with ${status}`);
      expect(forge.calls.filter((call) => call.method !== "GET")).toHaveLength(1);
      expect(forge.calls.some((call) => call.path.includes("branch_protections"))).toBe(false);
      expect(forge.calls.some((call) => call.method === "DELETE")).toBe(false);
      expect(commands).toEqual([]);
      expect(await readFile(retained, "utf8")).toBe("retained");
      expect(forge.files[".devcontainer/compose.yaml"]).toBe("protected old compose");
    });
  },
);

test("explicit fixture preparation creates a missing file on main without changing protection", async () => {
  await fixture(async (input, forge) => {
    delete forge.files["src/worker.mjs"];
    await prepareForgejoFixture(input);
    const writes = forge.calls.filter((call) => call.method !== "GET");
    expect(writes).toHaveLength(1);
    expect(writes[0]?.method).toBe("POST");
    expect(writes[0]?.path).toEndWith("/contents/src/worker.mjs");
    expect(writes[0]?.body?.["branch"]).toBe("main");
    expect(forge.files).toEqual(contents);
  });
});

test("initial fixture seeding uses only the confirmed disposable path and loopback Forge", async () => {
  await fixture(async (input, forge, commands) => {
    forge.repositoryExists = false;
    forge.mainExists = false;
    await prepareForgejoFixture(input);
    const destination = resolve(
      installationDirectory(input.root, installation.name),
      "runtime-fixture-repository",
    );
    expect(await readFile(resolve(destination, ".devcontainer/compose.yaml"), "utf8")).toBe(
      contents[".devcontainer/compose.yaml"],
    );
    expect(forge.calls.find((call) => call.method === "POST")).toEqual({
      path: "/api/v1/user/repos",
      method: "POST",
      body: {
        name: "runtime-fixture",
        private: false,
        auto_init: false,
        default_branch: "main",
      },
    });
    expect(commands.at(-1)).toEqual(["git", "-C", destination, "push", "origin", "HEAD:main"]);
    expect(commands.some((args) => args.some((arg) => arg.startsWith("--force")))).toBe(false);
  });
});

test("a failed repository lookup refuses fixture mutation", async () => {
  await fixture(async (input, forge, commands) => {
    forge.repositoryStatus = 403;
    await expect(prepareForgejoFixture(input)).rejects.toThrow("repository lookup failed with 403");
    expect(forge.calls).toHaveLength(1);
    expect(commands).toEqual([]);
  });
});

test("ordinary launcher startup has no fixture repair and the explicit route checks ownership", async () => {
  const source = await readFile(resolve(import.meta.dir, "index.ts"), "utf8");
  const forge = source.slice(
    source.indexOf("async function ensureForgejo()"),
    source.indexOf("async function prepareFixture()"),
  );
  expect(forge).toContain("return token");
  expect(forge).not.toContain("runtime-fixture");
  expect(forge).not.toContain("ensureFixture");
  const up = source.slice(
    source.indexOf("async function up()"),
    source.indexOf("async function startDataServices()"),
  );
  expect(up).toContain("await ensureForgejo()");
  expect(up).not.toContain("prepareFixture");
  expect(source).not.toContain("branch_protections");
  const explicit = source.slice(
    source.indexOf("async function prepareFixture()"),
    source.indexOf("async function ensureForgeAdministrator()"),
  );
  expect(explicit.indexOf("requireForgeFixtureInstallation")).toBeLessThan(
    explicit.indexOf("validateComposeOwnership"),
  );
  expect(explicit.indexOf("validateComposeOwnership")).toBeLessThan(
    explicit.indexOf("prepareForgejoFixture"),
  );
  expect(source).toContain('else if (action === "prepare-fixture") await prepareFixture()');
});
