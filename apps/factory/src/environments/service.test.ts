import { expect, mock, test } from "bun:test";
import { createEnvironmentService } from "./service";
import type { EnvironmentSettingsView } from "../../../../packages/project-domain/src/environment";

test("only successful environment saves admit preparation, without replaying saved secrets", async () => {
  const saved = { version: 1 } as EnvironmentSettingsView;
  const save = mock(async () => saved);
  const prepare = mock(async () => {});
  const service = createEnvironmentService(
    {
      get: async () => saved,
      discard: async () => saved,
      save,
    },
    prepare,
  );
  const input = { commandID: crypto.randomUUID(), version: 0, variables: [], registries: [] };
  expect(await service.save("project", "actor", "development", input)).toBe(saved);
  expect(save).toHaveBeenCalledWith("project", "actor", "development", input);
  expect(prepare).toHaveBeenCalledWith("project");
  await service.discard("project", "actor", "development", input.commandID);
  await service.get("project", "actor", "main-preview");
  expect(prepare).toHaveBeenCalledTimes(1);
  save.mockRejectedValueOnce(new Error("Save not confirmed"));
  await expect(service.save("project", "actor", "development", input)).rejects.toThrow(
    "not confirmed",
  );
  expect(prepare).toHaveBeenCalledTimes(1);
});
