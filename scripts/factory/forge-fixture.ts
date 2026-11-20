import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { type DisposableInstallation, installationDirectory } from "./installation";
import { localStarterCompose } from "./starter-images";

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
  starterImages: Parameters<typeof localStarterCompose>[1];
  fetch?: (url: string, options: RequestInit) => Promise<Response>;
  command: (
    args: string[],
    options?: { quiet?: boolean; env?: Record<string, string> },
  ) => Promise<string>;
}) {
  const installation = requireForgeFixtureInstallation(options.installation, options.confirmation);
  if (!options.token.trim()) throw new Error("Retained Forgejo fixture token is unavailable");
  const stateDirectory = installationDirectory(options.root, installation.name);
  const forgejoBaseURL = `http://127.0.0.1:${installation.ports.forgejo}`;
  const username = "factory-mutation";
  const authorization = `Bearer ${options.token}`;
  const repositoryAPI = `${forgejoBaseURL}/api/v1/repos/${username}/runtime-fixture`;
  const request = options.fetch ?? fetch;
  const command = options.command;
  const source = resolve(options.root, "test/fixtures/runtime-project");
  const fixtureContent = async (path: string) => {
    const content = await readFile(resolve(source, path), "utf8");
    return path === ".devcontainer/compose.yaml"
      ? localStarterCompose(content, options.starterImages)
      : content;
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
    await ensureFixtureFile(
      ".devcontainer/compose.yaml",
      "Use locally published exact Starter images",
    );
    await ensureFixtureFile(
      ".forgejo/workflows/factory-verification.yml",
      "Update Factory Verification workflow",
    );
    await ensureFixtureFile(".factory/system.json", "Update Factory System Contract");
    await ensureFixtureFile("src/worker.mjs", "Add Factory fixture worker");
  }
  async function ensureLocalFixtureFiles() {
    const destination = resolve(stateDirectory, "runtime-fixture-repository");
    const repository = await stat(resolve(destination, ".git")).catch(() => null);
    if (!repository?.isDirectory()) return;
    const paths = [".factory/system.json", "src/worker.mjs", ".devcontainer/compose.yaml"];
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
    resolve(destination, ".devcontainer/compose.yaml"),
    await fixtureContent(".devcontainer/compose.yaml"),
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
