import { expect, test } from "bun:test";
import { fixtureValue } from "../../../test/fixtures/value";
import {
  environmentMetadata,
  environmentWrite,
  parseEnvironmentPaste,
  replaceEnvironment,
} from "./environment";

test("masked metadata never includes values, passwords or certificates", () => {
  const manifest = environmentMetadata({
    variables: [
      { name: "API_KEY", value: "private-value", runtime: true, build: false, verification: false },
    ],
    registries: [
      {
        host: "registry.example.com",
        username: "robot",
        password: "private-password",
        certificate: "private-cert",
        verification: false,
        publish: false,
      },
    ],
  });
  expect(JSON.stringify(manifest)).not.toContain("private-");
  expect(manifest.registries[0]?.hasPassword).toBe(true);
  expect(manifest.registries[0]?.publish).toBe(false);
});

test("registry publication is denied by default and requires an explicit saved choice", () => {
  for (const publish of [undefined, false, true]) {
    const input = environmentWrite.parse({
      commandID: crypto.randomUUID(),
      version: 0,
      variables: [],
      registries: [
        {
          host: "registry.example.com",
          username: "owned-publisher",
          password: "owned-registry-password",
          verification: true,
          publish,
        },
      ],
    });
    const bundle = replaceEnvironment(input, { variables: [], registries: [] });
    expect(bundle.registries[0]?.publish).toBe(publish === true);
    expect(environmentMetadata(bundle).registries[0]?.publish).toBe(publish === true);
  }
});

test("replace-only keeps unspecified values and never grants verification implicitly", () => {
  const input = environmentWrite.parse({
    commandID: crypto.randomUUID(),
    version: 1,
    variables: [{ name: "API_KEY", runtime: true, build: false, verification: false }],
    registries: [],
  });
  const bundle = replaceEnvironment(input, {
    variables: [{ ...fixtureValue(input.variables[0], "input.variables[0]"), value: "retained" }],
    registries: [],
  });
  expect(bundle.variables[0]?.value).toBe("retained");
  expect(bundle.variables[0]?.verification).toBe(false);
  expect(() => replaceEnvironment(input, { variables: [], registries: [] })).toThrow(
    "needs a value",
  );
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

test("writes reject infrastructure variables, duplicate names and registry URLs", () => {
  const input = { commandID: crypto.randomUUID(), version: 0, variables: [], registries: [] };
  expect(
    environmentWrite.safeParse({
      ...input,
      variables: [
        {
          name: "FACTORY_AUTH_SECRET",
          value: "evil",
          runtime: true,
          build: true,
          verification: true,
        },
      ],
    }).success,
  ).toBe(false);
  expect(
    environmentWrite.safeParse({
      ...input,
      registries: [{ host: "https://registry.test/path", username: "", verification: false }],
    }).success,
  ).toBe(false);
});
