import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { z } from "zod";
import { createForgejoClient } from "../../packages/forge/src/forge";
import { ownedMonitoringForge } from "./monitoring-native";

// Kubelet cannot clone a file:// path on this Mac. Publish only the fixture's
// tracked files into a separate owned Forge, never the retained installation.
export async function ownedRuntimeRepository(
  artifacts: string,
  owner: string,
  directory = resolve(".factory/runtime-fixture-repository"),
) {
  const shared = process.env["FACTORY_TEST_POSTGRES"]
    ? z.object({ owner: z.uuid() }).parse(JSON.parse(process.env["FACTORY_TEST_POSTGRES"]))
    : null;
  const host = await ownedMonitoringForge(
    artifacts,
    owner,
    shared ? `factory-test-postgres-${shared.owner}` : undefined,
  );
  const repository = { owner: host.owner, name: `runtime-${owner.slice(0, 12)}` };
  const forge = createForgejoClient({ apiURL: `${host.origin}/api/v1/`, token: host.token });
  try {
    const tracked = Bun.spawn(["git", "ls-files"], {
      cwd: directory,
      stdout: "pipe",
      stderr: "ignore",
    });
    const paths = (await new Response(tracked.stdout).text()).trim().split("\n");
    if ((await tracked.exited) !== 0 || !paths.includes(".devcontainer/devcontainer.json"))
      throw new Error("Owned runtime fixture repository is incomplete");
    await forge.createSetupRepository({ repository, setupID: owner });
    await forge.createSetupFiles({
      repository,
      setupID: owner,
      branch: "main",
      files: await Promise.all(
        paths.map(async (path) => ({
          path,
          content: await readFile(resolve(directory, path), "utf8"),
        })),
      ),
    });
    return {
      ...host,
      repository,
      commit: (await forge.getDefaultBranch(repository)).headSha,
      repositoryURL: `${host.origin}/${repository.owner}/${repository.name}.git`,
    };
  } catch (cause) {
    await host.dispose();
    throw cause;
  }
}
