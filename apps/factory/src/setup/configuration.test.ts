import { expect, test } from "bun:test";
import {
  requiredEnvironmentVariables,
  validateConfiguration,
  validateSetupProposal,
} from "./configuration";
import type { SetupInspectionOutput } from "../../../../packages/project-domain/src/setup";
import { starterFiles } from "./starter";

test("required environment discovery excludes defaults and values", () => {
  expect(
    requiredEnvironmentVariables([
      "${DATABASE_URL:?Required} ${PASSWORD?Required} ${OPTIONAL:-default} ${localEnv:API_KEY}",
    ]),
  ).toEqual(["API_KEY", "DATABASE_URL", "PASSWORD"]);
});

test("imported Compose requests bare substitutions before starting compute", () => {
  expect(
    requiredEnvironmentVariables([
      "environment:\n  DATABASE_URL: ${DATABASE_URL}\n  BETTER_AUTH_SECRET: ${BETTER_AUTH_SECRET}\n  POSTGRES_PASSWORD: ${POSTGRES_PASSWORD}\n  OPTIONAL: ${OPTIONAL:-default}\n  EMPTY: ${EMPTY-default}\n  SHELL: $${RUNTIME_ONLY}\n",
    ]),
  ).toEqual(["BETTER_AUTH_SECRET", "DATABASE_URL", "POSTGRES_PASSWORD"]);
});

test("upstream Dev Container path substitutions are not environment credentials", () => {
  expect(
    requiredEnvironmentVariables([
      "${localWorkspaceFolder} ${localWorkspaceFolderBasename} ${containerWorkspaceFolder} ${containerWorkspaceFolderBasename} ${devcontainerId} ${DATABASE_URL} ${localEnv:API_KEY}",
    ]),
  ).toEqual(["API_KEY", "DATABASE_URL"]);
});

test("Starter configuration validates without AI, including its Compose reference and Verification job", async () => {
  const files = await starterFiles();
  expect(() =>
    validateConfiguration(
      files,
      files.map((file) => file.path),
    ),
  ).not.toThrow();
});
test("assisted Compose proposal must mount the repository into its primary workspace", () => {
  const recipe = {
    path: ".devcontainer/devcontainer.json",
    content: JSON.stringify({
      dockerComposeFile: "compose.yaml",
      service: "app",
      workspaceFolder: "/workspace/project",
    }),
  };
  for (const volumes of [
    [],
    ["data:/workspace/project"],
    ["../src:/workspace/project"],
    ["..:/workspace/project:ro"],
  ]) {
    const compose = {
      path: ".devcontainer/compose.yaml",
      content: JSON.stringify({ services: { app: { image: "node:24", volumes } } }),
    };
    expect(() => validateConfiguration([recipe, compose], [recipe.path, compose.path])).toThrow(
      "mount the repository",
    );
  }
  for (const volume of [
    "..:/workspace/project",
    "../:/workspace/project:cached",
    { type: "bind", source: "..", target: "/workspace/project" },
  ]) {
    const compose = {
      path: ".devcontainer/compose.yaml",
      content: JSON.stringify({ services: { app: { image: "node:24", volumes: [volume] } } }),
    };
    expect(() =>
      validateConfiguration([recipe, compose], [recipe.path, compose.path]),
    ).not.toThrow();
  }
});
test("setup rejects missing recipe files, wrong runners, malformed YAML and unresolved proposals", () => {
  const path = ".devcontainer/devcontainer.json";
  for (const recipe of [
    { build: { dockerfile: "absent.Dockerfile" } },
    { dockerComposeFile: "compose.yaml", service: "app" },
  ])
    expect(() =>
      validateConfiguration(
        [{ path, content: JSON.stringify({ ...recipe, workspaceFolder: "/workspace/project" }) }],
        [path],
      ),
    ).toThrow("unavailable");
  for (const content of [
    "on: push\njobs: {}",
    "on: pull_request\njobs:\n  verify:\n    runs-on: ubuntu-latest\n    steps: [{run: test}]",
    "on: [pull_request\n",
    "on: push\non: pull_request\n",
  ])
    expect(() =>
      validateConfiguration([{ path: ".forgejo/workflows/factory-verification.yml", content }], []),
    ).toThrow();
  const proposal: SetupInspectionOutput = {
    purpose: "App",
    services: [],
    uncertainty: [],
    questions: [{ id: "port", question: "Port?" }],
    files: [{ path: ".factory/system.json", content: "{}" }],
  };
  expect(() => validateSetupProposal(proposal, [])).toThrow("questions");
  expect(() => validateSetupProposal({ ...proposal, questions: [], files: [] }, [])).toThrow(
    "missing",
  );
});
