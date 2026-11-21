import { expect, test } from "bun:test";
import { readRequiredEnvironmentVariables } from "./configuration";

test("required variables follow the selected configuration and its declared Compose files", async () => {
  const files: Record<string, string> = {
    "containers/backend.json": `{// selected config\n"dockerComposeFile":["../compose/app.yml"], "containerEnv":{"token":"\${localEnv:APP_TOKEN}"}}`,
    "compose/app.yml": `include: ./shared.yml\nservices:\n  app:\n    environment:\n      REQUIRED: "\${DATABASE:?required}"\n      OPTIONAL: "\${OPTIONAL:-default}"\n    extends:\n      file: ./base.yml\n      service: app\n`,
    "compose/shared.yml": `services:\n  other:\n    environment:\n      VALUE: "\${SHARED}"\n`,
    "compose/base.yml": `services:\n  app:\n    environment:\n      VALUE: "\${BASE}"\n`,
    ".devcontainer/unrelated.json": `{"token":"\${UNRELATED}"}`,
  };
  const reads: string[] = [];
  const result = await readRequiredEnvironmentVariables("containers/backend.json", async (path) => {
    reads.push(path);
    if (!(path in files)) throw new Error("Missing declared configuration");
    return files[path] ?? "";
  });
  expect(result).toEqual(["APP_TOKEN", "BASE", "DATABASE", "SHARED"]);
  expect(reads).not.toContain(".devcontainer/unrelated.json");
});

test("missing, dynamic or out-of-repository references never become an empty successful discovery", async () => {
  for (const file of ["/host/compose.yml", "../../outside.yml", `\${localEnv:COMPOSE_FILE}`])
    await expect(
      readRequiredEnvironmentVariables("containers/dev.json", async () =>
        JSON.stringify({ dockerComposeFile: file }),
      ),
    ).rejects.toThrow("repository-relative");
  await expect(
    readRequiredEnvironmentVariables(".devcontainer/devcontainer.json", async (path) => {
      if (path.endsWith(".json")) return '{"dockerComposeFile":"missing.yml"}';
      throw new Error("Missing declared configuration");
    }),
  ).rejects.toThrow("Missing declared");
});
