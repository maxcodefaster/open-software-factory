import { expect, test } from "bun:test";
import {
  needsTheiaTestBuild,
  prerequisiteFingerprint,
  verificationEnvironment,
} from "./test-prerequisites";

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
    prerequisiteFingerprint([inputs[0]!, { path: "adapter.ts", content: "changed" }]),
  );
  expect(prerequisiteFingerprint(inputs)).not.toBe(
    prerequisiteFingerprint([inputs[0]!, { path: "other.ts", content: "source" }]),
  );
});
