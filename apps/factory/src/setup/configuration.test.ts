import { expect, test } from "bun:test";
import type { SetupInspectionOutput } from "#project-domain/setup";
import {
  configurationPath,
  requiredConfiguration,
  SetupConfigurationError,
  setupConfigurationFeedback,
  validateConfiguration,
  validateSetupProposal,
} from "./configuration";

const templatePath = ".factory/actor-template.json";
const workflowPath = ".forgejo/workflows/factory-verification.yml";
const digest = "a".repeat(64);

function nativeTemplate() {
  return {
    containers: [
      {
        name: "work",
        image: `registry.example.test/work@sha256:${digest}`,
        env: [{ name: "DATABASE_URL", value: "postgres://postgres/project" }],
        volumeMounts: [{ name: "source", mountPath: "/workspaces/project" }],
      },
      {
        name: "postgres",
        image: `registry.example.test/postgres@sha256:${digest}`,
        command: ["/usr/local/bin/docker-entrypoint.sh", "postgres"],
        env: [{ name: "PGDATA", value: "/data/pgdata" }],
        volumeMounts: [{ name: "database", mountPath: "/data" }],
      },
    ],
    volumes: [
      { name: "source", durableDir: {} },
      { name: "database", durableDir: {} },
    ],
  };
}

function configurationFiles() {
  return [
    { path: templatePath, content: JSON.stringify(nativeTemplate()) },
    {
      path: ".factory/system.json",
      content: JSON.stringify({
        version: 1,
        primaryApp: "web",
        apps: [
          {
            id: "web",
            label: "Web",
            command: ["bun", "run", "dev"],
            port: 4321,
            healthPath: "/health",
          },
        ],
      }),
    },
    {
      path: workflowPath,
      content:
        "on: pull_request\njobs:\n  verify:\n    runs-on: factory-verification\n    steps:\n      - run: bun test\n",
    },
  ];
}

function proposal(): SetupInspectionOutput {
  return {
    purpose: "Web application with PostgreSQL",
    services: [
      { name: "web", description: "Application", port: 4321 },
      { name: "postgres", description: "Database", port: 5432 },
    ],
    uncertainty: [],
    questions: [],
    files: configurationFiles(),
  };
}

function validateTemplate(value: unknown) {
  validateConfiguration([{ path: templatePath, content: JSON.stringify(value) }], []);
}

test("native work and PostgreSQL setup validates without Starter files or live resources", () => {
  const files = configurationFiles();
  expect(requiredConfiguration).toEqual([templatePath, ".factory/system.json", workflowPath]);
  expect(() =>
    validateConfiguration(
      files,
      files.map((file) => file.path),
    ),
  ).not.toThrow();
  expect(() => validateSetupProposal(proposal(), [])).not.toThrow();
});

test("setup allows bounded ordinary image Dockerfiles without translating or building them", () => {
  const output = proposal();
  for (const name of ["work", "postgres-18", "tools"])
    output.files.push({
      path: `.factory/images/${name}/Dockerfile`,
      content: "FROM node:24\nRUN echo project-image\n",
    });
  const before = structuredClone(output);
  expect(() => validateSetupProposal(output, [])).not.toThrow();
  expect(output).toEqual(before);
});

test.each([
  { image: "node:24" },
  { build: { dockerfile: "Dockerfile" } },
  { dockerComposeFile: "compose.yaml", service: "app" },
  { services: { app: { image: "node:24" } } },
])("legacy definitions are not native ActorTemplates: %j", (value) => {
  expect(() => validateTemplate(value)).toThrow("Project ActorTemplate");
});

test.each([
  "metadata",
  "workerSelector",
  "placement",
  "resources",
  "snapshotConfig",
  "build",
  "include",
])("setup delegates unsupported template field %s to the native adapter", (field) => {
  expect(() => validateTemplate({ ...nativeTemplate(), [field]: {} })).toThrow(
    "Project ActorTemplate",
  );
});

test.each(["privileged", "securityContext", "devices", "ports", "build", "depends_on", "unknown"])(
  "setup rejects unsupported container field %s",
  (field) => {
    const template = nativeTemplate();
    for (const container of template.containers) Object.assign(container, { [field]: true });
    expect(() => validateTemplate(template)).toThrow("Project ActorTemplate");
  },
);

