import { expect, test } from "bun:test";
import { fixtureValue } from "../../../test/fixtures/value";
import {
  environmentBundle,
  environmentManifest,
  environmentMetadata,
  environmentSettingsView,
  environmentWrite,
  parseEnvironmentPaste,
  replaceEnvironment,
} from "./environment";

test("native Environment parse seams accept only Runtime and Verification variables", () => {
  const metadata = { name: "NPM_TOKEN", runtime: true, verification: false };
  const command = { commandID: crypto.randomUUID(), version: 0 };
  const state = {
    environment: "development" as const,
    version: 0,
    canManage: true,
    storeConfigured: true,
    pending: false,
    pendingCommandID: null,
  };
  const manifest = { variables: [metadata] };
  const bundle = { variables: [{ ...metadata, value: "protected-token" }] };
  const write = { ...command, ...bundle };
  const view = { ...state, ...manifest };
  expect(environmentManifest.parse(manifest)).toEqual(manifest);
  expect(environmentBundle.parse(bundle)).toEqual(bundle);
  expect(environmentWrite.parse(write)).toEqual(write);
  expect(environmentSettingsView.parse(view)).toEqual(view);
});

test("native Environment parse seams reject retired fields even when empty or false", () => {
  const metadata = { name: "TOKEN", runtime: true, verification: false };
  const state = {
    environment: "development",
    version: 0,
    canManage: true,
    storeConfigured: true,
    pending: false,
    pendingCommandID: null,
  };
  for (const [schema, input] of [
    [environmentManifest, { variables: [metadata] }],
    [
      environmentWrite,
      {
        commandID: crypto.randomUUID(),
        version: 0,
        variables: [{ ...metadata, value: "protected" }],
      },
    ],
    [environmentBundle, { variables: [{ ...metadata, value: "protected" }] }],
    [environmentSettingsView, { ...state, variables: [metadata] }],
  ] as const) {
    expect(schema.safeParse(input).success).toBe(true);
    for (const registries of [
      [],
      [{ host: "registry.test", username: "robot", verification: false }],
    ])
      expect(schema.safeParse({ ...input, registries }).success).toBe(false);
    for (const build of [false, true]) {
      expect(schema.safeParse({ ...input, build }).success).toBe(false);
      expect(
        schema.safeParse({
          ...input,
          variables: input.variables.map((variable) => ({ ...variable, build })),
        }).success,
      ).toBe(false);
    }
  }
});

test("masked metadata never includes protected values", () => {
  const manifest = environmentMetadata({
    variables: [{ name: "API_KEY", value: "private-value", runtime: true, verification: false }],
  });
  expect(JSON.stringify(manifest)).not.toContain("private-");
  expect(manifest).toEqual({
    variables: [{ name: "API_KEY", runtime: true, verification: false }],
  });
  expect(
    environmentManifest.safeParse({
      variables: [{ ...manifest.variables[0], value: "private-value" }],
    }).success,
  ).toBe(false);
  expect(
    environmentSettingsView.safeParse({
      ...manifest,
      environment: "development",
      version: 0,
      canManage: true,
      storeConfigured: true,
      pending: false,
      pendingCommandID: null,
      variables: [{ ...manifest.variables[0], value: "private-value" }],
    }).success,
  ).toBe(false);
});

test("replace-only keeps unspecified values and never grants verification implicitly", () => {
  const input = environmentWrite.parse({
    commandID: crypto.randomUUID(),
    version: 1,
    variables: [{ name: "API_KEY", runtime: true, verification: false }],
  });
  const bundle = replaceEnvironment(input, {
    variables: [{ ...fixtureValue(input.variables[0], "input.variables[0]"), value: "retained" }],
  });
  expect(bundle.variables[0]?.value).toBe("retained");
  expect(bundle.variables[0]?.verification).toBe(false);
  expect(() => replaceEnvironment(input, { variables: [] })).toThrow("needs a value");
});

test("replace-only updates values and grants explicitly and removes omitted variables", () => {
  const previous = environmentBundle.parse({
    variables: [
      { name: "NPM_TOKEN", value: "old-token", runtime: true, verification: false },
      { name: "REMOVED", value: "remove-token", runtime: true, verification: true },
    ],
  });
  const input = environmentWrite.parse({
    commandID: crypto.randomUUID(),
    version: 2,
    variables: [
      { name: "NPM_TOKEN", value: "new-token", runtime: true, verification: true },
      { name: "NEW_TOKEN", value: "", runtime: false, verification: false },
    ],
  });
  expect(replaceEnvironment(input, previous)).toEqual(
    environmentBundle.parse({ variables: input.variables }),
  );
  expect(previous.variables[0]?.value).toBe("old-token");
  expect(previous.variables).toHaveLength(2);
});

test("literal env import supports multiline and does not execute expansion", () => {
  expect(
    parseEnvironmentPaste(
      'export URL=https://example.com\nKEY="first\nsecond"\nLITERAL=$(whoami) # ignored',
    ),
  ).toEqual([
    { name: "URL", value: "https://example.com" },
    { name: "KEY", value: "first\nsecond" },
    { name: "LITERAL", value: "$(whoami)" },
  ]);
  expect(() => parseEnvironmentPaste("KEY=a\nKEY=b")).toThrow("Duplicate");
  expect(() => parseEnvironmentPaste("PATH=/evil")).toThrow();
  expect(() => parseEnvironmentPaste('KEY="unterminated')).toThrow("Unclosed");
});

test("writes reject infrastructure variables, duplicate names and implicit grants", () => {
  const input = { commandID: crypto.randomUUID(), version: 0, variables: [] };
  expect(
    environmentWrite.safeParse({
      ...input,
      variables: [
        {
          name: "FACTORY_AUTH_SECRET",
          value: "evil",
          runtime: true,
          verification: true,
        },
      ],
    }).success,
  ).toBe(false);
  expect(
    environmentWrite.safeParse({
      ...input,
      variables: [
        { name: "NPM_TOKEN", value: "first", runtime: true, verification: false },
        { name: "NPM_TOKEN", value: "second", runtime: true, verification: true },
      ],
    }).success,
  ).toBe(false);
  for (const variable of [
    { name: "NPM_TOKEN", value: "token", verification: false },
    { name: "NPM_TOKEN", value: "token", runtime: true },
  ])
    expect(environmentWrite.safeParse({ ...input, variables: [variable] }).success).toBe(false);
});
