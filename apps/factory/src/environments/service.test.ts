import { expect, mock, test } from "bun:test";
import { type EnvironmentSettingsView, environmentSettingsView } from "#project-domain/environment";
import { createEnvironmentService } from "./service";

test("environment saves do not admit an image producer or replay committed secret writes", async () => {
  const saved = { version: 1 } as EnvironmentSettingsView;
  const save = mock(async () => saved);
  const prepare = mock(async () => {});
  // Exercise the real save seam with the former producer wired in. A settings
  // save must not admit compute, including when a committed command is retried.
  const service = Reflect.apply(createEnvironmentService, undefined, [
    {
      get: async () => saved,
      discard: async () => saved,
      save,
    },
    prepare,
  ]) as ReturnType<typeof createEnvironmentService>;
  const input = { commandID: crypto.randomUUID(), version: 0, variables: [] };
  expect(await service.save("project", "actor", "development", input)).toBe(saved);
  expect(save).toHaveBeenCalledWith("project", "actor", "development", input);
  expect(prepare).not.toHaveBeenCalled();
  expect(await service.save("project", "actor", "development", input)).toBe(saved);
  expect(await service.save("project", "actor", "main-preview", input)).toBe(saved);
  await service.discard("project", "actor", "development", input.commandID);
  await service.get("project", "actor", "main-preview");
  expect(prepare).not.toHaveBeenCalled();
  save.mockRejectedValueOnce(new Error("Save not confirmed"));
  await expect(service.save("project", "actor", "development", input)).rejects.toThrow(
    "not confirmed",
  );
  expect(prepare).not.toHaveBeenCalled();
});

test("environment settings expose save state, not image-producer state", () => {
  const view: EnvironmentSettingsView = {
    environment: "development",
    version: 1,
    canManage: true,
    storeConfigured: true,
    pending: false,
    pendingCommandID: null,
    variables: [],
  };
  expect(environmentSettingsView.parse(view)).toEqual(view);
  for (const preparation of [null, "pending", "running", "succeeded", "unsupported", "failed"])
    expect(environmentSettingsView.safeParse({ ...view, preparation }).success).toBe(false);
});
