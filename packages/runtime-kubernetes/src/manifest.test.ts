import { describe, expect, test } from "bun:test";
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
      attemptID: "01234567-89ab-5def-8123-456789abcdef",
      generation: 1,
      namespace: "factory-runtime-0123456789ab",
      podName: "runtime",
      projectID: "20e65e28-8bad-4c05-a063-3b629808d549",
      repositoryURL: "file:///factory/project",
      revision: "main",
      devcontainerPath: ".devcontainer/devcontainer.json",
      composeProjectName: "factory_0123456789ab",
      connectorToken: "one-use-token",
      childConnectorToken: "one-use-child-token",
      controlURL: "ws://factory.example/runtime/connect",
      runtimeHostImage: "registry.example/runtime-host@sha256:0123",
      storageNode: "canonical-source-node",
      registryCA: "certificate",
      systemContract,
    });
    const pod = resources.find((resource) => resource.kind === "Pod");
    expect(pod?.spec?.automountServiceAccountToken).toBe(false);
    expect(pod?.spec?.nodeSelector).toEqual({ "kubernetes.io/hostname": "canonical-source-node" });
    expect(JSON.stringify(pod?.spec?.volumes)).not.toContain("docker.sock");
    expect(JSON.stringify(pod?.spec?.containers?.[0]?.volumeMounts)).not.toContain("docker.sock");
    expect(JSON.stringify(pod)).not.toContain('hostPath":{"path":"/Users');
    expect(JSON.stringify(pod)).not.toContain("FACTORY_AUTH_SECRET");
    expect(JSON.stringify(pod)).toContain("unused-required-by-envbox");
    expect(JSON.stringify(pod)).toContain("CODER_AGENT_URL is forbidden");
    expect(JSON.stringify(pod)).toContain(
      "unset CODER_AGENT_TOKEN CODER_AGENT_SUBSYSTEM CODER_AGENT_URL",
    );
    expect(JSON.stringify(pod)).not.toContain("factory-bootstrap");
    const envbox = pod?.spec?.containers?.[0];
    expect(envbox?.env?.find((entry) => entry.name === "CODER_MOUNTS")?.value).not.toContain(
      "docker.sock",
    );
    expect(envbox?.volumeMounts).toContainEqual({
      name: "registry-ca",
      mountPath: "/factory/registry-ca",
      readOnly: true,
    });
    expect(envbox?.env?.find((entry) => entry.name === "CODER_MOUNTS")?.value).toContain(
      "/factory/registry-ca:/factory/registry-ca:ro",
    );
    const bootstrap = envbox?.env?.find((entry) => entry.name === "CODER_BOOTSTRAP_SCRIPT")?.value;
    const install =
      "cp /factory/registry-ca/ca.crt /etc/docker/certs.d/registry.open-factory-envbox-smoke.svc.cluster.local:5000/ca.crt";
    expect(bootstrap).toContain(install);
    expect(bootstrap?.indexOf(install)).toBeLessThan(
      bootstrap?.indexOf("dockerd-entrypoint.sh") ?? -1,
    );
    expect(bootstrap).not.toContain("insecure-registry");
    expect(bootstrap).not.toContain("until docker info");
    expect(bootstrap).toContain("exec factory-runtime-connector parent");
    expect(bootstrap).toContain("--token-file /run/factory-parent-token");
    expect(bootstrap).not.toContain("/tmp/factory-parent-token");
    expect(bootstrap).toContain("dockerd-entrypoint.sh dockerd --host=unix:///var/run/docker.sock");
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
      attemptID: "01234567-89ab-5def-8123-456789abcdef",
      generation: 1,
      namespace: "factory-runtime-0123456789ab",
      podName: "runtime-1",
      projectID: "20e65e28-8bad-4c05-a063-3b629808d549",
      repositoryURL: "file:///factory/project",
      revision: "a".repeat(40),
      devcontainerPath: ".devcontainer/devcontainer.json",
      composeProjectName: "factory_0123456789ab",
      connectorToken: "one-use-token",
      childConnectorToken: "one-use-child-token",
      controlURL: "ws://factory.example/runtime/connect",
      runtimeHostImage: "registry.example/runtime-host@sha256:0123",
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
      requests: { cpu: "100m", memory: "256Mi", "ephemeral-storage": "512Mi" },
      limits: { cpu: "2", memory: "2Gi", "ephemeral-storage": "2Gi" },
    });
  });

  test("runs one exact Forgejo Actions job in a Verification Sandbox", () => {
    const resources = renderRuntimeResources({
      attemptID: "01234567-89ab-5def-8123-456789abcdef",
      generation: 3,
      namespace: "factory-runtime-0123456789ab",
      podName: "runtime-3",
      projectID: "20e65e28-8bad-4c05-a063-3b629808d549",
      repositoryURL: "https://forge.example/factory/project.git",
      revision: "b".repeat(40),
      devcontainerPath: ".devcontainer/devcontainer.json",
      composeProjectName: "factory_0123456789ab",
      connectorToken: "one-use-token",
      childConnectorToken: "one-use-child-token",
      controlURL: "ws://factory.example/runtime/connect",
      runtimeHostImage: "registry.example/runtime-host@sha256:0123",
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
      'spawn("/opt/factory/forgejo-runner", ["one-job", "--wait", "--config"',
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
      requests: { cpu: "250m", memory: "768Mi", "ephemeral-storage": "2Gi" },
      limits: { cpu: "6", memory: "8Gi", "ephemeral-storage": "8Gi" },
    });
  });

  test("adds OpenCode only to an explicitly agent-enabled Ticket Sandbox", () => {
    const resources = renderRuntimeResources({
      attemptID: "01234567-89ab-5def-8123-456789abcdef",
      generation: 2,
      namespace: "factory-workspace-0123456789ab",
      podName: "runtime-2",
      projectID: "20e65e28-8bad-4c05-a063-3b629808d549",
      repositoryURL: "https://forge.example/factory/project.git",
      revision: "a".repeat(40),
      devcontainerPath: ".devcontainer/devcontainer.json",
      composeProjectName: "factory_0123456789ab",
      connectorToken: "one-use-token",
      childConnectorToken: "one-use-child-token",
      controlURL: "ws://factory.example/runtime/connect",
      runtimeHostImage: "registry.example/runtime-host@sha256:0123",
      registryCA: "certificate",
      agent: {
        modelBaseURL: "http://host.orb.internal:3000/internal/model/attempt/v1",
        modelToken: "generation-token",
        modelID: "gpt-5.6-terra",
        modelIDs: ["gpt-5.6-terra", "approved-alternative"],
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
    expect(agentCommand).toContain("/opt/factory/opencode/bun /opt/factory/opencode/server/server.mjs");
    expect(agentProcess.env.FACTORY_OPENCODE_CONFIG).toContain("gpt-5.6-terra");
    expect(
      JSON.parse(agentProcess.env.FACTORY_OPENCODE_CONFIG).providers.factory.settings
        .reasoningEffort,
    ).toBe("none");
    expect(assignment.browserToolsImage).toBe(
      `registry.factory/browser-tools@sha256:${"a".repeat(64)}`,
    );
    expect(agentProcess.env.FACTORY_BUILD_BROWSER_COMMAND).toBe("/tmp/factory-runtime-connector-2");
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
    expect(JSON.parse(agentProcess.env.FACTORY_OPENCODE_CONFIG).providers.factory.models).toEqual({
      "gpt-5.6-terra": { name: "gpt-5.6-terra" },
      "approved-alternative": { name: "approved-alternative" },
    });
    expect(JSON.stringify(assignment)).not.toContain("FACTORY_FORGEJO_TOKEN");
    expect(JSON.parse(agentProcess.env.FACTORY_OPENCODE_CONFIG).providers.factory.package).toBe(
      "@opencode/ai/providers/openai/chat",
    );
    expect(agentProcess.env.OPENCODE_PASSWORD).toBe("generation-token");
    expect(agentCommand).not.toContain("opencode web");
    expect(agentCommand).toContain("FACTORY_OPENCODE_CONFIG");
    expect(agentCommand).toContain("OPENCODE_DB=/workspace/project/.git/factory-opencode.db");
  });
});
