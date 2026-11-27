import { expect, test } from "bun:test";
import {
  projectImportOrigins,
  projectImportURL,
  projectSetupSave,
  setupFile,
  setupInspectionOutput,
  setupReadiness,
  setupTask,
} from "./setup";

test("native setup tracks configuration and authorized work, never image production", () => {
  expect(setupTask.options).toEqual([
    "configuration",
    "development-secrets",
    "preview-secrets",
    "protection",
    "hook",
    "wiki",
    "main-preview",
  ]);
  for (const task of ["development", "preview-image"]) {
    expect(setupTask.safeParse(task).success).toBe(false);
    for (const state of ["pending", "running", "ready", "failed"])
      expect(
        setupReadiness.safeParse([
          {
            task,
            state,
            commandID: crypto.randomUUID(),
            operationID: null,
            failure: null,
          },
        ]).success,
      ).toBe(false);
  }
});

test("Git import policy uses exact HTTPS origins and fails closed for an empty allowlist", () => {
  expect(projectImportOrigins()).toEqual([
    "https://github.com",
    "https://gitlab.com",
    "https://codeberg.org",
  ]);
  expect(
    projectImportOrigins(" https://git.enterprise.test:8443/,https://git.enterprise.test:8443 "),
  ).toEqual(["https://git.enterprise.test:8443"]);
  expect(projectImportOrigins("")).toEqual([]);
  for (const value of [
    "http://git.test",
    "https://user:secret@git.test",
    "https://git.test/path",
    "https://git.test?secret",
    "https://*.git.test",
    "https://git.test\nspoof",
  ])
    expect(() => projectImportOrigins(value)).toThrow();
});

test("Git import requires an approved HTTPS forge without credentials or unsafe paths", () => {
  expect(projectImportURL("https://github.com/team/product.git", ["https://github.com"])).toBe(
    "https://github.com/team/product.git",
  );
  for (const url of [
    "http://github.com/a/b",
    "https://key@github.com/a/b",
    "https://github.com/a/b?token=secret",
    "https://127.0.0.1/repo",
    "https://github.com\\@evil.test/repo",
    "https://evil.test/repo",
    "https://github.com/a/%2e%2e/b",
  ])
    expect(() => projectImportURL(url, ["https://github.com"])).toThrow();
});

test("setup persistence cannot include a credential", () => {
  expect(
    projectSetupSave.safeParse({
      id: crypto.randomUUID(),
      version: 1,
      name: "App",
      slug: "app",
      kind: "starter",
      sourceURL: "",
      importToken: "secret",
    }).success,
  ).toBe(false);
});

test.each([
  ".factory/actor-template.json",
  ".factory/system.json",
  ".forgejo/workflows/factory-verification.yml",
  ".factory/images/work/Dockerfile",
  ".factory/images/postgres-18/Dockerfile",
  `.factory/images/${"a".repeat(63)}/Dockerfile`,
])("setup files allow only native configuration and bounded image Dockerfiles: %s", (path) => {
  expect(setupFile.safeParse({ path, content: "bounded file" }).success).toBe(true);
});

test.each([
  ".devcontainer/devcontainer.json",
  ".devcontainer/Dockerfile",
  ".devcontainer/compose.yml",
  ".devcontainer/compose.yaml",
  "compose.yml",
  "Dockerfile",
  ".factory/other.json",
  ".factory/actor-template.json/extra",
  ".factory/actor-template.json\n",
  ".factory/system.json\0",
  "/.factory/actor-template.json",
  "../.factory/actor-template.json",
  ".factory/../.factory/actor-template.json",
  ".factory\\actor-template.json",
  ".factory/images//Dockerfile",
  ".factory/images/../Dockerfile",
  ".factory/images/./Dockerfile",
  ".factory/images/Work/Dockerfile",
  ".factory/images/work_image/Dockerfile",
  ".factory/images/-work/Dockerfile",
  ".factory/images/0work/Dockerfile",
  `.factory/images/\${IMAGE}/Dockerfile`,
  ".factory/images/%2e%2e/Dockerfile",
  `.factory/images/${"a".repeat(64)}/Dockerfile`,
  ".factory/images/work/subdirectory/Dockerfile",
  ".factory/images/work/Dockerfile.dev",
  ".factory/images/work/dockerfile",
  ".factory/images/work/compose.yaml",
  ".forgejo/workflows/unapproved.yml",
])("setup file paths reject legacy, unsafe or out-of-scope writes: %j", (path) => {
  expect(setupFile.safeParse({ path, content: "bounded file" }).success).toBe(false);
});

test("setup files retain strict properties and the content byte bound", () => {
  const path = ".factory/images/work/Dockerfile";
  for (const content of ["a", "a".repeat(64_000), "é".repeat(32_000)])
    expect(setupFile.safeParse({ path, content }).success).toBe(true);
  for (const content of ["", "a".repeat(64_001), "é".repeat(32_001)])
    expect(setupFile.safeParse({ path, content }).success).toBe(false);
  expect(setupFile.safeParse({ path, content: "FROM node:24", overwrite: true }).success).toBe(
    false,
  );
});

test("inspection proposals keep their file, question and service count bounds", () => {
  const output = {
    purpose: "Application",
    services: Array.from({ length: 8 }, (_, index) => ({
      name: `service-${index}`,
      description: "",
      port: null,
    })),
    uncertainty: Array(8).fill("Needs confirmation"),
    questions: Array.from({ length: 5 }, (_, index) => ({
      id: `question-${index}`,
      question: "Which value?",
    })),
    files: Array.from({ length: 6 }, (_, index) => ({
      path: `.factory/images/image-${index}/Dockerfile`,
      content: "FROM node:24",
    })),
  };
  expect(setupInspectionOutput.safeParse(output).success).toBe(true);
  for (const field of ["files", "questions", "services", "uncertainty"] as const) {
    const values = output[field];
    expect(
      setupInspectionOutput.safeParse({ ...output, [field]: [...values, ...values] }).success,
    ).toBe(false);
  }
});
