import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  appendOwnedTestCA,
  needsOIDCTestCA,
  needsTheiaTestBuild,
  needsStarterTestDependencies,
  prerequisiteFingerprint,
  productionBuildEnvironment,
  verificationEnvironment,
} from "./test-prerequisites";
import { fixtureValue } from "../../test/fixtures/value";

test("the Playwright Node host can use verification environments without initializing Bun-only build tools", async () => {
  const moduleURL = pathToFileURL(join(import.meta.dirname, "test-prerequisites.ts")).href;
  const child = Bun.spawn(
    [
      "node",
      "--input-type=module",
      "--eval",
      `const {verificationEnvironment, productionBuildEnvironment} = await import(${JSON.stringify(moduleURL)});
console.log(JSON.stringify(productionBuildEnvironment(verificationEnvironment({
  FACTORY_AGENT_QUALITY_LIVE: "1", FACTORY_BUILD_DIRECTORY: "/owned/browser", NODE_ENV: "test"
}))));`,
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  const [stdout, stderr, status] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  expect(stderr).toBe("");
  expect(status).toBe(0);
  expect(JSON.parse(stdout)).toEqual({
    FACTORY_BUILD_DIRECTORY: "/owned/browser",
    NODE_ENV: "production",
  });
});

test("owned frontend builds cannot inherit development transport from Bun's test environment", () => {
  for (const nodeEnvironment of [undefined, "test", "development", "production"]) {
    const parent = {
      NODE_ENV: nodeEnvironment,
      PATH: "/pinned-tools",
      FACTORY_BUILD_DIRECTORY: "/owned/frontend",
    };
    expect(productionBuildEnvironment(parent)).toEqual({
      ...parent,
      NODE_ENV: "production",
    });
    expect(parent.NODE_ENV).toBe(nodeEnvironment);
  }
});

test("only the real local TLS IdP fixture adds its CA to the child process", async () => {
  expect(needsOIDCTestCA('import { oidcProviderFixture } from "../fixtures/oidc-provider";')).toBe(
    true,
  );
  expect(needsOIDCTestCA('const text = "fixtures/oidc-provider";')).toBe(false);
  const directory = await mkdtemp(join(tmpdir(), "factory-test-ca-"));
  const original = join(directory, "existing.pem");
  const certificate =
    "-----BEGIN CERTIFICATE-----\nowned-public-test-ca\n-----END CERTIFICATE-----";
  const env: Record<string, string | undefined> = {
    NODE_EXTRA_CA_CERTS: original,
    UNRELATED: "preserved",
  };
  try {
    await writeFile(original, "existing-public-ca\n");
    await appendOwnedTestCA(env, certificate, directory);
    const bundle = fixtureValue(env["NODE_EXTRA_CA_CERTS"], 'env["NODE_EXTRA_CA_CERTS"]');
    expect(bundle).not.toBe(original);
    expect(await readFile(original, "utf8")).toBe("existing-public-ca\n");
    expect(await readFile(bundle, "utf8")).toContain("existing-public-ca\n");
    expect(await readFile(bundle, "utf8")).toContain(certificate);
    expect(env["NODE_TLS_REJECT_UNAUTHORIZED"]).toBeUndefined();
    expect(env["UNRELATED"]).toBe("preserved");
    await appendOwnedTestCA(env, certificate, directory);
    expect(env["NODE_EXTRA_CA_CERTS"]).toBe(bundle);
    await expect(appendOwnedTestCA(env, "PRIVATE KEY", directory)).rejects.toThrow(
      "public certificates only",
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("both Starter proof entrypoints prepare the template's locked dependencies", () => {
  expect(needsStarterTestDependencies(["test/integration/starter.test.ts"])).toBe(true);
  expect(needsStarterTestDependencies(["test/integration/starter-preview-auth.test.ts"])).toBe(
    true,
  );
  expect(needsStarterTestDependencies(["test/integration/agent-read.test.ts"])).toBe(false);
});

test("ordinary verification strips live model access without mutating the caller's environment", () => {
  const environment = {
    PATH: "/tools",
    FACTORY_MODEL_API_KEY: "synthetic-provider-key",
    FACTORY_PLANNING_MODEL_BASE_URL: "https://provider.example/v1",
    FACTORY_AGENT_QUALITY_LIVE: "1",
    FACTORY_RUN_INDEPENDENT_EDITOR_PROOF: "1",
    FACTORY_LOCAL_PORT: "3000",
  };
  expect(verificationEnvironment(environment)).toEqual({
    PATH: "/tools",
    FACTORY_LOCAL_PORT: "3000",
  });
  expect(environment.FACTORY_MODEL_API_KEY).toBe("synthetic-provider-key");
});

test("only actual editor test imports require the separately locked Theia build", () => {
  expect(
    needsTheiaTestBuild(
      'import URI from "../../deploy/theia-ide/node_modules/@theia/core/lib/common/uri";',
    ),
  ).toBe(true);
  expect(
    needsTheiaTestBuild(
      'import { FactoryWorkspaceFiles } from "../../deploy/theia-ide/factory-ide-extension/lib/browser/factory-workspace-files";',
    ),
  ).toBe(true);
  expect(needsTheiaTestBuild('import { test } from "bun:test";')).toBe(false);
  expect(needsTheiaTestBuild("const identity = async <T>(value: T): Promise<T> => value;")).toBe(
    false,
  );
  expect(
    needsTheiaTestBuild(
      "const example = 'import URI from \"../../deploy/theia-ide/node_modules/example\";';",
    ),
  ).toBe(false);
});

test("test prerequisite fingerprints cover source content and names without depending on enumeration order", () => {
  const inputs = [
    { path: "package-lock.json", content: "locked" },
    { path: "adapter.ts", content: "source" },
  ];
  expect(prerequisiteFingerprint(inputs)).toBe(prerequisiteFingerprint([...inputs].reverse()));
  expect(prerequisiteFingerprint(inputs)).not.toBe(
    prerequisiteFingerprint([
      fixtureValue(inputs[0], "inputs[0]"),
      { path: "adapter.ts", content: "changed" },
    ]),
  );
  expect(prerequisiteFingerprint(inputs)).not.toBe(
    prerequisiteFingerprint([
      fixtureValue(inputs[0], "inputs[0]"),
      { path: "other.ts", content: "source" },
    ]),
  );
});
