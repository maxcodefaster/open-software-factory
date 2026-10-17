import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { requireContainerState } from "./container-state";

test("Compose retains one installation identity and cannot adopt native state", async () => {
  const directory = await mkdtemp(join(tmpdir(), "factory-container-state-"));
  try {
    await expect(requireContainerState(directory, "local")).rejects.toThrow();
    await writeFile(join(directory, "server.json"), "{}");
    await expect(requireContainerState(directory, "factory-compose")).rejects.toThrow(
      "native development state",
    );
    await rm(join(directory, "server.json"));
    await requireContainerState(directory, "factory-compose");
    await expect(requireContainerState(directory, "factory-compose")).resolves.toBeUndefined();
    await expect(requireContainerState(directory, "different-factory")).rejects.toThrow(
      "another Compose installation",
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
