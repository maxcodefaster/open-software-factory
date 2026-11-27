import { expect, test } from "bun:test";
import { readRequiredEnvironmentVariables } from "./configuration";

function nativeTemplate(value?: string) {
  return {
    containers: [
      {
        name: "work",
        image: `registry.example.test/work@sha256:${"a".repeat(64)}`,
        ...(value === undefined ? {} : { env: [{ name: "APP_VALUE", value }] }),
        volumeMounts: [{ name: "source", mountPath: "/workspaces/project" }],
      },
      {
        name: "postgres",
        image: `registry.example.test/postgres@sha256:${"b".repeat(64)}`,
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

test.each([".factory/actor-template.json", "environments/backend.json"])(
  "required-variable discovery reads exactly the selected native template %s",
  async (selected) => {
    const files: Record<string, string> = {
      [selected]: JSON.stringify(nativeTemplate("postgres://postgres/project?currency=$literal")),
      ".factory/unselected.json": "{",
      ".devcontainer/devcontainer.json": `{"containerEnv":{"TOKEN":"\${localEnv:APP_TOKEN}"}}`,
      ".devcontainer/compose.yaml": `include: ../outside.yml\nservices: \${LEGACY}`,
      ".env": "TOKEN=not-to-be-read",
    };
    const reads: string[] = [];
    const result = await readRequiredEnvironmentVariables(selected, async (path) => {
      reads.push(path);
      if (!(path in files)) throw new Error("Missing selected template");
      return files[path] ?? "";
    });
    expect(result).toEqual([]);
    expect(reads).toEqual([selected]);
  },
);

test("a native template without env entries needs no discovered variables", async () => {
  expect(
    await readRequiredEnvironmentVariables(".factory/actor-template.json", async () =>
      JSON.stringify(nativeTemplate()),
    ),
  ).toEqual([]);
});

test.each([
  `\${DATABASE_URL}`,
  `\${DATABASE_URL:?required}`,
  `\${DATABASE_URL?required}`,
  `\${OPTIONAL:-default}`,
  `\${EMPTY-default}`,
  `\${localEnv:APP_TOKEN}`,
  `\${localWorkspaceFolder}`,
  `$\${ESCAPED}`,
  "$(read-secret)",
])("native env value %s is not interpreted as interpolation", async (value) => {
  for (const name of ["work", "postgres"]) {
    const template = nativeTemplate();
    for (const container of template.containers)
      if (container.name === name)
        Object.assign(container, { env: [{ name: "APP_VALUE", value }] });
    const reads: string[] = [];
    await expect(
      readRequiredEnvironmentVariables(".factory/actor-template.json", async (path) => {
        reads.push(path);
        return JSON.stringify(template);
      }),
    ).rejects.toThrow("Configure Project Environments or use literal values");
    expect(reads).toEqual([".factory/actor-template.json"]);
  }
});

test("JSON-escaped interpolation is checked after native template parsing", async () => {
  const content = JSON.stringify(nativeTemplate(`\${TOKEN}`)).replace(
    `\${TOKEN}`,
    "\\u0024{TOKEN}",
  );
  await expect(
    readRequiredEnvironmentVariables(".factory/actor-template.json", async () => content),
  ).rejects.toThrow("interpolation is not supported");
});

test.each([
  "",
  ".",
  "..",
  "/host/actor-template.json",
  "//host/actor-template.json",
  "../actor-template.json",
  ".factory/../../outside.json",
  ".factory/../actor-template.json",
  "./.factory/actor-template.json",
  ".factory//actor-template.json",
  `\${localEnv:ACTOR_TEMPLATE}`,
  "$(select-template)",
  ".factory\\actor-template.json",
  "C:/host/actor-template.json",
  "https://example.test/actor-template.json",
  ".factory/%2e%2e/actor-template.json",
  ".factory/actor-template.json?token=value",
  ".factory/actor-template.json#fragment",
  ".factory/actor-template.json\n",
  ".factory/actor\0-template.json",
  ".factory/actor\u007f-template.json",
  "a".repeat(501),
])("unsafe or unbounded selected path %j is rejected before any read", async (path) => {
  const reads: string[] = [];
  await expect(
    readRequiredEnvironmentVariables(path, async (selected) => {
      reads.push(selected);
      return JSON.stringify(nativeTemplate());
    }),
  ).rejects.toThrow("fixed repository-relative ActorTemplate path");
  expect(reads).toEqual([]);
});

test("missing selected templates never become an empty successful discovery", async () => {
  const reads: string[] = [];
  await expect(
    readRequiredEnvironmentVariables(".factory/actor-template.json", async (path) => {
      reads.push(path);
      throw new Error("Missing selected template");
    }),
  ).rejects.toThrow("Missing selected template");
  expect(reads).toEqual([".factory/actor-template.json"]);
});

test.each([
  "{",
  "// JSONC\n{}",
  '{"image":"node:24"}',
  '{"dockerComposeFile":"../compose.yml","service":"app"}',
  '{"include":"../outside.yml","services":{}}',
  JSON.stringify({ ...nativeTemplate(), include: "../outside.json" }),
  JSON.stringify({ ...nativeTemplate(), extends: { file: "../outside.json" } }),
])(
  "invalid or legacy selected templates fail without following references: %s",
  async (content) => {
    const reads: string[] = [];
    await expect(
      readRequiredEnvironmentVariables(".factory/actor-template.json", async (path) => {
        reads.push(path);
        return content;
      }),
    ).rejects.toThrow("Project ActorTemplate");
    expect(reads).toEqual([".factory/actor-template.json"]);
  },
);

test("discovery validates the native schema even when all env values are literals", async () => {
  const template = nativeTemplate("literal");
  for (const container of template.containers) Object.assign(container, { privileged: true });
  await expect(
    readRequiredEnvironmentVariables(".factory/actor-template.json", async () =>
      JSON.stringify(template),
    ),
  ).rejects.toThrow("Project ActorTemplate");
});

test("selected-template reads retain the 64000-byte bound, including multibyte content", async () => {
  const content = JSON.stringify(nativeTemplate());
  expect(
    await readRequiredEnvironmentVariables(".factory/actor-template.json", async () =>
      content.padEnd(64_000),
    ),
  ).toEqual([]);
  for (const oversized of [
    content.padEnd(64_001),
    JSON.stringify(nativeTemplate("é".repeat(32_000))),
    " ".repeat(65_537),
  ]) {
    const reads: string[] = [];
    await expect(
      readRequiredEnvironmentVariables(".factory/actor-template.json", async (path) => {
        reads.push(path);
        return oversized;
      }),
    ).rejects.toThrow("size bound");
    expect(reads).toEqual([".factory/actor-template.json"]);
  }
});
