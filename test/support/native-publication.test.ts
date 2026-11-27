import { expect, spyOn, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { integrationLane } from "../../scripts/testing/lanes";
import { publicationRuntimeProof } from "../fixtures/publication-runtime";

test("native publication is a separate explicit live lane, not an optional Forge component assertion", () => {
  expect(integrationLane("test/integration/native-publication.live.test.ts")).toBe("live");
  expect(integrationLane("test/integration/native-project-releases.test.ts")).toBe("native");
});

test("publication consumes the native runtime fixture before any owned runtime setup", async () => {
  const source = await readFile("test/fixtures/publication-runtime.ts", "utf8");
  expect(source).toContain('from "./runtime-project"');
  expect(source).toContain(
    "const sourceFiles = await configuredRuntimeProjectFiles(input.nativeConfiguration)",
  );
  expect(source).toContain(
    "for (const source of sourceFiles) await file(source.path, source.content)",
  );
  expect(source.indexOf("await configuredRuntimeProjectFiles(")).toBeLessThan(
    source.indexOf("await localOpenBao("),
  );
  expect(source).not.toContain(".devcontainer/");
  expect(source).not.toContain("starter-images.json");
});

test("missing native publication commissioning refuses before database, Forge, Bao or Actor allocation", async () => {
  const spawn = spyOn(Bun, "spawn").mockImplementation(() => {
    throw Error("Uncommissioned publication cannot start subprocesses");
  });
  try {
    await expect(
      publicationRuntimeProof({
        origin: "http://127.0.0.1:1",
        publicOrigin: "",
        nativeConfiguration: "",
        token: "unused-owned-fixture",
        repository: { owner: "owned", name: "publication" },
        forge: {} as Parameters<typeof publicationRuntimeProof>[0]["forge"],
        preserve() {
          throw Error("Uncommissioned publication cannot retain native inventory");
        },
        async captureFailure() {
          throw Error("Uncommissioned publication cannot have native diagnostics");
        },
      }),
    ).rejects.toThrow("explicit configuration and Forge HTTPS origin");
    expect(spawn).not.toHaveBeenCalled();
  } finally {
    spawn.mockRestore();
  }
});
