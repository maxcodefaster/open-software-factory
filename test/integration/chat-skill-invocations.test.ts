import { expect, test } from "bun:test";
import { createSkillController } from "../../apps/factory/src/skills/controller";
import { createSkillRoutes } from "../../apps/factory/src/skills/routes";
import { createChangeAdmission } from "../../apps/factory/src/agent/change-admission";
import { buildModelID, fixture } from "../fixtures/change-agent-turns";

test("chat Skill discovery follows eligible guidance and freezes an existing Change's exact revisions", async () => {
  const owned = await fixture();
  const skills = createSkillController(owned.database);
  const routes = createSkillRoutes(skills);
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
    const invalid = await routes(
      new Request(
        `http://factory.test/api/projects/${owned.projectID}/skills/invocations?role=unknown`,
      ),
      owned.userID,
    );
    expect(invalid?.status).toBe(400);
    const response = await routes(
      new Request(
        `http://factory.test/api/projects/${owned.projectID}/skills/invocations?role=build&change=${owned.changeID}`,
      ),
      owned.userID,
    );
    expect(response?.status).toBe(200);
    expect((await response!.json()).skills).toEqual(planned.skills);
  } finally {
    await owned.dispose();
  }
});
