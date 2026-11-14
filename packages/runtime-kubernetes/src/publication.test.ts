import { expect, test } from "bun:test";
import { parse } from "yaml";
import { runtimeVerificationProcess } from "./verification-process";

test("native publication runs one bound Forgejo job with only its scoped release capabilities", () => {
  const process = runtimeVerificationProcess({
    forgeURL: "https://forge.example",
    runnerUUID: crypto.randomUUID(),
    runnerToken: "owned-runner-token",
    runnerLabel: "factory-publication",
    handle: "specific-job-attempt",
    publication: {
      id: crypto.randomUUID(),
      version: "1.2.3",
      credentialURL: "https://factory.example/internal/releases/owned/credentials",
      credentialToken: "owned-task-attestation-token",
    },
  });
  expect(process.name).toBe("verification");
  expect(process.env.FACTORY_RUNNER_HANDLE).toBe("specific-job-attempt");
  expect(process.env.FACTORY_RELEASE_REGISTRY).toBe("forge.example");
  const config = parse(process.env.FACTORY_RUNNER_CONFIG);
  expect(config.runner.capacity).toBe(1);
  expect(config.runner.envs).toMatchObject({
    FACTORY_RELEASE_SOURCE: "/workspace/project",
    FACTORY_RELEASE_VERSION: "1.2.3",
    FACTORY_RELEASE_CREDENTIAL_TOKEN: "owned-task-attestation-token",
  });
  expect(config.runner.envs).not.toHaveProperty("FACTORY_RUNNER_CONFIG");
  expect(config.server.connections.factory.token).toBe("owned-runner-token");
  expect(process.command.join(" ")).toContain('"one-job", "--wait"');
  expect(process.command.join(" ")).toContain("--handle");
  expect(JSON.stringify(process)).not.toMatch(
    /FACTORY_AUTH_SECRET|PROJECT_ENVIRONMENT_SECRET|forgejo-runner daemon|theia/,
  );
});

test("native Verification without publication receives no release capability", () => {
  const process = runtimeVerificationProcess({
    forgeURL: "https://forge.example",
    runnerUUID: crypto.randomUUID(),
    runnerToken: "owned-runner-token",
    runnerLabel: "factory-verification",
    handle: "owned-exact-job",
  });
  expect(process.env.FACTORY_RUNNER_HANDLE).toBe("owned-exact-job");
  expect(parse(process.env.FACTORY_RUNNER_CONFIG).server.connections.factory.labels).toEqual([
    "factory-verification:host",
  ]);
  expect(JSON.stringify(process)).not.toContain("FACTORY_RELEASE_");
});
