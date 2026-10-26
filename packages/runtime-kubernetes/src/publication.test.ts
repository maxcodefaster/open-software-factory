import { expect, test } from "bun:test";
import { parse } from "yaml";
import {
  ownedFactoryboxLocation,
  ownedFactoryboxProfile,
} from "../../../test/fixtures/runtime-configuration";
import { renderRuntimeResources } from "./manifest";

test("publication is a bound one-job Sandbox without development apps or publication credentials", () => {
  const resources = renderRuntimeResources({
    factoryboxProfile: ownedFactoryboxProfile,
    attemptID: crypto.randomUUID(),
    generation: 1,
    ...ownedFactoryboxLocation,
    projectID: crypto.randomUUID(),
    mode: "publication",
    revision: "a".repeat(40),
    repositoryURL: "https://forge.example/factory/project.git",
    devcontainerPath: ".devcontainer/devcontainer.json",
    composeProjectName: "project",
    connectorToken: "synthetic-parent-token",
    childConnectorToken: "synthetic-child-token",
    controlURL: "wss://factory.example/internal/runtime-connect",
    runtimeHostImage: `registry.example/runtime@sha256:${"b".repeat(64)}`,
    registryCA: "synthetic-certificate",
    verification: {
      forgeURL: "https://forge.example",
      runnerUUID: crypto.randomUUID(),
      runnerToken: "synthetic-runner-token",
      runnerLabel: "factory-publication",
      handle: "specific-job-attempt",
      publication: {
        id: crypto.randomUUID(),
        version: "1.2.3",
        credentialURL: "https://factory.example/internal/releases/owned/credentials",
        credentialToken: "synthetic-task-attestation-token",
      },
    },
  });
  const secret = resources.find(
    (value) => value.kind === "Secret" && value.metadata.name.startsWith("assignment-"),
  );
  if (
    !secret ||
    !("stringData" in secret) ||
    !("assignment.json" in secret.stringData) ||
    typeof secret.stringData["assignment.json"] !== "string"
  )
    throw new Error("Publication assignment is missing");
  const assignment = JSON.parse(secret.stringData["assignment.json"]);
  expect(assignment.channels.map((value: { kind: string }) => value.kind)).toEqual([
    "verification",
  ]);
  expect(assignment.processes).toHaveLength(1);
  expect(assignment.processes[0].env.FACTORY_RUNNER_HANDLE).toBe("specific-job-attempt");
  expect(assignment.processes[0].env.FACTORY_RELEASE_REGISTRY).toBe("forge.example");
  const jobEnvironment = parse(assignment.processes[0].env.FACTORY_RUNNER_CONFIG).runner.envs;
  expect(jobEnvironment.FACTORY_RELEASE_SOURCE).toBe("/workspace/project");
  expect(jobEnvironment.FACTORY_RELEASE_VERSION).toBe("1.2.3");
  expect(jobEnvironment.FACTORY_RELEASE_CREDENTIAL_TOKEN).toBe("synthetic-task-attestation-token");
  expect(jobEnvironment).not.toHaveProperty("FACTORY_RUNNER_CONFIG");
  expect(assignment.processes[0].command.join(" ")).toContain("--handle");
  const pod = resources.find((value) => value.kind === "Pod")!;
  expect(pod.spec!.automountServiceAccountToken).toBe(false);
  expect(JSON.stringify(resources)).not.toContain("FACTORY_AUTH_SECRET");
  expect(JSON.stringify(resources)).not.toContain("PROJECT_ENVIRONMENT_SECRET");
});
