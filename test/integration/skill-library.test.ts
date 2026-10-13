import { test, expect } from "bun:test";
import { createSkillController } from "../../apps/factory/src/skills/controller";
import { factoryProcess } from "../fixtures/factory-process";
import type { SkillContent } from "../../packages/conversation-domain/src/skills";
import { createAgentTurnStore } from "../../apps/factory/src/agent/turn-store";
import { createProjectAgentController } from "../../apps/factory/src/project-agent/controller";

test("product authors keep a private cross-Project library; managers share exact copies and choices inherit", async () => {
  const fixture = await factoryProcess();
  const database = fixture.connect();
  const admin = "01994a7d-0000-7000-8000-000000000001";
  const author = crypto.randomUUID(),
    collaborator = crypto.randomUUID(),
    project = crypto.randomUUID(),
    secondProject = crypto.randomUUID();
  try {
    await fixture.start();
    for (const [id, name] of [
      [author, "Product author"],
      [collaborator, "Product collaborator"],
    ] as const)
      await database.client`INSERT INTO auth."user"(id,name,email,email_verified) VALUES (${id},${name},${`${id}@factory.local`},true)`;
    for (const id of [project, secondProject]) {
      await database.client`INSERT INTO factory.project(id,slug,name,repository_url,default_branch,devcontainer_path,created_by) VALUES (${id},${`skills-${id}`},'Skill library proof','https://example.invalid/owned.git','main','.devcontainer/devcontainer.json',${admin})`;
      for (const idUser of [author, collaborator])
        await database.client`INSERT INTO factory.project_membership(project_id,user_id,role,manage_project,updated_by) VALUES (${id},${idUser},'product-contributor',${idUser === collaborator},${admin})`;
    }
    const skills = createSkillController(database);
    const initial = await skills.getLibrary(author, project);
    expect(initial.entries).toHaveLength(7);
    const enabled = await database.client.begin((sql) =>
      skills.resolve("planning", sql, { projectID: project, userID: author }),
    );
    expect(enabled).toHaveLength(2);
    const libraryId = crypto.randomUUID(),
      revisionId = crypto.randomUUID();
    const content: SkillContent = {
      key: "corporate-design",
      name: "Corporate design",
      description: "Use for our interfaces",
      instructions: "Use our blue and generous spacing.",
      roles: ["planning", "build"],
      references: [],
    };
    const save = { libraryId, revisionId, expectedRevision: 0, scope: "personal", content };
    await skills.library.save(save, author);
    await skills.library.save(save, author);
    expect(
      (await skills.getLibrary(author, secondProject)).entries.some(
        (entry) => entry.id === libraryId,
      ),
    ).toBe(true);
    expect(
      (await skills.getLibrary(collaborator, project)).entries.some(
        (entry) => entry.id === libraryId,
      ),
    ).toBe(false);
    await expect(skills.library.inspect(revisionId, collaborator, project)).rejects.toThrow(
      "not found",
    );
    await expect(
      skills.library.save({ ...save, revisionId: crypto.randomUUID() }, collaborator),
    ).rejects.toThrow("not found");
    await expect(
      skills.library.save(
        {
          ...save,
          libraryId: crypto.randomUUID(),
          revisionId: crypto.randomUUID(),
          scope: "project",
          projectId: project,
        },
        author,
      ),
    ).rejects.toThrow("manager");
    await skills.chooseLibrary(
      {
        libraryId,
        scope: "personal",
        projectId: project,
        role: "planning",
        state: "enable",
        revisionId,
        expectedVersion: 0,
      },
      author,
      project,
    );
    expect(
      await database.client.begin((sql) =>
        skills.resolve("planning", sql, { projectID: project, userID: author }),
      ),
    ).toContain(revisionId);
    expect(
      await database.client.begin((sql) =>
        skills.resolve("planning", sql, { projectID: secondProject, userID: author }),
      ),
    ).not.toContain(revisionId);
    const conversation = await createProjectAgentController(database, {
      start: async () => null,
    }).setMode(project, undefined, "plan", author);
    if (!conversation) throw new Error("Owned conversation missing");
    const turns = createAgentTurnStore(database);
    await database.client.begin((sql) =>
      turns.admitIn(
        sql,
        {
          kind: "project-message",
          commandId: crypto.randomUUID(),
          projectId: project,
          createdBy: author,
          ticketId: null,
          conversationId: conversation.id,
          text: "Use our corporate guidance.",
        },
        {
          mode: "plan",
          modelId: "controlled",
          conversationVersion: conversation.version,
          skillRevisionIds: [revisionId],
        },
        async () => {},
      ),
    );
    expect(
      (await skills.library.inspect(revisionId, collaborator, project)).content.instructions,
    ).toBe(content.instructions);
    expect(
      (await skills.getLibrary(collaborator, project)).sharedVersions.map((item) => item.id),
    ).toEqual([revisionId]);
    const proposal = crypto.randomUUID();
    await skills.library.propose(proposal, revisionId, "project", project, author);
    expect((await skills.library.inspect(revisionId, collaborator, project)).content).toEqual(
      content,
    );
    const shared = await skills.library.accept(proposal, collaborator);
    expect(await skills.library.accept(proposal, collaborator)).toEqual(shared);
    const sharedEntry = (await skills.getLibrary(collaborator, project)).entries.find(
      (entry) => entry.id === shared.libraryId,
    )!;
    const sharedRevision = sharedEntry.revisions[0]!;
    const nextRevision = crypto.randomUUID();
    await skills.library.save(
      {
        ...save,
        revisionId: nextRevision,
        expectedRevision: 1,
        content: { ...content, instructions: "Use red instead." },
      },
      author,
    );
    expect(
      (await skills.library.inspect(sharedRevision.id, collaborator, project)).content.instructions,
    ).toBe(content.instructions);
    expect(
      (await skills.getLibrary(collaborator, project)).entries.some(
        (entry) => entry.id === libraryId,
      ),
    ).toBe(false);
    await expect(skills.library.inspect(nextRevision, collaborator, project)).rejects.toThrow(
      "not found",
    );
    await skills.chooseLibrary(
      {
        libraryId: shared.libraryId,
        scope: "project",
        projectId: project,
        role: "planning",
        state: "required",
        revisionId: sharedRevision.id,
        expectedVersion: 0,
      },
      collaborator,
      project,
    );
    await expect(
      skills.chooseLibrary(
        {
          libraryId: shared.libraryId,
          scope: "personal",
          projectId: project,
          role: "planning",
          state: "disable",
          revisionId: sharedRevision.id,
          expectedVersion: 0,
        },
        author,
        project,
      ),
    ).rejects.toThrow("required");
    await skills.chooseLibrary(
      {
        libraryId,
        scope: "personal",
        projectId: project,
        role: "planning",
        state: "inherit",
        revisionId,
        expectedVersion: 1,
      },
      author,
      project,
    );
    const effective = await database.client.begin((sql) =>
      skills.resolve("planning", sql, { projectID: project, userID: author }),
    );
    expect(effective).toContain(sharedRevision.id);
    expect(effective).not.toContain(revisionId);
    expect(effective).not.toContain(nextRevision);
    await expect(
      skills.chooseLibrary(
        {
          libraryId,
          scope: "personal",
          projectId: project,
          role: "planning",
          state: "enable",
          revisionId: nextRevision,
          expectedVersion: 1,
        },
        author,
        project,
      ),
    ).rejects.toThrow("elsewhere");
    const inspectLegacy = await skills.getInherited(project, collaborator);
    expect(inspectLegacy.revisions.some((revision) => revision.id === nextRevision)).toBe(false);
  } finally {
    await database.client.end();
    await fixture.dispose();
  }
}, 120000);
