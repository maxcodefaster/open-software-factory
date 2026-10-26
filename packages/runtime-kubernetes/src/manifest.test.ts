import { describe, expect, test } from "bun:test";
import {
  ownedFactoryboxLocation,
  ownedFactoryboxProfile,
} from "../../../test/fixtures/runtime-configuration";
import { factoryboxBootstrapProgram } from "./factorybox-runtime";
import { renderRuntimeResources } from "./manifest";

const systemContract = {
  version: 1 as const,
  primaryApp: "web",
  apps: [
    {
      id: "web",
      label: "Web",
      command: ["node", "src/server.mjs"],
      port: 4_300,
      healthPath: "/health",
    },
  ],
};
const multiAppSystemContract = {
  ...systemContract,
  apps: [
    ...systemContract.apps,
    {
      id: "worker",
      label: "Worker monitor",
      command: ["node", "src/worker.mjs"],
      port: 4_310,
      healthPath: "/health",
    },
  ],
};

describe("runtime Kubernetes resources", () => {
  test("keep Factory authority out of the runtime", () => {
    const resources = renderRuntimeResources({
      factoryboxProfile: ownedFactoryboxProfile,
      attemptID: "01234567-89ab-5def-8123-456789abcdef",
      generation: 1,
      ...ownedFactoryboxLocation,
      projectID: "20e65e28-8bad-4c05-a063-3b629808d549",
      repositoryURL: "file:///factory/project",
      revision: "main",
      devcontainerPath: ".devcontainer/devcontainer.json",
      composeProjectName: "factory_0123456789ab",
      connectorToken: "one-use-token",
      childConnectorToken: "one-use-child-token",
      controlURL: "ws://factory.example/runtime/connect",
      runtimeHostImage: `registry.example/runtime-host@sha256:${"a".repeat(64)}`,
      storageNode: ownedFactoryboxProfile.nodeName,
      registryCA: "certificate",
      systemContract,
    });
    const pod = resources.find((resource) => resource.kind === "Pod");
    expect(pod?.spec?.automountServiceAccountToken).toBe(false);
    expect(pod?.spec?.nodeSelector).toEqual({
      "kubernetes.io/os": "linux",
      "kubernetes.io/arch": "amd64",
      "kubernetes.io/hostname": ownedFactoryboxProfile.nodeName,
    });
    expect(JSON.stringify(pod?.spec?.volumes)).not.toContain("docker.sock");
    expect(JSON.stringify(pod?.spec?.containers?.[0]?.volumeMounts)).not.toContain("docker.sock");
    expect(JSON.stringify(pod)).not.toContain('hostPath":{"path":"/Users');
    expect(JSON.stringify(pod)).not.toContain("FACTORY_AUTH_SECRET");
    expect(JSON.stringify(pod)).not.toContain("envbox");
    expect(factoryboxBootstrapProgram).toContain(
      "unset CODER_AGENT_TOKEN CODER_AGENT_SUBSYSTEM CODER_AGENT_URL",
    );
    expect(JSON.stringify(pod)).not.toContain("factory-bootstrap");
    const worker = pod?.spec?.containers?.[0];
    expect(worker?.name).toBe("worker");
    expect(worker?.image).toBe(ownedFactoryboxProfile.image);
    expect(worker?.volumeMounts).toContainEqual({
      name: "registry-ca",
      mountPath: "/factory/registry-ca",
      readOnly: true,
    });
    const bootstrap = factoryboxBootstrapProgram;
    expect(bootstrap).not.toContain("insecure-registry");
    expect(bootstrap).not.toContain("until docker info");
    expect(bootstrap).toContain("exec factory-runtime-connector parent");
    expect(bootstrap).toContain("--token-file /run/factory-parent-token");
    expect(bootstrap).not.toContain("/tmp/factory-parent-token");
    expect(bootstrap).toContain("dockerd --host=unix:///var/run/docker.sock");
    expect(bootstrap).not.toContain("dockerd-entrypoint.sh");
    const assignment = String(
      resources.find((resource) => resource.kind === "Secret")?.stringData?.["assignment.json"],
    );
    const parsedAssignment = JSON.parse(assignment) as {
      processes: Array<{ name: string; command: string[] }>;
    };
    expect(parsedAssignment.processes.some((process) => process.name === "ide")).toBe(false);
    expect(assignment).not.toContain("/opt/factory/theia");
    expect(assignment).not.toContain("4400");
    expect(assignment).not.toContain("openvscode");
    expect(JSON.stringify(pod)).not.toContain("FACTORY_OPENVSCODE_IMAGE");
  });

  test("keeps development tools out of Staging", () => {
    const resources = renderRuntimeResources({
      factoryboxProfile: ownedFactoryboxProfile,
      attemptID: "01234567-89ab-5def-8123-456789abcdef",
      generation: 1,
      ...ownedFactoryboxLocation,
      projectID: "20e65e28-8bad-4c05-a063-3b629808d549",
      repositoryURL: "file:///factory/project",
      revision: "a".repeat(40),
      devcontainerPath: ".devcontainer/devcontainer.json",
      composeProjectName: "factory_0123456789ab",
      connectorToken: "one-use-token",
      childConnectorToken: "one-use-child-token",
      controlURL: "ws://factory.example/runtime/connect",
      runtimeHostImage: `registry.example/runtime-host@sha256:${"a".repeat(64)}`,
      registryCA: "certificate",
      mode: "staging",
      systemContract: multiAppSystemContract,
    });
    const assignment = resources.find((resource) => resource.kind === "Secret")?.stringData?.[
      "assignment.json"
    ];
    expect(assignment).toBeDefined();
    expect(JSON.parse(String(assignment))).toMatchObject({
      channels: [{ name: "app" }, { name: "app-worker" }],
      processes: [{ name: "app" }, { name: "app-worker" }],
    });
    expect(String(assignment)).not.toContain("/opt/factory/theia");
    expect(String(assignment)).not.toContain('"name":"ide"');
    expect(String(assignment)).not.toContain('"name":"agent"');
    expect(
      resources.find((resource) => resource.kind === "Pod")?.spec?.containers?.[0]?.resources,
    ).toMatchObject({
      requests: { cpu: "3", memory: "3Gi" },
      limits: { cpu: "3", memory: "3Gi" },
    });
  });

  test("runs one exact Forgejo Actions job in a Verification Sandbox", () => {
    const resources = renderRuntimeResources({
      factoryboxProfile: ownedFactoryboxProfile,
      attemptID: "01234567-89ab-5def-8123-456789abcdef",
      generation: 3,
      ...ownedFactoryboxLocation,
      projectID: "20e65e28-8bad-4c05-a063-3b629808d549",
      repositoryURL: "https://forge.example/factory/project.git",
      revision: "b".repeat(40),
      devcontainerPath: ".devcontainer/devcontainer.json",
      composeProjectName: "factory_0123456789ab",
      connectorToken: "one-use-token",
      childConnectorToken: "one-use-child-token",
      controlURL: "ws://factory.example/runtime/connect",
      runtimeHostImage: `registry.example/runtime-host@sha256:${"a".repeat(64)}`,
      registryCA: "certificate",
      mode: "verification",
      verification: {
        forgeURL: "https://forge.example/",
        runnerUUID: "22222222-2222-4222-8222-222222222222",
        runnerToken: "ephemeral-runner-token",
        runnerLabel: "factory-verification",
      },
    });
    const assignment = JSON.parse(
      String(
        resources.find((resource) => resource.kind === "Secret")?.stringData?.["assignment.json"],
      ),
    );
    expect(assignment.channels).toEqual([
      {
        name: "verification",
        kind: "verification",
        target: "http://127.0.0.1:4500",
        healthPath: "/health",
      },
    ]);
    const process = assignment.processes[0];
    expect(process.command[2]).toContain(
      'spawn("/opt/factory/forgejo-runner", ["one-job", "--wait"',
    );
    expect(process.command[2]).not.toContain("forgejo-runner daemon");
    expect(process.env.FACTORY_RUNNER_CONFIG).toContain("factory-verification:host");
    expect(process.env.FACTORY_RUNNER_CONFIG).toContain("ephemeral-runner-token");
    expect(JSON.stringify(resources)).not.toContain("/opt/factory/theia");
    expect(JSON.stringify(assignment)).not.toContain('"name":"app"');
    expect(JSON.stringify(assignment)).not.toContain('"name":"ide"');
    expect(JSON.stringify(assignment)).not.toContain('"name":"agent"');
    expect(
      resources.find((resource) => resource.kind === "Pod")?.spec?.containers?.[0]?.resources,
    ).toMatchObject({
      requests: { cpu: "3", memory: "3Gi" },
      limits: { cpu: "3", memory: "3Gi" },
    });
  });

  test.each([undefined, "medium", "high"] as const)(
    "adds OpenCode with the frozen Coding configuration: %s",
    (reasoningEffort) => {
      const resources = renderRuntimeResources({
        factoryboxProfile: ownedFactoryboxProfile,
        attemptID: "01234567-89ab-5def-8123-456789abcdef",
        generation: 2,
        ...ownedFactoryboxLocation,
        projectID: "20e65e28-8bad-4c05-a063-3b629808d549",
        repositoryURL: "https://forge.example/factory/project.git",
        revision: "a".repeat(40),
        devcontainerPath: ".devcontainer/devcontainer.json",
        composeProjectName: "factory_0123456789ab",
        connectorToken: "one-use-token",
        childConnectorToken: "one-use-child-token",
        controlURL: "ws://factory.example/runtime/connect",
        runtimeHostImage: `registry.example/runtime-host@sha256:${"a".repeat(64)}`,
        registryCA: "certificate",
        agent: {
          modelBaseURL: "http://host.orb.internal:3000/internal/model/attempt/v1",
          modelToken: "generation-token",
          modelID: "gpt-5.6-terra",
          modelIDs: ["gpt-5.6-terra", "approved-alternative", "gpt-6.1-sol"],
          ...(reasoningEffort ? { reasoningEffort } : {}),
          browserToolsImage: `registry.factory/browser-tools@sha256:${"a".repeat(64)}`,
          browserURL: "http://host.orb.internal:3000/internal/build-browser/attempt",
          browserToken: "owned-browser-generation-token",
        },
        systemContract,
      });
      const assignment = JSON.parse(
        String(
          resources.find((resource) => resource.kind === "Secret")?.stringData?.["assignment.json"],
        ),
      );
      expect(assignment.channels).toContainEqual({
        name: "agent",
        kind: "agent",
        target: "http://127.0.0.1:4096",
        healthPath: "/api/health",
      });
      const agentProcess = assignment.processes.find(
        (process: { name: string }) => process.name === "agent",
      );
      const agentCommand = agentProcess.command[2];
      expect(agentProcess.command.slice(0, 2)).toEqual(["sh", "-c"]);
      expect(agentCommand).toContain(
        "/opt/factory/opencode/bun /opt/factory/opencode/server/server.mjs",
      );
      expect(agentProcess.env.FACTORY_OPENCODE_CONFIG).toContain("gpt-5.6-terra");
      expect(
        JSON.parse(agentProcess.env.FACTORY_OPENCODE_CONFIG).providers.factory.settings
          .reasoningEffort,
      ).toBe(reasoningEffort ?? "none");
      const provider = JSON.parse(agentProcess.env.FACTORY_OPENCODE_CONFIG).providers.factory;
      expect(provider.websocket).toBeUndefined();
      expect(provider.settings.transport).toBe("http");
      expect(provider.settings.compaction).toEqual({ type: "summary" });
      expect(agentCommand).not.toContain(".config/opencode");
      expect(assignment.browserToolsImage).toBe(
        `registry.factory/browser-tools@sha256:${"a".repeat(64)}`,
      );
      expect(agentProcess.env.FACTORY_BUILD_BROWSER_COMMAND).toBe(
        "/tmp/factory-runtime-connector-2",
      );
      expect(agentProcess.env.FACTORY_BUILD_BROWSER_TOKEN).toBe("owned-browser-generation-token");
      expect(
        assignment.processes
          .filter((process: { name: string }) => process.name !== "agent")
          .every(
            (process: { env?: Record<string, string> }) =>
              !process.env?.["FACTORY_BUILD_BROWSER_TOKEN"],
          ),
      ).toBe(true);
      expect(JSON.stringify(assignment)).not.toContain("FACTORY_MODEL_API_KEY");
      expect(JSON.parse(agentProcess.env.FACTORY_OPENCODE_CONFIG).providers.factory.models).toEqual(
        {
          "gpt-5.6-terra": { name: "gpt-5.6-terra" },
          "approved-alternative": { name: "approved-alternative" },
          "gpt-6.1-sol": {
            name: "gpt-6.1-sol",
            capabilities: { tools: true, input: ["text", "image"], output: ["text"] },
            limit: { context: 1_050_000, input: 922_000, output: 128_000 },
          },
        },
      );
      expect(JSON.stringify(assignment)).not.toContain("FACTORY_FORGEJO_TOKEN");
      expect(JSON.parse(agentProcess.env.FACTORY_OPENCODE_CONFIG).providers.factory.package).toBe(
        reasoningEffort
          ? "@opencode/ai/providers/openai/responses"
          : "@opencode/ai/providers/openai/chat",
      );
      expect(agentProcess.env.OPENCODE_PASSWORD).toBe("generation-token");
      expect(agentCommand).not.toContain("opencode web");
      expect(agentCommand).toContain("OPENCODE_DB=/workspace/project/.git/factory-opencode.db");
    },
  );
});