test.each([{ args: ["--serve"] }, { wakeupProbe: { httpGet: { path: "/ready", port: 4321 } } }])(
  "Factory retains work readiness and requires explicit preparation argv: %j",
  (fields) => {
    const template = nativeTemplate();
    for (const container of template.containers)
      if (container.name === "work") Object.assign(container, fields);
    expect(() => validateTemplate(template)).toThrow();
  },
);
test("native work preparation argv is preserved for the Source-gated entrypoint", () => {
  const template = nativeTemplate();
  Object.assign(template.containers[0]!, {
    command: ["/bin/sh", "-ec"],
    args: ["npm ci && npm run db:migrate"],
  });
  const files = [{ path: templatePath, content: JSON.stringify(template) }];
  const before = structuredClone(files);
  expect(() => validateConfiguration(files, [])).not.toThrow();
  expect(files).toEqual(before);
});

test("native services require digest-pinned images and explicit entrypoint commands", () => {
  for (const name of ["work", "postgres"]) {
    const template = nativeTemplate();
    for (const container of template.containers)
      if (container.name === name) container.image = "postgres:18";
    expect(() => validateTemplate(template)).toThrow("immutable OCI image digest");
  }
  const template = nativeTemplate();
  for (const container of template.containers)
    if (container.name === "postgres") Reflect.deleteProperty(container, "command");
  expect(() => validateTemplate(template)).toThrow("explicit entrypoint");
});

test.each(["/work/../escape", "/", "/opt/factory/source"])(
  "setup rejects unsafe native source mount %s",
  (mountPath) => {
    const template = nativeTemplate();
    for (const container of template.containers)
      if (container.name === "work") container.volumeMounts = [{ name: "source", mountPath }];
    expect(() => validateTemplate(template)).toThrow("mount path");
  },
);

test("setup requires the declared durable source mount and rejects host/external references", () => {
  const template = nativeTemplate();
  for (const container of template.containers)
    if (container.name === "work")
      container.volumeMounts = [{ name: "missing", mountPath: "/workspaces/project" }];
  expect(() => validateTemplate(template)).toThrow("source exactly once");
  for (const field of ["hostPath", "external", "image"]) {
    const template = nativeTemplate();
    for (const volume of template.volumes) Object.assign(volume, { [field]: "/host/source" });
    expect(() => validateTemplate(template)).toThrow("Project ActorTemplate");
  }
});

test.each([`\${DATABASE_URL}`, `\${OPTIONAL:-default}`, "$(read-secret)", `$\${ESCAPED}`])(
  "setup rejects env interpolation instead of proposing a silently broken template: %s",
  (value) => {
    const template = nativeTemplate();
    for (const container of template.containers) container.env = [{ name: "APP_VALUE", value }];
    expect(() => validateTemplate(template)).toThrow(
      "Configure Project Environments or use literal values",
    );
  },
);

test.each(["{", '{ "containers": [], }', "// JSONC\n{}"])(
  "the native template requires strict JSON: %s",
  (content) => {
    expect(() => validateConfiguration([{ path: templatePath, content }], [])).toThrow(
      "valid JSON",
    );
  },
);

test("configuration paths use the domain allowlist, not Dev Container or Compose paths", () => {
  for (const path of [...requiredConfiguration, ".factory/images/work-24/Dockerfile"])
    expect(configurationPath(path)).toBe(true);
  for (const path of [
    ".devcontainer/devcontainer.json",
    ".devcontainer/Dockerfile",
    ".devcontainer/compose.yaml",
    "compose.yml",
    "../.factory/actor-template.json",
    ".factory/images/../Dockerfile",
    ".factory/images/Work/Dockerfile",
    ".factory/images/work/compose.yml",
    ".factory/images/work/Dockerfile\n",
  ]) {
    expect(configurationPath(path)).toBe(false);
    expect(() => validateConfiguration([{ path, content: "{}" }], [path])).toThrow();
  }
});

test("configuration and proposal validation retain file count and byte bounds", () => {
  for (const path of [...requiredConfiguration, ".factory/images/work/Dockerfile"])
    for (const content of ["", "a".repeat(64_001), "é".repeat(32_001)])
      expect(() => validateConfiguration([{ path, content }], [path])).toThrow();
  const output = proposal();
  output.files.push(
    ...["work", "database", "tools", "extra"].map((name) => ({
      path: `.factory/images/${name}/Dockerfile`,
      content: "FROM node:24\n",
    })),
  );
  expect(() => validateConfiguration(output.files, [])).toThrow();
  expect(() => validateSetupProposal(output, [])).toThrow();
});

