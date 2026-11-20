import { expect, test } from "bun:test";
import { CommandError } from "../command-error";
import type { createSkillController } from "./controller";
import { createSkillService } from "./service";

test("Skill library serializes validated DTOs rather than PostgreSQL row metadata", async () => {
  const proposals = Object.assign([], { count: 0, command: "SELECT", statement: "private SQL" });
  const service = createSkillService(
    {
      getLibrary: async () => ({
        sharedVersions: [],
        entries: [],
        choices: [],
        proposals,
        canManageProject: false,
        canManageSystem: false,
        privateField: "not a DTO",
      }),
    } as unknown as ReturnType<typeof createSkillController>,
    { requireProject: async () => {}, requireSystemManager: async () => {} },
  );
  const value = await service.library(crypto.randomUUID());
  expect(value.proposals).toEqual([]);
  expect(Object.keys(value.proposals)).toEqual([]);
  expect(JSON.stringify(value)).not.toMatch(/SELECT|private/);
});

test("Skill invocations and publication retain membership and administrator gates", async () => {
  let effects = 0;
  const controller = {
    invocations: async () => effects++,
    setPublication: async () => effects++,
  } as unknown as ReturnType<typeof createSkillController>;
  const service = createSkillService(controller, {
    requireProject: async () => {
      throw new CommandError("not-found", "Project not found");
    },
    requireSystemManager: async () => {
      throw new CommandError("forbidden", "Manager required");
    },
  });
  const actor = crypto.randomUUID(),
    project = crypto.randomUUID();
  await expect(service.invocations(actor, project, "planning")).rejects.toMatchObject({
    status: 404,
  });
  await expect(service.setPublication(actor, crypto.randomUUID(), false)).rejects.toMatchObject({
    status: 403,
  });
  expect(effects).toBe(0);
});

test("Skill import validation stays a useful input error and does not hide authority loss", async () => {
  let cause: Error = new Error("Choose a package containing a text SKILL.md at its root");
  const service = createSkillService(
    {
      library: {
        preview: async () => {
          throw cause;
        },
      },
    } as unknown as ReturnType<typeof createSkillController>,
    { requireProject: async () => {}, requireSystemManager: async () => {} },
  );
  const input = { files: [{ path: "README.md", body: "No Skill", encoding: "utf8" as const }] };
  await expect(service.previewImport(crypto.randomUUID(), input)).rejects.toMatchObject({
    status: 400,
    message: cause.message,
  });
  cause = new CommandError("forbidden", "Account is disabled");
  await expect(service.previewImport(crypto.randomUUID(), input)).rejects.toBe(cause);
});
