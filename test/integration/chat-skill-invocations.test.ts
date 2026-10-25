import { expect, test } from "bun:test";
import { createSkillController } from "../../apps/factory/src/skills/controller";
import { createSkillService } from "../../apps/factory/src/skills/service";
import { createAccessController } from "../../apps/factory/src/access/controller";
import { createServerFunctionEndpoint } from "../../apps/factory/src/server-functions/endpoint";
import type { FactoryServices } from "../../apps/factory/src/server-functions/context";
import { factoryBuildDirectory } from "../../apps/factory/src/build-directory";
import { decodeResponse } from "@solidjs/web/server-functions/client";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { factoryFunctionRequest } from "../fixtures/server-functions";
import { createChangeAdmission } from "../../apps/factory/src/agent/change-admission";
import { buildModelID, fixture } from "../fixtures/change-agent-turns";

test("chat Skill discovery follows eligible guidance and freezes an existing Change's exact revisions", async () => {
  const owned = await fixture();
  const skills = createSkillController(owned.database);
  const entry: typeof import("../../apps/factory/src/server-functions/entry") = await import(
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
    handle: entry.handleServerFunctionRequest,
  });
  const revisionID = crypto.randomUUID();
  const [administrator] = await owned.database.client<{ id: string }[]>`
    SELECT user_id AS id FROM factory.administrator LIMIT 1`;
  if (!administrator) throw new Error("Owned Skill administrator missing");
  try {
    await skills.publish(
      {
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
    const empty = { required: [], optional: [], selected: [] };
    const chosen = { required: [], optional: [revisionID], selected: [revisionID] };
    const initial = await skills.getSystem(administrator.id);
    await skills.setSystem(
      {
        version: initial.settings.version,
        planning: chosen,
        build: chosen,
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
    const current = await skills.getSystem(administrator.id);
    await skills.setSystem(
      {
        version: current.settings.version,
        planning: empty,
        build: empty,
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
