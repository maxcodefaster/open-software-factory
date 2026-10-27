import { expect, test } from "bun:test";
import { createMCPLibrary } from "../../apps/factory/src/mcp/controller";
import { createSkillController } from "../../apps/factory/src/skills/controller";
import {
  defaultLibraryCover,
  libraryCoverCatalog,
} from "../../packages/conversation-domain/src/library-covers";
import { factoryProcess } from "../fixtures/factory-process";
import { fixtureValue } from "../fixtures/value";

test("library covers persist separately, enforce owning-scope authority and never reconfigure work", async () => {
  const fixture = await factoryProcess();
  const database = fixture.connect();
  const owner = crypto.randomUUID(),
    other = crypto.randomUUID(),
    manager = crypto.randomUUID();
  const project = crypto.randomUUID(),
    libraryId = crypto.randomUUID();
  const admin = "01994a7d-0000-7000-8000-000000000001";
  try {
    await database.client`INSERT INTO auth."user"(id,name,email,email_verified)
      VALUES (${admin},'Cover administrator',${`admin-${fixture.id}@covers.test`},true) ON CONFLICT DO NOTHING`;
    await database.client`INSERT INTO factory.administrator(user_id) VALUES (${admin}) ON CONFLICT DO NOTHING`;
    for (const id of [owner, other, manager])
      await database.client`INSERT INTO auth."user"(id,name,email,email_verified)
        VALUES (${id},'Cover author',${`${id}@covers.test`},true)`;
    await database.client`INSERT INTO factory.project(id,slug,name,repository_url,default_branch,devcontainer_path,created_by)
      VALUES (${project},${`covers-${project}`},'Cover proof','https://example.invalid/owned.git','main','.devcontainer/devcontainer.json',${admin})`;
    for (const id of [owner, manager])
      await database.client`INSERT INTO factory.project_membership(project_id,user_id,role,manage_project,updated_by)
        VALUES (${project},${id},'product-contributor',${id === manager},${admin})`;
    const skills = createSkillController(database);
    const mcp = createMCPLibrary(database);
    const skillSave = {
      libraryId,
      revisionId: crypto.randomUUID(),
      expectedRevision: 0,
      scope: "personal",
      content: {
        key: "cover-proof",
        name: "Cover proof",
        description: "Use for owned cover verification.",
        instructions: "Retain the approved instructions.",
        roles: ["planning"],
        references: [],
      },
    };
    const mcpSave = {
      libraryId,
      revisionId: crypto.randomUUID(),
      expectedRevision: 0,
      scope: "personal",
      content: {
        name: "Cover source",
        description: "Read approved sources.",
        endpoint: "https://owned.example/mcp",
        authentication: "none",
        provider: "custom",
        roles: ["planning"],
      },
    };
    await skills.library.save(skillSave, owner);
    await mcp.save(mcpSave, owner);
    const skillEntry = async () =>
      fixtureValue(
        (await skills.getLibrary(owner, project)).entries.find((entry) => entry.id === libraryId),
        "(await skills.getLibrary(owner, project)).entries.find((entry) => entry.id === libraryId)",
      );
    const mcpEntry = async () =>
      fixtureValue(
        (await mcp.view(owner, project)).entries.find((entry) => entry.id === libraryId),
        "(await mcp.view(owner, project)).entries.find((entry) => entry.id === libraryId)",
      );
    expect((await skillEntry()).cover).toEqual({ key: defaultLibraryCover(libraryId), version: 1 });
    expect((await mcpEntry()).cover).toEqual((await skillEntry()).cover);
    expect((await skills.getLibrary(other)).entries.some((entry) => entry.id === libraryId)).toBe(
      false,
    );
    expect((await mcp.view(other)).entries.some((entry) => entry.id === libraryId)).toBe(false);
    const skillRevision = structuredClone((await skillEntry()).revisions);
    const mcpRevision = structuredClone((await mcpEntry()).revisions);
    await skills.chooseLibrary(
      {
        libraryId,
        revisionId: skillSave.revisionId,
        projectId: project,
        scope: "personal",
        role: "planning",
        state: "enable",
        expectedVersion: 0,
      },
      owner,
      project,
    );
    await database.client`INSERT INTO factory.mcp_connection(id,revision_id,state,version,credential_epoch,authorized_by)
      VALUES (${libraryId},${mcpSave.revisionId},'ready',2,${crypto.randomUUID()},${owner})`;
    const [connection] =
      await database.client`SELECT * FROM factory.mcp_connection WHERE id=${libraryId}`;
    if (!connection) throw new Error("Owned MCP connection was not retained");
    const choices = [
      ...(await database.client`SELECT * FROM factory.skill_library_choice WHERE library_id=${libraryId}`),
    ];
    const first = fixtureValue(
      libraryCoverCatalog.find((cover) => cover.key !== defaultLibraryCover(libraryId)),
      "libraryCoverCatalog.find( (cover) => cover.key !== defaultLibraryCover(libraryId), )",
    ).key;
    const command = { libraryId, key: first, expectedVersion: 1 };
    await skills.library.cover(command, owner);
    await skills.library.cover(command, owner);
    expect((await skillEntry()).cover).toEqual({ key: first, version: 2 });
    expect((await mcpEntry()).cover).toEqual({ key: defaultLibraryCover(libraryId), version: 1 });
    await mcp.cover(command, owner);
    await mcp.cover(command, owner);
    expect((await mcpEntry()).cover).toEqual({ key: first, version: 2 });
    await expect(skills.library.cover({ ...command, expectedVersion: 2 }, other)).rejects.toThrow(
      "not found",
    );
    await expect(mcp.cover({ ...command, expectedVersion: 2 }, other)).rejects.toThrow(
      "cannot manage",
    );
    await expect(
      mcp.cover({ ...command, key: "https://example.com/image.png" }, owner),
    ).rejects.toThrow();
    const alternatives = libraryCoverCatalog.filter((cover) => cover.key !== first).slice(0, 2);
    for (const library of [skills.library, mcp]) {
      const concurrent = await Promise.allSettled(
        alternatives.map((cover) =>
          library.cover({ libraryId, key: cover.key, expectedVersion: 2 }, owner),
        ),
      );
      expect(concurrent.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      expect(concurrent.filter((result) => result.status === "rejected")).toHaveLength(1);
      await expect(library.cover(command, owner)).rejects.toThrow("changed elsewhere");
    }
    expect((await skillEntry()).revisions).toEqual(skillRevision);
    expect((await mcpEntry()).revisions).toEqual(mcpRevision);
    expect([
      ...(await database.client`SELECT * FROM factory.mcp_connection WHERE id=${libraryId}`),
    ]).toEqual([connection]);
    expect([
      ...(await database.client`SELECT * FROM factory.skill_library_choice WHERE library_id=${libraryId}`),
    ]).toEqual(choices);
    const skillCover = (await skillEntry()).cover,
      mcpCover = (await mcpEntry()).cover;
    await skills.library.save(
      {
        ...skillSave,
        revisionId: crypto.randomUUID(),
        expectedRevision: 1,
        content: { ...skillSave.content, name: "Renamed guidance" },
      },
      owner,
    );
    await mcp.save(
      {
        ...mcpSave,
        revisionId: crypto.randomUUID(),
        expectedRevision: 1,
        content: { ...mcpSave.content, name: "Renamed source" },
      },
      owner,
    );
    expect((await skillEntry()).cover).toEqual(skillCover);
    expect((await mcpEntry()).cover).toEqual(mcpCover);

    for (const [library, save] of [
      [skills.library, skillSave],
      [mcp, mcpSave],
    ] as const) {
      const sharedId = crypto.randomUUID();
      await library.save(
        {
          ...save,
          libraryId: sharedId,
          revisionId: crypto.randomUUID(),
          scope: "project",
          projectId: project,
        },
        manager,
      );
      await expect(
        library.cover({ libraryId: sharedId, key: first, expectedVersion: 1 }, owner),
      ).rejects.toThrow(/manager|cannot manage/i);
      await library.cover({ libraryId: sharedId, key: first, expectedVersion: 1 }, manager);
      await database.client`UPDATE factory.project_membership SET manage_project=false
        WHERE project_id=${project} AND user_id=${manager}`;
      await expect(
        library.cover(
          {
            libraryId: sharedId,
            key: fixtureValue(alternatives[0], "alternatives[0]").key,
            expectedVersion: 2,
          },
          manager,
        ),
      ).rejects.toThrow(/manager|cannot manage/i);
      await database.client`UPDATE factory.project_membership SET manage_project=true
        WHERE project_id=${project} AND user_id=${manager}`;
      const factoryId = crypto.randomUUID();
      await library.save(
        { ...save, libraryId: factoryId, revisionId: crypto.randomUUID(), scope: "system" },
        admin,
      );
      await expect(
        library.cover({ libraryId: factoryId, key: first, expectedVersion: 1 }, manager),
      ).rejects.toThrow(/administrator|cannot manage/i);
      await library.cover({ libraryId: factoryId, key: first, expectedVersion: 1 }, admin);
    }

    const proposal = crypto.randomUUID();
    await skills.library.propose(proposal, skillSave.revisionId, "project", project, owner);
    const shared = await skills.library.accept(proposal, manager);
    expect(
      (await skills.getLibrary(manager, project)).entries.find(
        (entry) => entry.id === shared.libraryId,
      )?.cover?.key,
    ).toBe(skillCover?.key);
    const mcpProposal = crypto.randomUUID();
    await mcp.propose(mcpProposal, mcpSave.revisionId, "project", project, owner);
    const sharedMCP = await mcp.accept(mcpProposal, manager);
    expect(
      (await mcp.view(manager, project)).entries.find((entry) => entry.id === sharedMCP.libraryId)
        ?.cover?.key,
    ).toBe(mcpCover?.key);
  } finally {
    await database.client.end();
    await fixture.dispose();
  }
});
