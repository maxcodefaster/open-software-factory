import { expect, test } from "bun:test";
import { createSkillService } from "./service";
import type { createSkillController } from "./controller";
import { CommandError } from "../command-error";

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

test("inherited Skill and administration operations retain the former HTTP authority gates", async () => {
  let effects = 0;
  const controller = {
    getInherited: async () => effects++,
    setProject: async () => effects++,
    setPersonal: async () => effects++,
    getSystem: async () => effects++,
    publish: async () => effects++,
    setSystem: async () => effects++,
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
  const role = { required: [], optional: null, selected: null };
  for (const action of [
    () => service.inherited(actor, project),
    () => service.saveProject(actor, project, { version: 0, planning: role, build: role }),
    () => service.savePersonal(actor, project, { version: 0, planning: null, build: null }),
  ])
    await expect(action()).rejects.toMatchObject({ status: 404 });
  const empty = { required: [], optional: [], selected: [] };
  for (const action of [
    () => service.system(actor),
    () => service.saveSystem(actor, { version: 0, planning: empty, build: empty }),
    () => service.setPublication(actor, crypto.randomUUID(), false),
  ])
    await expect(action()).rejects.toMatchObject({ status: 403 });
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

test("an unconfirmed Skill publication is not a successful or invalid command", async () => {
  const service = createSkillService(
    { publish: async () => undefined } as unknown as ReturnType<typeof createSkillController>,
    { requireProject: async () => {}, requireSystemManager: async () => {} },
  );
  await expect(
    service.publish(crypto.randomUUID(), {
      revisionId: crypto.randomUUID(),
      expectedRevision: 0,
      content: {
        key: "owned-test",
        name: "Owned test",
        description: "Test publication",
        roles: ["build"],
        instructions: "Test only",
        references: [],
      },
    }),
  ).rejects.toMatchObject({ status: 503 });
});
