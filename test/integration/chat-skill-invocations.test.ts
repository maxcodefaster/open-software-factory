import { expect, test } from "bun:test";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createAccessController } from "../../apps/factory/src/access/controller";
import { createChangeAdmission } from "../../apps/factory/src/agent/change-admission";
import { factoryBuildDirectory } from "../../apps/factory/src/build-directory";
import type { FactoryServices } from "../../apps/factory/src/server-functions/context";
import { createServerFunctionEndpoint } from "../../apps/factory/src/server-functions/endpoint";
import { createSkillController } from "../../apps/factory/src/skills/controller";
import { createSkillService } from "../../apps/factory/src/skills/service";
import { buildModelID, fixture } from "../fixtures/change-agent-turns";
import {
  decodeFactoryResponse as decodeResponse,
  factoryFunctionRequest,
} from "../fixtures/server-functions";

test("chat Skill discovery follows eligible guidance and freezes an existing Change's exact revisions", async () => {
  const owned = await fixture();
  const skills = createSkillController(owned.database);
  const entry: typeof import("../../apps/factory/src/start-server") = await import(
    pathToFileURL(resolve(factoryBuildDirectory(), "server/entry.js")).href
  );
  const endpoint = createServerFunctionEndpoint({
    origin: "http://factory.test",
    services: {
      skills: createSkillService(skills, createAccessController(owned.database)),
    } as FactoryServices,
    session: async () => ({ user: { id: owned.userID } }),
    maintenance: async () => false,
    requireFresh: async () => {},
    handle: async (request, options) => entry.default.fetch(request, options),
  });
  const revisionID = crypto.randomUUID();
  const libraryID = crypto.randomUUID();
  const [administrator] = await owned.database.client<{ id: string }[]>`
    SELECT user_id AS id FROM factory.administrator LIMIT 1`;
  if (!administrator) throw new Error("Owned Skill administrator missing");
  try {
    await skills.library.save(
      {
        libraryId: libraryID,
        scope: "system",
        revisionId: revisionID,
        expectedRevision: 0,
        content: {
          key: "owned-chat-review",
          name: "Owned chat review",
          description: "Review the approved interface.",
          roles: ["planning", "build"],
          instructions: "This exact private instruction body is never part of discovery.",
          references: [],
          manualOnly: true,
        },
      },
      administrator.id,
    );
    for (const role of ["planning", "build"])
      await skills.chooseLibrary(
        {
          libraryId: libraryID,
          revisionId: revisionID,
          scope: "system",
          role,
          state: "enable",
          expectedVersion: 0,
        },
        administrator.id,
      );
    const planned = await skills.invocations(owned.projectID, owned.userID, "planning");
    expect(planned.skills).toEqual([
      {
        id: revisionID,
        key: "owned-chat-review",
        name: "Owned chat review",
        description: "Review the approved interface.",
      },
    ]);
    expect(JSON.stringify(planned)).not.toContain("private instruction body");
    const admission = createChangeAdmission(owned.database, buildModelID);
    await admission.admit(owned.changeID, owned.userID, {
      kind: "change-start",
      commandId: crypto.randomUUID(),
    });
    for (const role of ["planning", "build"])
      await skills.chooseLibrary(
        {
          libraryId: libraryID,
          revisionId: revisionID,
          scope: "system",
          role,
          state: "disable",
          expectedVersion: 1,
        },
        administrator.id,
      );
    expect((await skills.invocations(owned.projectID, owned.userID, "planning")).skills).toEqual(
      [],
    );
    expect(
      (await skills.invocations(owned.projectID, owned.userID, "build", owned.changeID)).skills,
    ).toEqual(planned.skills);
    await expect(
      skills.invocations(owned.projectID, owned.userID, "build", crypto.randomUUID()),
    ).rejects.toThrow("Change not found");
    const invalid = await endpoint(
      await factoryFunctionRequest("http://factory.test", "getSkillInvocations", [
        owned.projectID,
        "unknown",
      ]),
    );
    expect(await decodeResponse(invalid)).toMatchObject({ ok: false, status: 400 });
    const response = await endpoint(
      await factoryFunctionRequest("http://factory.test", "getSkillInvocations", [
        owned.projectID,
        "build",
        owned.changeID,
      ]),
    );
    expect(await decodeResponse(response)).toEqual({ ok: true, value: planned });
  } finally {
    await owned.dispose();
  }
});
