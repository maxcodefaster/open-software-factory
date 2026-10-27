import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmod, mkdir, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createForgejoClient } from "../../packages/forge/src/forge";
import { ownedMonitoringForge } from "../fixtures/monitoring-native";
import { eventually } from "../fixtures/factory-process";
import { fixtureValue } from "../fixtures/value";

test("pinned Forgejo 17 exposes exact failed-step diagnostics and bounded native log reads", async () => {
  const id = crypto.randomUUID();
  const directory = resolve(".factory/test-results/verification-diagnostics", id);
  const network = `factory-diagnostics-${id}`;
  const runner = `${network}-runner`;
  let forge: Awaited<ReturnType<typeof ownedMonitoringForge>> | undefined;
  let runnerCreated = false;
  async function command(args: string[]) {
    const child = Bun.spawn(["docker", ...args], { stdout: "pipe", stderr: "ignore" });
    const output = await new Response(child.stdout).text();
    if (await child.exited)
      throw new Error(`Owned diagnosis Docker ${args[0]} failed; sensitive output suppressed`);
    return output.trim();
  }
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await command(["network", "create", "--label", `factory.diagnostics=${id}`, network]);
  try {
    forge = await ownedMonitoringForge(directory, id, network);
    const version = (await forge.api("version")) as { version: string };
    expect(version.version).toBe("17.0.0+gitea-1.22.0");
    await forge.api("user/repos", "POST", { name: "source", private: true, auto_init: true });
    const repository = { owner: forge.owner, name: "source" };
    const apiPath = `repos/${repository.owner}/${repository.name}`;
    const client = createForgejoClient({ apiURL: `${forge.origin}/api/v1/`, token: forge.token });
    const label = `diagnostics-${id}`;
    await forge.api(`${apiPath}/contents/.forgejo/workflows/factory-verification.yml`, "POST", {
      message: "Owned diagnostic workflow",
      content: Buffer.from(
        [
          "name: Factory Verification",
          "on: [pull_request]",
          "jobs:",
          "  checks:",
          `    runs-on: ${label}`,
          "    steps:",
          "      - name: Validate fixture",
          "        run: |",
          "          printf 'Expected 200, received 500\\n'",
          "          printf 'API_KEY=owned-fixture-private-value\\n'",
          "          exit 1",
          "",
        ].join("\n"),
      ).toString("base64"),
    });
    const base = await client.getDefaultBranch(repository);
    await client.ensureBranch(repository, "owned-candidate", base.headSha);
    const file = (await forge.api(`${apiPath}/contents/candidate.txt`, "POST", {
      branch: "owned-candidate",
      message: "Owned candidate",
      content: Buffer.from("candidate\n").toString("base64"),
    })) as { commit: { sha: string } };
    await forge.api(`${apiPath}/pulls`, "POST", {
      base: base.name,
      head: "owned-candidate",
      title: "Owned verification diagnostics",
    });
    const runs = await eventually(
      () => client.listActionRuns(repository, file.commit.sha),
      (items) => items.length > 0,
      "Owned Verification did not appear",
      30_000,
    );
    const run = fixtureValue(runs[0], "runs[0]");
    const jobs = await eventually(
      () =>
        fixtureValue(forge, "forge").api(
          `${apiPath}/actions/runners/jobs?labels=${label}`,
        ) as Promise<Array<{ handle: string }>>,
      (items) => items.length > 0,
      "Owned Verification job did not appear",
      30_000,
    );
    const registration = await client.registerEphemeralRunner(repository, label);
    const pins = await Bun.file("upstream.json").json();
    const architecture = /arm|aarch/.test(await command(["info", "--format", "{{.Architecture}}"]))
      ? "arm64"
      : "amd64";
    const binary = await fetch(
      `https://code.forgejo.org/forgejo/runner/releases/download/v${pins.forgejoRunner.version}/forgejo-runner-${pins.forgejoRunner.version}-linux-${architecture}`,
    );
    if (!binary.ok) throw new Error("Pinned Verification runner download failed");
    const bytes = new Uint8Array(await binary.arrayBuffer());
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(
      pins.forgejoRunner.sha256[architecture],
    );
    await writeFile(resolve(directory, "runner"), bytes);
    await chmod(resolve(directory, "runner"), 0o555);
    await writeFile(
      resolve(directory, "runner.yml"),
      [
        "runner:",
        "  capacity: 1",
        "  timeout: 1m",
        "cache:",
        "  enabled: false",
        "host:",
        "  workdir_parent: /tmp/factory-actions",
        "server:",
        "  connections:",
        "    factory:",
        "      url: http://forge:3000",
        `      uuid: ${registration.uuid}`,
        `      token: ${registration.token}`,
        "      labels:",
        `        - ${label}:host`,
        "",
      ].join("\n"),
      { mode: 0o600 },
    );
    await command([
      "run",
      "--detach",
      "--network",
      network,
      "--name",
      runner,
      "--label",
      `factory.diagnostics=${id}`,
      "--volume",
      `${directory}:/proof:ro`,
      "--entrypoint",
      "/proof/runner",
      pins.nodeDevelopment.image,
      "one-job",
      "--wait",
      "--handle",
      fixtureValue(jobs[0], "jobs[0]").handle,
      "--config",
      "/proof/runner.yml",
    ]);
    runnerCreated = true;
    const diagnosis = await eventually(
      () => client.diagnoseVerification(repository, run.id, file.commit.sha),
      (value) => value.kind === "check-failed",
      "Owned failed-step diagnosis was not observed",
      90_000,
    );
    expect(diagnosis.jobs[0]?.stepName).toBe("Validate fixture");
    expect(diagnosis.jobs[0]?.output).toContain("Expected 200, received 500");
    expect(JSON.stringify(diagnosis)).not.toContain("owned-fixture-private-value");
    const observed = fixtureValue(diagnosis.jobs[0], "diagnosis.jobs[0]");
    const page = await client.readVerificationLog(repository, {
      runID: run.id,
      commit: file.commit.sha,
      jobID: observed.id,
      attempt: observed.attempt,
      step: fixtureValue(observed.step, "observed.step"),
      offset: 0,
    });
    expect(page.output).toContain("Expected 200, received 500");
    expect(page.output).not.toContain("owned-fixture-private-value");
    expect((await client.diagnoseVerification(repository, run.id, "b".repeat(40))).kind).toBe(
      "unavailable",
    );
    await writeFile(
      resolve(directory, "result.json"),
      JSON.stringify(
        {
          version: version.version,
          commit: file.commit.sha,
          runID: run.id,
          diagnosis,
          page,
        },
        null,
        2,
      ),
    );
  } finally {
    if (runnerCreated) {
      expect(
        await command([
          "inspect",
          "--format",
          '{{index .Config.Labels "factory.diagnostics"}}',
          runner,
        ]),
      ).toBe(id);
      await command(["rm", "--force", runner]);
    }
    await forge?.dispose();
    expect(
      await command([
        "network",
        "inspect",
        "--format",
        '{{index .Labels "factory.diagnostics"}}',
        network,
      ]),
    ).toBe(id);
    await command(["network", "rm", network]);
    await rm(resolve(directory, "runner.yml"), { force: true });
    await rm(resolve(directory, "runner"), { force: true });
  }
}, 240_000);