test.each(["pull_request", "[push, pull_request]", "{ pull_request: {} }"])(
  "Verification keeps its supported pull-request trigger %s",
  (trigger) => {
    const content = `on: ${trigger}\njobs:\n  verify:\n    runs-on: factory-verification\n    steps: [{run: bun test}]\n`;
    expect(() => validateConfiguration([{ path: workflowPath, content }], [])).not.toThrow();
  },
);

test.each([
  "on: push\njobs: {}",
  "on: [push]\njobs: {}",
  "on: {push: {}}\njobs: {}",
  "on: pull_request\njobs: {}",
  "on: pull_request\njobs:\n  verify:\n    runs-on: ubuntu-latest\n    steps: [{run: bun test}]",
  "on: pull_request\njobs:\n  verify:\n    runs-on: factory-verification\n    steps: []",
  "on: pull_request\njobs:\n  verify:\n    runs-on: factory-verification\n    steps: [{uses: actions/checkout}]",
  "on: pull_request\njobs:\n  first: &job\n    runs-on: factory-verification\n    steps: [{run: bun test}]\n  second: *job",
  "on: [pull_request\n",
  "on: push\non: pull_request\njobs: {}",
])("Verification rejects wrong triggers/runners/jobs or malformed YAML: %s", (content) => {
  expect(() => validateConfiguration([{ path: workflowPath, content }], [])).toThrow();
});

test("Verification YAML alias expansion stays bounded", () => {
  const content = `on: pull_request\nrepeated: &value test\nvalues: [${Array(21).fill("*value").join(",")}]\njobs:\n  verify:\n    runs-on: factory-verification\n    steps: [{run: bun test}]`;
  expect(() => validateConfiguration([{ path: workflowPath, content }], [])).toThrow("alias count");
});

test("system contract validation remains required", () => {
  for (const content of ["{", "{}", '{"version": 1, "primaryApp": "web", "apps": []}'])
    expect(() => validateConfiguration([{ path: ".factory/system.json", content }], [])).toThrow();
});

test("proposals cannot overwrite existing files or propose duplicate paths", () => {
  for (const file of configurationFiles()) {
    const output = proposal();
    const before = structuredClone(output);
    expect(() => validateSetupProposal(output, [file.path])).toThrow("cannot overwrite");
    expect(output).toEqual(before);
  }
  const output = proposal();
  output.files.push({ path: templatePath, content: JSON.stringify(nativeTemplate()) });
  expect(() => validateSetupProposal(output, [])).toThrow("cannot overwrite");
});

test("open questions cannot be combined with configuration files", () => {
  const output = proposal();
  output.questions = [{ id: "port", question: "Which port should the App use?" }];
  expect(() => validateSetupProposal(output, [])).toThrow("Resolve open questions");
  expect(() => validateSetupProposal({ ...output, files: [] }, [])).not.toThrow();
});

test("each missing native configuration file needs a proposal unless it already exists", () => {
  for (const path of requiredConfiguration) {
    const output = proposal();
    output.files = output.files.filter((file) => file.path !== path);
    expect(() => validateSetupProposal(output, [])).toThrow(SetupConfigurationError);
    expect(() => validateSetupProposal(output, [path])).not.toThrow();
  }
  expect(() =>
    validateSetupProposal({ ...proposal(), files: [] }, [
      ".devcontainer/devcontainer.json",
      ".devcontainer/compose.yaml",
    ]),
  ).toThrow("missing required files");
  expect(() =>
    validateSetupProposal({ ...proposal(), files: [] }, requiredConfiguration),
  ).not.toThrow();
});

test("only known missing-configuration feedback is eligible for a retry", () => {
  const output = { ...proposal(), files: [] };
  try {
    validateSetupProposal(output, []);
    throw new Error("Missing required files must fail");
  } catch (error) {
    expect(error).toBeInstanceOf(SetupConfigurationError);
    if (!(error instanceof SetupConfigurationError)) throw error;
    expect(setupConfigurationFeedback(error.recovery)).toBe(error.recovery);
    expect(error.recovery).toContain("Answers and source are unchanged");
  }
  for (const failure of [null, "", "Unknown failure", "Project ActorTemplate is invalid"])
    expect(setupConfigurationFeedback(failure)).toBeUndefined();
});
