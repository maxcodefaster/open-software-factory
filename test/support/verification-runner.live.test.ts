import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, unlink, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { z } from "zod";
import { createForgejoClient } from "../../packages/forge/src/forge";
import { renderRuntimeResources } from "../../packages/runtime-kubernetes/src/manifest";
import upstream from "../../upstream.json";
import { eventually } from "../fixtures/factory-process";

// This isolates the pinned runner's actual Dev Container invocation. It makes no Build,
// repository or approval, and the endpoint owns only dummy authentication.
const realRegistration = process.env["FACTORY_RUN_VERIFICATION_REGISTRATION_PROOF"] === "1";
test.skipIf(process.env["FACTORY_RUN_VERIFICATION_RUNNER_PROOF"] !== "1" && !realRegistration)(
  "the declared pinned Verification runner contacts Forgejo instead of exposing an empty health shell",
  async () => {
    const owner = crypto.randomUUID();
    const sourceName = `factory-owned-runner-source-${owner}`;
    const primaryName = `factory-owned-runner-primary-${owner}`;
    const dummyToken = "a".repeat(40);
    await mkdir(".factory/test-results/verification-runner", { recursive: true });
    const directory = await mkdtemp(resolve(".factory/test-results/verification-runner/probe-"));
    const image = (await readFile(".factory/verification-runtime-host-image", "utf8"))
      .trim()
      .replace(
        "registry.open-factory-envbox-smoke.svc.cluster.local:5000",
        "registry.localhost:5443",
      );
    let requests = 0;
    let observedRunner: { id: number; name: string; status: string; labels?: unknown } | undefined;
    const endpoint = Bun.serve({
      hostname: "0.0.0.0",
      port: 0,
      fetch() {
        requests++;
        return Response.json(
          { code: "unauthenticated", message: "Owned runner probe" },
          { status: 401 },
        );
      },
    });
    const repository = { owner: "factory-mutation", name: "runtime-fixture" };
    const runnerName = `factory-owned-runner-probe-${owner}`;
    const forgeToken = realRegistration
      ? (await readFile(".factory/forgejo-token", "utf8")).trim()
      : "";
    const forge = realRegistration
      ? createForgejoClient({ apiURL: "http://127.0.0.1:33030/api/v1/", token: forgeToken })
      : null;
    await writeFile(
      resolve(directory, "intent.json"),
      JSON.stringify({
        owner,
        sourceName,
        primaryName,
        image,
        primaryImage: upstream.nodeDevelopment.image,
        ...(realRegistration ? { repository, runnerName } : {}),
      }),
    );
    const registration = await forge?.registerEphemeralRunner(repository, runnerName);
    if (registration)
      await writeFile(
        resolve(directory, "runner.json"),
        JSON.stringify({ id: registration.id, uuid: registration.uuid, name: runnerName }),
      );
    const resources = renderRuntimeResources({
      attemptID: owner,
      generation: 1,
      namespace: "owned-runner-probe",
      podName: "runtime-1",
      projectID: owner,
      repositoryURL: "https://repository.example.invalid/owned.git",
      revision: "a".repeat(40),
      devcontainerPath: ".devcontainer/devcontainer.json",
      composeProjectName: `factory_${owner.replaceAll("-", "").slice(0, 12)}`,
      connectorToken: "owned-unused-parent",
      childConnectorToken: "owned-unused-child",
      controlURL: "ws://factory.example.invalid/runtime/connect",
      runtimeHostImage: image,
      registryCA: "owned-unused-ca",
      mode: "verification",
      verification: {
        forgeURL: realRegistration
          ? "http://host.orb.internal:33030/"
          : `http://host.orb.internal:${endpoint.port}/`,
        runnerUUID: registration?.uuid ?? owner,
        runnerToken: registration?.token ?? dummyToken,
        runnerLabel: realRegistration ? runnerName : "factory-verification",
      },
    });
    const assignment = z
      .object({
        processes: z.array(
          z.object({
            name: z.string(),
            command: z.array(z.string()),
            env: z.record(z.string(), z.string()),
          }),
        ),
      })
      .parse(
        JSON.parse(
          String(resources.find((item) => item.kind === "Secret")?.stringData?.["assignment.json"]),
        ),
      );
    const process = assignment.processes.find((item) => item.name === "verification");
    if (!process) throw new Error("Declared Verification process missing");
    const binary = resolve(directory, "forgejo-runner");
    async function docker(args: string[]) {
      const child = Bun.spawn(["docker", ...args], { stdout: "pipe", stderr: "pipe" });
      const timer = setTimeout(() => child.kill(), 30_000);
      try {
        const [output, error, status] = await Promise.all([
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
          child.exited,
        ]);
        if (status !== 0) throw new Error(`Owned runner ${args[0]} failed: ${error.slice(0, 300)}`);
        return output.trim();
      } finally {
        clearTimeout(timer);
      }
    }
    async function remove(name: string) {
      const identity = await docker([
        "inspect",
        "--format",
        '{{index .Config.Labels "factory.owned-runner-probe"}}',
        name,
      ]).catch((cause) => {
        if (cause instanceof Error && /no such object/i.test(cause.message)) return null;
        throw cause;
      });
      if (identity === null) return;
      if (identity !== owner) throw new Error("Owned runner probe cleanup refused");
      await docker(["rm", "--force", name]);
    }
    try {
      await docker([
        "create",
        "--name",
        sourceName,
        "--label",
        `factory.owned-runner-probe=${owner}`,
        image,
      ]);
      await docker(["cp", `${sourceName}:/usr/local/bin/forgejo-runner`, binary]);
      await remove(sourceName);
      await docker([
        "run",
        "--detach",
        "--name",
        primaryName,
        "--label",
        `factory.owned-runner-probe=${owner}`,
        "--user",
        "node",
        "--mount",
        `type=bind,source=${binary},target=/opt/factory/forgejo-runner,readonly`,
        "--env",
        `FACTORY_RUNNER_CONFIG=${process.env["FACTORY_RUNNER_CONFIG"]}`,
        upstream.nodeDevelopment.image,
        "sleep",
        "infinity",
      ]);
      await docker(["exec", "--detach", "--user", "node", primaryName, ...process.command]);
      let contacted = true;
      await eventually(
        async () => {
          if (!registration) return requests;
          const response = await fetch(
            "http://127.0.0.1:33030/api/v1/repos/factory-mutation/runtime-fixture/actions/runners?limit=100",
            {
              headers: { authorization: `token ${forgeToken}` },
              signal: AbortSignal.timeout(5000),
            },
          );
          if (!response.ok) throw new Error("Owned runner observation failed");
          const runners = z
            .array(
              z.object({
                id: z.number(),
                name: z.string(),
                status: z.string(),
                labels: z.unknown().optional(),
              }),
            )
            .parse(await response.json());
          const runner = runners.find(
            (item) => item.id === registration.id && item.name === runnerName,
          );
          observedRunner = runner;
          return runner && ["idle", "active"].includes(runner.status) ? 1 : 0;
        },
        (count) => count > 0,
        "Runner never contacted its configured Forgejo",
        10_000,
      ).catch(() => {
        contacted = false;
      });
      const observation = JSON.parse(
        await docker([
          "exec",
          "--user",
          "node",
          primaryName,
          "node",
          "-e",
          'const fs=require("fs");const d=require("os").homedir()+"/.factory-runner/";let log=fs.existsSync(d+"runner.log")?fs.readFileSync(d+"runner.log","utf8"):"absent";const config=fs.readFileSync(d+"config.yml","utf8");for(const match of config.matchAll(/token:\\s*(\\S+)/g))log=log.replaceAll(match[1],"<REDACTED>");fetch("http://127.0.0.1:4500/health",{signal:AbortSignal.timeout(2000)}).then(r=>r.ok).catch(()=>false).then(health=>console.log(JSON.stringify({health,log:log.slice(-2000)})))',
        ]),
      );
      await writeFile(
        resolve(directory, "result.json"),
        JSON.stringify({ contacted, requests, observedRunner, observation }),
      );
      if (!contacted) console.info(`Pinned runner probe: ${JSON.stringify(observation)}`);
      expect(contacted).toBe(true);
      expect(observation.health).toBe(realRegistration);
      if (observedRunner) {
        const labels = z.array(z.string()).nullable().parse(observedRunner.labels);
        console.info(`Owned declared runner labels: ${JSON.stringify(labels)}`);
        expect(labels).toContain(runnerName);
      }
    } finally {
      await remove(primaryName);
      await remove(sourceName);
      if (registration && forge) await forge.deleteRunner(repository, registration.id);
      await endpoint.stop(true);
      await unlink(binary).catch((cause) => {
        if (!cause || typeof cause !== "object" || !("code" in cause) || cause.code !== "ENOENT")
          throw cause;
      });
    }
  },
  120_000,
);
