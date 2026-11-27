import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { runtimeConnectorTokens, runtimeProjectEntryToken } from "#runtime-domain/identity";
import { nativeProjectTemplate } from "../fixtures/native-project";
import { nativeAdapterTemplate } from "../fixtures/substrate-adapter-native";

const input = {
  secret: "owned-native-secret",
  atespace: "owned-native-adapter",
  attemptID: "0499d521-8027-5134-a09a-7ac6abe6a4b9",
  workspaceID: "8a7329b4-9d65-5593-a2d9-09cb79fe7d0f",
  projectID: "524ab7ca-d644-471b-a143-b2b48a51ce66",
  revision: "a".repeat(40),
  branch: "main",
  connectorURL: "wss://factory.test/internal/runtime-connect",
  repositoryURL: "https://factory.test/internal/runtime-source/owned/capability",
  factoryCA: "-----BEGIN CERTIFICATE-----\nowned-public-ca\n-----END CERTIFICATE-----\n",
  workloadImage: `registry.test/tools@sha256:${"b".repeat(64)}`,
  workerSelector: { "factory.runtime/profile": "owned", "factory.native/owner": "adapter" },
  projectTemplateContent: nativeProjectTemplate.content,
};

test("native adapter fixture renders existing Project containers through production native entrypoints", () => {
  const { template, projectTemplate } = nativeAdapterTemplate(input);
  expect(template.containers.map(({ name }) => name)).toEqual([
    "factory-control",
    "work",
    "database",
  ]);
  expect(template.containers[0]?.command).toEqual([
    "/usr/local/bin/factory-runtime-connector",
    "native-parent",
  ]);
  for (const container of template.containers.slice(1)) {
    expect(container.command).toEqual([
      "/opt/factory-tools/usr/local/bin/factory-runtime-connector",
      "native-project",
    ]);
    expect(container.image).toMatch(/@sha256:[a-f0-9]{64}$/);
    expect(container.securityContext).toEqual({ capabilities: { drop: ["ALL"] } });
  }
  expect(template.workerSelector.matchLabels).toEqual(input.workerSelector);
  expect(template.snapshotConfig.preferredFidelity).toBe("SNAPSHOT_FIDELITY_ROOTFS");
  expect(projectTemplate).toEqual({
    ...nativeProjectTemplate,
    sha256: createHash("sha256").update(input.projectTemplateContent).digest("hex"),
  });
  expect(JSON.stringify(template)).not.toMatch(
    /factory-rootless|\/home\/rootless|\/opt\/native|nsenter|dockerd/,
  );
});

test("native adapter fixture retains exact Source identity and per-container entry authority", () => {
  const { template, projectTemplate } = nativeAdapterTemplate(input);
  const control = template.containers[0];
  if (!control) throw Error("Missing native control");
  const bootstrapEnv = control.env.find(({ name }) => name === "FACTORY_SUBSTRATE_BOOTSTRAP");
  const bootstrap = JSON.parse(bootstrapEnv?.value ?? "null");
  expect(bootstrap.sourceHandoff).toBe(false);
  expect(bootstrap.projectTemplate).toEqual({
    path: projectTemplate.path,
    sha256: projectTemplate.sha256,
  });
  expect(bootstrap.source).toEqual({
    workspaceId: input.workspaceID,
    projectId: input.projectID,
    repositoryUrl: input.repositoryURL,
    originUrl: input.repositoryURL,
    revision: input.revision,
    branch: input.branch,
  });
  expect(bootstrap.assignment).toMatchObject({
    runtimeAttemptId: input.attemptID,
    repositoryIdentity: input.projectID,
    repositoryUrl: input.repositoryURL,
    controlUrl: input.connectorURL,
    environmentVersion: 0,
    workspaceFolder: "/var/lib/factory/source/project",
    connectorStateDir: "/var/lib/factory/control",
    preserveWorkspace: true,
  });
  const tokens = runtimeConnectorTokens(input.secret, input.attemptID, 1);
  for (const container of template.containers.slice(1)) {
    const env = container.env.find(({ name }) => name === "FACTORY_NATIVE_PROJECT");
    const entry = JSON.parse(env?.value ?? "null");
    expect(entry.entryToken).toBe(
      runtimeProjectEntryToken(input.secret, input.attemptID, 1, container.name),
    );
    expect(entry).not.toHaveProperty("parentToken");
    expect(JSON.stringify(entry)).not.toContain(tokens.parent);
    if (container.name === "work") expect(entry.childToken).toBe(tokens.child);
    else {
      expect(entry).not.toHaveProperty("childToken");
      expect(entry.command).toEqual(["/usr/local/bin/docker-entrypoint.sh", "postgres"]);
    }
  }
});

test("native adapter fixture rejects mutable Project images instead of supplying a compatibility image", () => {
  const project = JSON.parse(input.projectTemplateContent);
  project.containers[0].image = "registry.test/work:latest";
  expect(() =>
    nativeAdapterTemplate({ ...input, projectTemplateContent: JSON.stringify(project) }),
  ).toThrow("immutable OCI image");
});

test("native adapter fixture is deterministic and does not mutate frozen inputs", () => {
  const before = structuredClone(input);
  expect(nativeAdapterTemplate(input)).toEqual(nativeAdapterTemplate(input));
  expect(input).toEqual(before);
});
