import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { parseSubstrateProjectTemplate } from "#runtime-kubernetes/substrate-project-template";
import { type DisposableInstallation, installationDirectory } from "./installation";
import { nativeStarterImages } from "./starter-images";

export function requireForgeFixtureInstallation(
  installation: DisposableInstallation | null,
  confirmation: string | undefined,
) {
  if (
    !installation?.disposable ||
    installation.phase !== "active" ||
    confirmation !== installation.name
  )
    throw new Error(
      "Forgejo fixture preparation requires an active disposable installation and matching --confirm",
    );
  return installation;
}

// Explicit test setup only. The launcher verifies Compose ownership before calling this.
// Existing branch protection is never removed, even when it refuses a fixture update.
export async function prepareForgejoFixture(options: {
  root: string;
  installation: DisposableInstallation | null;
  confirmation: string | undefined;
  token: string;
  platform: string;
  starterImages: unknown;
  fetch?: (url: string, options: RequestInit) => Promise<Response>;
  command: (
    args: string[],
    options?: { quiet?: boolean; env?: Record<string, string> },
  ) => Promise<string>;
}) {
  const installation = requireForgeFixtureInstallation(options.installation, options.confirmation);
  if (!options.token.trim()) throw new Error("Retained Forgejo fixture token is unavailable");
  const images = nativeStarterImages(options.platform, options.starterImages);
  const stateDirectory = installationDirectory(options.root, installation.name);
  const forgejoBaseURL = `http://127.0.0.1:${installation.ports.forgejo}`;
  const username = "factory-mutation";
  const authorization = `Bearer ${options.token}`;
  const repositoryAPI = `${forgejoBaseURL}/api/v1/repos/${username}/runtime-fixture`;
  const request = options.fetch ?? fetch;
  const command = options.command;
  const source = resolve(options.root, "test/fixtures/runtime-project");
  const legacy = await readdir(resolve(source, ".devcontainer")).catch(
    (cause: NodeJS.ErrnoException) => {
      if (cause.code === "ENOENT") return [];
      throw cause;
    },
  );
  if (legacy.length)
    throw new Error("Runtime fixture source must use native ActorTemplates, not Dev Containers");
  // The fixture is authored natively; only its explicit catalog image selections
  // are materialized. No legacy recipe, service DNS or mount is translated here.
  const contents = new Map<string, string>();
  const messages = [
    [".factory/actor-template.json", "Use published native Starter images"],
    [".forgejo/workflows/factory-verification.yml", "Update Factory Verification workflow"],
    [".factory/system.json", "Update Factory System Contract"],
    ["src/worker.mjs", "Add Factory fixture worker"],
  ] as const;
  for (const [path] of messages) {
    let content = await readFile(resolve(source, path), "utf8");
    if (path === ".factory/actor-template.json") {
      const template = parseSubstrateProjectTemplate(content);
      for (const container of template.containers) {
        if (container.name === "work") container.image = images.development;
        if (container.name === "postgres") container.image = images.postgres;
      }
      content = `${JSON.stringify(template, null, 2)}\n`;
    }
    contents.set(path, content);
  }
  const fixtureContent = async (path: string) => {
    const content = contents.get(path);
    if (content === undefined) throw new Error(`Unknown native fixture file: ${path}`);
    return content;
  };
  async function ensureFixtureFile(path: string, message: string) {
    const expected = await fixtureContent(path);
    const endpoint = `${repositoryAPI}/contents/${path}`;
    let missing = false;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const existing = await request(`${endpoint}?ref=main`, { headers: { authorization } });
      if (existing.status === 404) {
        missing = true;
        break;
      }
      if (!existing.ok) throw new Error(`Forgejo fixture lookup failed with ${existing.status}`);
      const value = (await existing.json()) as { content?: string; sha?: string };
      if (!value.content || !value.sha) {
        await Bun.sleep(250);
        continue;
      }
      if (Buffer.from(value.content, "base64").toString() === expected) return;
      const updated = await request(endpoint, {
        method: "PUT",
        headers: { authorization, "content-type": "application/json" },
        body: JSON.stringify({
          branch: "main",
          message,
          content: Buffer.from(expected).toString("base64"),
          sha: value.sha,
        }),
      });
      if (!updated.ok) throw new Error(`Forgejo fixture update failed with ${updated.status}`);
      return;
    }
    if (!missing) throw new Error("Forgejo fixture content did not settle after repository push");
    const created = await request(endpoint, {
      method: "POST",
      headers: { authorization, "content-type": "application/json" },
      body: JSON.stringify({
        branch: "main",
        message,
        content: Buffer.from(expected).toString("base64"),
      }),
    });
    if (!created.ok) throw new Error(`Forgejo fixture creation failed with ${created.status}`);
  }
  async function ensureFixtureFiles() {
    for (const [path, message] of messages) await ensureFixtureFile(path, message);
  }
  async function ensureLocalFixtureFiles() {
    const destination = resolve(stateDirectory, "runtime-fixture-repository");
    const repository = await stat(resolve(destination, ".git")).catch(() => null);
    if (!repository?.isDirectory()) return;
    const paths = messages.map(([path]) => path);
    for (const path of paths) {
      const content = await fixtureContent(path);
      const target = resolve(destination, path);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, content);
    }
    const changed = await command(
      ["git", "-C", destination, "status", "--porcelain", "--", ...paths],
      { quiet: true },
    );
    if (!changed) return;
    await command(["git", "-C", destination, "add", "--", ...paths]);
    await command([
      "git",
      "-C",
      destination,
      "-c",
      "user.name=Factory",
      "-c",
      "user.email=factory@example.invalid",
      "commit",
      "-m",
      "Update Factory runtime fixture",
      "--",
      ...paths,
    ]);
  }
  const existing = await request(repositoryAPI, { headers: { authorization } });
  if (existing.status === 404) {
    const created = await request(`${forgejoBaseURL}/api/v1/user/repos`, {
      method: "POST",
      headers: { authorization, "content-type": "application/json" },
      body: JSON.stringify({
        name: "runtime-fixture",
        private: false,
        auto_init: false,
        default_branch: "main",
      }),
    });
    if (!created.ok && created.status !== 409)
      throw new Error(`Forgejo repository bootstrap failed with ${created.status}`);
  } else if (!existing.ok) {
    throw new Error(`Forgejo repository lookup failed with ${existing.status}`);
  }
  const main = await request(`${repositoryAPI}/branches/main`, { headers: { authorization } });
  if (main.ok) {
    const legacy = await request(`${repositoryAPI}/contents/.devcontainer?ref=main`, {
      headers: { authorization },
    });
    if (legacy.ok)
      throw new Error(
        "Recreate the owned disposable fixture repository with native source; existing Dev Containers are not migrated",
      );
    if (legacy.status !== 404)
      throw new Error(`Forgejo legacy fixture lookup failed with ${legacy.status}`);
    await ensureFixtureFiles();
    await ensureLocalFixtureFiles();
    return;
  }
  if (main.status !== 404) throw new Error(`Forgejo main branch lookup failed with ${main.status}`);
  const destination = resolve(stateDirectory, "runtime-fixture-repository");
  await rm(destination, { recursive: true, force: true });
  await mkdir(destination, { recursive: true });
  await command(["cp", "-R", `${source}/.`, destination]);
  await writeFile(
    resolve(destination, ".factory/actor-template.json"),
    await fixtureContent(".factory/actor-template.json"),
  );
  await command(["git", "init", "--initial-branch=main", destination]);
  await command(["git", "-C", destination, "add", "."]);
  await command([
    "git",
    "-C",
    destination,
    "-c",
    "user.name=Factory",
    "-c",
    "user.email=factory@example.invalid",
    "commit",
    "-m",
    "runtime fixture",
  ]);
  await command([
    "git",
    "-C",
    destination,
    "remote",
    "add",
    "origin",
    `${forgejoBaseURL}/${username}/runtime-fixture.git`,
  ]);
  await command(["git", "-C", destination, "push", "origin", "HEAD:main"], {
    env: {
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "http.extraHeader",
      GIT_CONFIG_VALUE_0: `Authorization: Basic ${Buffer.from(`${username}:${options.token}`).toString("base64")}`,
    },
  });
  await ensureFixtureFiles();
}
