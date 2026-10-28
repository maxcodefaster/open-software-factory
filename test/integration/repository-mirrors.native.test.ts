import { expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parseAllDocuments } from "yaml";
import { createForgejoClient } from "../../packages/forge/src/forge";
import { eventually } from "../fixtures/factory-process";
import { ownedMonitoringForge } from "../fixtures/monitoring-native";

test("pinned Forgejo natively mirrors unmerged branches and tags, survives source loss and removes only the mirror", async () => {
  const id = crypto.randomUUID(),
    targetID = crypto.randomUUID();
  const directory = resolve(".factory/test-results/repository-mirrors", id);
  const targetDirectory = resolve(directory, "target");
  const network = `factory-mirror-${id}`;
  await mkdir(targetDirectory, { recursive: true, mode: 0o700 });
  async function stage(value: string) {
    console.info(`Owned mirror proof: ${value}`);
    await writeFile(resolve(directory, "stage.txt"), value);
  }
  async function docker(args: string[]) {
    const child = Bun.spawn(["docker", ...args], { stdout: "pipe", stderr: "ignore" });
    const output = await new Response(child.stdout).text();
    if (await child.exited) throw new Error(`Owned mirror Docker ${args[0]} failed`);
    return output.trim();
  }
  await docker(["network", "create", "--label", `factory.mirror-proof=${id}`, network]);
  let source: Awaited<ReturnType<typeof ownedMonitoringForge>> | undefined;
  let target: Awaited<ReturnType<typeof ownedMonitoringForge>> | undefined;
  let targetHost = "";
  async function configureDestination(blocked: string) {
    if (!source || !target) throw new Error("Owned mirror fixtures are not ready");
    // Rewrite the section rather than appending duplicate INI keys. The native
    // entrypoint normalizes the file again before each restart.
    const config = await docker(["exec", source.container, "sh", "-c", 'cat "$GITEA_APP_INI"']);
    let skip = false;
    const retained = config
      .split("\n")
      .filter((line) => {
        if (/^\s*\[/.test(line)) skip = /^\s*\[migrations\]\s*$/i.test(line);
        return !skip;
      })
      .join("\n");
    const child = Bun.spawn(
      ["docker", "exec", "--interactive", source.container, "sh", "-c", 'cat > "$GITEA_APP_INI"'],
      {
        stdin: new Blob([
          `${retained}\n[migrations]\nALLOW_LOCALNETWORKS = false\nALLOW_UNENCRYPTED = true\nALLOWED_DOMAINS = ${targetHost}\nBLOCKED_DOMAINS = ${blocked}\n`,
        ]),
        stdout: "ignore",
        stderr: "ignore",
      },
    );
    if (await child.exited) throw new Error("Owned mirror configuration write failed");
    await source.reload();
  }
  try {
    await stage("starting source");
    source = await ownedMonitoringForge(directory, id, network);
    await stage("starting target");
    target = await ownedMonitoringForge(targetDirectory, targetID, network);
    // Fixture container names exceed a DNS label's 63-character limit. Use the
    // owned network's actual address, not an unresolvable long hostname.
    targetHost = await docker([
      "inspect",
      "--format",
      `{{(index .NetworkSettings.Networks "${network}").IPAddress}}`,
      target.container,
    ]);
    expect(targetHost).toMatch(/^\d+\.\d+\.\d+\.\d+$/);
    const render = Bun.spawn(
      [
        "helm",
        "template",
        "mirrors",
        "deploy/helm/factory",
        "--values",
        "deploy/helm/factory/values.local.yaml",
        "--set-string",
        "image=unused-mirror-proof:local",
        "--set-string",
        `factorybox.image=registry.invalid/worker@sha256:${"a".repeat(64)}`,
        "--set-string",
        `factorybox.executableSHA256=${"b".repeat(64)}`,
        "--set",
        "factorybox.architecture=amd64",
        "--set",
        "factorybox.nodeName=unused-owned-node",
        "--set",
        "factorybox.kernel=unused-owned-kernel",
      ],
      { stdout: "pipe", stderr: "ignore" },
    );
    const rendered = await new Response(render.stdout).text();
    expect(await render.exited).toBe(0);
    const forge = parseAllDocuments(rendered)
      .map((document) => document.toJSON())
      .find((item) => item.kind === "StatefulSet" && item.metadata.name === "mirrors-forgejo");
    const blocked = forge.spec.template.spec.containers[0].env.find(
      (item: { name: string }) => item.name === "FORGEJO__migrations__BLOCKED_DOMAINS",
    )?.value;
    expect(typeof blocked).toBe("string");
    // Test-only HTTP transport. First retain the chart's private-network block,
    // then allow only this owned destination for the transfer proof.
    await stage("checking chart private-network guard");
    await configureDestination(blocked);
    await source.api("user/repos", "POST", { name: "source", private: true, auto_init: true });
    await target.api("user/repos", "POST", { name: "copy", private: true, auto_init: false });
    const repo = { owner: source.owner, name: "source" };
    const copy = { owner: target.owner, name: "copy" };
    const sourceToken = source.token,
      targetToken = target.token;
    const client = createForgejoClient({
      apiURL: `${source.origin}/api/v1/`,
      token: source.token,
      fetch: async (url, init) => {
        const response = await fetch(url, init);
        if (!response.ok) {
          const text = (await response.clone().text())
            .replaceAll(sourceToken, "[redacted]")
            .replaceAll(targetToken, "[redacted]")
            .replace(/https?:\/\/[^\s"]+/g, "[owned URL]");
          console.info(`Owned native response ${response.status}: ${text.slice(0, 500)}`);
        }
        return response;
      },
    });
    const destination = createForgejoClient({
      apiURL: `${target.origin}/api/v1/`,
      token: target.token,
    });
    const base = await client.getDefaultBranch(repo);
    const mirrorInput = {
      targetURL: `http://${targetHost}:3000/${copy.owner}/${copy.name}.git`,
      username: target.owner,
      token: target.token,
    };
    await expect(client.pushMirrors.create(repo, mirrorInput)).rejects.toThrow("refused");
    expect(await client.pushMirrors.list(repo)).toEqual([]);
    await configureDestination("");
    await stage("creating native mirror");
    const created = await client.pushMirrors.create(repo, mirrorInput);
    expect(created.syncOnCommit).toBe(true);
    expect(created.branchFilter).toBe("");
    expect(created.lastAttempt).toBeNull();
    expect(JSON.stringify(created)).not.toContain(target.token);
    await stage("checking native credential storage without exposing the token");
    const configPaths = (
      await docker([
        "exec",
        source.container,
        "find",
        "/var/lib/gitea",
        "-type",
        "f",
        "-path",
        `*/${repo.owner}/${repo.name}.git/config`,
      ])
    )
      .split("\n")
      .filter(Boolean);
    expect(configPaths.length).toBe(1);
    const configPath = configPaths[0];
    if (!configPath) throw new Error("Owned source repository configuration is missing");
    const gitConfig = await docker(["exec", source.container, "cat", configPath]);
    // Assert booleans only. A failed assertion must not print the token or config.
    expect(gitConfig.includes(created.remoteName)).toBe(true);
    expect(gitConfig.includes(target.token)).toBe(true);
    await stage("first native synchronization");
    await client.pushMirrors.sync(repo);
    // Mirroring copies refs, not the target service's default-branch setting.
    // Native receive hooks may also finish updating its API after Git returns.
    await eventually(
      () => destination.getBranch(copy, base.name),
      (value) => value?.headSha === base.headSha,
      "The source branch was not copied",
      30_000,
    );
    const branch = "factory/change-unmerged-proof";
    await stage("checking sync-on-commit");
    await client.ensureBranch(repo, branch, base.headSha);
    const file = (await source.api(
      `repos/${repo.owner}/${repo.name}/contents/feature.txt`,
      "POST",
      {
        branch,
        message: "Owned unmerged code",
        content: Buffer.from("Retained unmerged implementation\n").toString("base64"),
      },
    )) as { commit: { sha: string } };
    await eventually(
      () => destination.getBranch(copy, branch),
      (value) => value?.headSha === file.commit.sha,
      "Native sync-on-commit did not copy the unmerged branch",
      60_000,
    );
    await source.api(`repos/${repo.owner}/${repo.name}/tags`, "POST", {
      tag_name: "owned-proof-v1",
      target: file.commit.sha,
    });
    await stage("checking tags");
    await client.pushMirrors.sync(repo);
    const tags = (await target.api(`repos/${copy.owner}/${copy.name}/tags`)) as { name: string }[];
    expect(tags.some((tag) => tag.name === "owned-proof-v1")).toBe(true);
    const status = (await client.pushMirrors.list(repo))[0];
    expect(status?.failed).toBe(false);
    expect(status?.lastAttempt).not.toBeNull();
    await client.pushMirrors.remove(repo, created.remoteName);
    await client.pushMirrors.remove(repo, created.remoteName);
    expect(await client.pushMirrors.list(repo)).toEqual([]);
    expect((await destination.getBranch(copy, branch))?.headSha).toBe(file.commit.sha);
    await stage("removing source before recovery");
    await source.dispose();
    source = undefined;
    await stage("independent clone and fsck");
    const clone = Bun.spawn(
      [
        "git",
        "clone",
        "--mirror",
        `${target.origin}/${copy.owner}/${copy.name}.git`,
        resolve(directory, "restored.git"),
      ],
      {
        env: {
          ...process.env,
          GIT_TERMINAL_PROMPT: "0",
          GIT_CONFIG_COUNT: "1",
          GIT_CONFIG_KEY_0: "http.extraHeader",
          GIT_CONFIG_VALUE_0: `Authorization: Basic ${Buffer.from(`${target.owner}:${target.token}`).toString("base64")}`,
        },
        stdout: "ignore",
        stderr: "ignore",
      },
    );
    expect(await clone.exited).toBe(0);
    async function recovered(args: string[]) {
      const child = Bun.spawn(["git", "-C", resolve(directory, "restored.git"), ...args], {
        stdout: "pipe",
        stderr: "ignore",
      });
      const value = await new Response(child.stdout).text();
      expect(await child.exited).toBe(0);
      return value.trim();
    }
    expect(await recovered(["rev-parse", `refs/heads/${branch}`])).toBe(file.commit.sha);
    expect(await recovered(["rev-parse", "refs/tags/owned-proof-v1^{}"])).toBe(file.commit.sha);
    expect(await recovered(["show", `refs/heads/${branch}:feature.txt`])).toBe(
      "Retained unmerged implementation",
    );
    const fsck = Bun.spawn(["git", "-C", resolve(directory, "restored.git"), "fsck", "--full"], {
      stdout: "ignore",
      stderr: "ignore",
    });
    expect(await fsck.exited).toBe(0);
    await writeFile(
      resolve(directory, "result.json"),
      JSON.stringify(
        {
          passed: true,
          sourceVersion: "17.0.0",
          nativePushMirror: true,
          mirrorCredentialStorage: "plaintext-repository-git-config",
          chartPrivateNetworkGuardProved: true,
          syncOnCommitProved: true,
          unmergedBranch: branch,
          commit: file.commit.sha,
          tag: "owned-proof-v1",
          sourceRemovedBeforeClone: true,
          mirrorRemovalPreservesTarget: true,
          standaloneCloneAndFsck: true,
        },
        null,
        2,
      ),
    );
  } catch (cause) {
    for (const [name, fixture] of [
      ["source", source],
      ["target", target],
    ] as const) {
      if (!fixture) continue;
      const child = Bun.spawn(["docker", "logs", "--tail", "100", fixture.container], {
        stdout: "pipe",
        stderr: "pipe",
      });
      const logs = (
        await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()])
      ).join("\n");
      await child.exited;
      const redacted = [source?.token, target?.token]
        .filter((value) => value !== undefined)
        .reduce((text, token) => text.replaceAll(token, "[redacted]"), logs)
        .replace(/https?:\/\/[^\s"]+/g, "[owned URL]");
      await writeFile(resolve(directory, `${name}.log`), redacted, { mode: 0o600 });
    }
    throw cause;
  } finally {
    await stage("cleaning owned resources");
    await source?.dispose();
    await target?.dispose();
    expect(
      await docker([
        "network",
        "inspect",
        "--format",
        '{{index .Labels "factory.mirror-proof"}}',
        network,
      ]),
    ).toBe(id);
    await docker(["network", "rm", network]);
  }
}, 600_000);
