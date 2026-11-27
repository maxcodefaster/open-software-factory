import { afterAll, beforeAll, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import postgres from "postgres";
import { librarySkillsAvailable } from "#conversation-domain/skill-library";
import type { SkillContent } from "#conversation-domain/skills";
import { drizzleTransaction } from "#db/client";
import { createSkillController } from "../../apps/factory/src/skills/controller";
import { ownedPostgresServer, ownedTestDatabase } from "../fixtures/postgres-server";

let server: Awaited<ReturnType<typeof ownedPostgresServer>>;
beforeAll(async () => {
  server = await ownedPostgresServer();
}, 60_000);
afterAll(async () => {
  await server?.dispose();
});

// Direct controller proofs, with no Factory build, runtime or model calls.
// Each case owns a database cloned from the sealed PostgreSQL baseline.
async function fixture() {
  const owned = await ownedTestDatabase(server.identity, crypto.randomUUID());
  const client = postgres(owned.url, { max: 4 });
  const database = {
    client,
    db: drizzleTransaction(client),
    coordination: () => postgres(owned.url, { max: 1, idle_timeout: 0 }),
  };
  const admin = crypto.randomUUID(),
    author = crypto.randomUUID(),
    manager = crypto.randomUUID(),
    outsider = crypto.randomUUID(),
    project = crypto.randomUUID(),
    otherProject = crypto.randomUUID();
  async function dispose() {
    try {
      await client.end({ timeout: 2 });
    } finally {
      await owned.dispose();
    }
  }
  try {
    for (const id of [admin, author, manager, outsider])
      await client`INSERT INTO auth."user"(id,name,email,email_verified)
        VALUES(${id},'Owned Skill contributor',${`${id}@skills.test`},true)`;
    await client`INSERT INTO factory.administrator(user_id) VALUES(${admin})`;
    for (const id of [project, otherProject]) {
      await client`INSERT INTO factory.project(id,slug,name,repository_url,default_branch,actor_template_path,created_by)
        VALUES(${id},${`skills-${id}`},'Owned Skill proof','https://example.invalid/owned.git',
          'main','.factory/actor-template.json',${admin})`;
      for (const user of [author, manager])
        await client`INSERT INTO factory.project_membership(project_id,user_id,role,manage_project,updated_by)
          VALUES(${id},${user},'product-contributor',${user === manager},${admin})`;
    }
    const skills = createSkillController(database);
    function content(key = "owned-guidance"): SkillContent {
      return {
        key,
        name: "Owned guidance",
        description: "Use the exact approved guidance.",
        instructions: "Keep approved requirements and personal guidance private.",
        roles: ["planning", "build"],
        references: [{ path: "references/privacy.md", body: "Do not share future revisions." }],
      };
    }
    function save(scope: "personal" | "project" | "system" = "personal", key?: string) {
      return {
        libraryId: crypto.randomUUID(),
        revisionId: crypto.randomUUID(),
        expectedRevision: 0,
        scope,
        ...(scope === "project" ? { projectId: project } : {}),
        content: content(key),
      };
    }
    async function resolve(personal = true) {
      return client.begin((sql) =>
        skills.resolveAssignment("planning", sql, { projectID: project, userID: author, personal }),
      );
    }
    return {
      client,
      database,
      skills,
      admin,
      author,
      manager,
      outsider,
      project,
      otherProject,
      content,
      save,
      resolve,
      dispose,
    };
  } catch (cause) {
    await dispose();
    throw cause;
  }
}

test("library CRUD preserves private scopes, immutable copies, cover CAS and proposal grants", async () => {
  const f = await fixture();
  try {
    const initial = await f.skills.getLibrary(f.author, f.project);
    expect(initial.entries).toHaveLength(7);
    const input = f.save();
    expect(await f.skills.library.save(input, f.author)).toEqual({
      libraryId: input.libraryId,
      revisionId: input.revisionId,
    });
    expect(await f.skills.library.save(input, f.author)).toEqual({
      libraryId: input.libraryId,
      revisionId: input.revisionId,
    });
    await expect(
      f.skills.library.save(
        { ...input, content: { ...input.content, instructions: "Changed" } },
        f.author,
      ),
    ).rejects.toMatchObject({ status: 409 });
    await expect(f.skills.library.save(input, f.manager)).rejects.toMatchObject({ status: 404 });
    expect(
      (await f.skills.getLibrary(f.author, f.otherProject)).entries.some(
        (row) => row.id === input.libraryId,
      ),
    ).toBe(true);
    expect(
      (await f.skills.getLibrary(f.manager, f.project)).entries.some(
        (row) => row.id === input.libraryId,
      ),
    ).toBe(false);
    await expect(
      f.skills.library.inspect(input.revisionId, f.manager, f.project),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      f.skills.library.inspect(input.revisionId, f.outsider, f.project),
    ).rejects.toMatchObject({ status: 404 });
    await expect(f.skills.library.save(f.save("project"), f.author)).rejects.toMatchObject({
      status: 403,
    });
    const projectInput = f.save("project", "project-guidance");
    await f.skills.library.save(projectInput, f.manager);
    await expect(
      f.skills.library.inspect(projectInput.revisionId, f.author, f.otherProject),
    ).rejects.toMatchObject({ status: 404 });
    expect(
      (await f.skills.library.inspect(projectInput.revisionId, f.author, f.project)).content,
    ).toEqual(projectInput.content);
    await expect(f.skills.library.save(f.save("system"), f.manager)).rejects.toMatchObject({
      status: 403,
    });
    const systemInput = f.save("system", "system-guidance");
    await f.skills.library.save(systemInput, f.admin);
    expect((await f.skills.library.inspect(systemInput.revisionId, f.author)).content).toEqual(
      systemInput.content,
    );

    const originalCover = (await f.skills.getLibrary(f.author, f.project)).entries.find(
      (row) => row.id === input.libraryId,
    )?.cover?.key;
    if (!originalCover) throw new Error("Owned library cover missing");
    const cover = {
      libraryId: input.libraryId,
      key: originalCover === "open-folio" ? "folded-planes" : "open-folio",
      expectedVersion: 1,
    };
    await f.skills.library.cover(cover, f.author);
    await f.skills.library.cover(cover, f.author);
    await expect(
      f.skills.library.cover({ ...cover, key: originalCover }, f.author),
    ).rejects.toMatchObject({ status: 409 });
    await expect(f.skills.library.cover(cover, f.manager)).rejects.toMatchObject({ status: 404 });
    const proposal = crypto.randomUUID();
    await f.skills.library.propose(proposal, input.revisionId, "project", f.project, f.author);
    await f.skills.library.propose(proposal, input.revisionId, "project", f.project, f.author);
    await expect(
      f.skills.library.propose(proposal, input.revisionId, "system", undefined, f.author),
    ).rejects.toMatchObject({ status: 409 });
    await expect(
      f.skills.library.propose(
        crypto.randomUUID(),
        input.revisionId,
        "project",
        f.project,
        f.manager,
      ),
    ).rejects.toMatchObject({ status: 404 });
    expect((await f.skills.getLibrary(f.manager, f.project)).proposals).toEqual([
      {
        id: proposal,
        revisionId: input.revisionId,
        target: "project",
        projectId: f.project,
        name: input.content.name,
      },
    ]);
    expect((await f.skills.getLibrary(f.manager, f.otherProject)).proposals).toEqual([]);
    expect(
      (await f.skills.library.inspect(input.revisionId, f.manager, f.project)).content,
    ).toEqual(input.content);
    await expect(f.skills.library.accept(proposal, f.author)).rejects.toMatchObject({
      status: 403,
    });
    const shared = await f.skills.library.accept(proposal, f.manager);
    expect(await f.skills.library.accept(proposal, f.manager)).toEqual(shared);
    const copied = (await f.skills.getLibrary(f.manager, f.project)).entries.find(
      (row) => row.id === shared.libraryId,
    );
    expect(copied?.cover).toMatchObject({ key: cover.key, version: 1 });
    expect(copied?.revisions[0]?.content).toEqual(input.content);
    const [link] = await f.client<
      { copied_from: string }[]
    >`SELECT copied_from FROM factory.skill_revision WHERE library_id=${shared.libraryId}`;
    expect(link?.copied_from).toBe(input.revisionId);
    const next = {
      ...input,
      expectedRevision: 1,
      revisionId: crypto.randomUUID(),
      content: { ...input.content, instructions: "Future private guidance" },
    };
    await f.skills.library.save(next, f.author);
    expect(
      (await f.skills.library.inspect(copied?.revisions[0]?.id ?? "", f.manager, f.project))
        .content,
    ).toEqual(input.content);
    await expect(
      f.skills.library.inspect(next.revisionId, f.manager, f.project),
    ).rejects.toMatchObject({ status: 404 });
    expect(
      (await f.skills.getLibrary(f.manager, f.project)).entries.some((row) =>
        row.revisions.some((revision) => revision.id === next.revisionId),
      ),
    ).toBe(false);
    await expect(
      f.client`UPDATE factory.skill_revision SET content='{}' WHERE id=${input.revisionId}`,
    ).rejects.toThrow("immutable");
  } finally {
    await f.dispose();
  }
});

test("library choices pin exact revisions, lock required assignments and retain disabled versions", async () => {
  const f = await fixture();
  try {
    await f.skills.getLibrary(f.author, f.project);
    const input = f.save();
    await f.skills.library.save(input, f.author);
    const choice = {
      libraryId: input.libraryId,
      projectId: f.project,
      scope: "personal",
      role: "planning",
      state: "enable",
      revisionId: input.revisionId,
      expectedVersion: 0,
    };
    await f.skills.chooseLibrary(choice, f.author, f.project);
    const next = {
      ...input,
      expectedRevision: 1,
      revisionId: crypto.randomUUID(),
      content: { ...input.content, instructions: "Later guidance" },
    };
    await f.skills.library.save(next, f.author);
    expect((await f.resolve()).revisionIds).toContain(input.revisionId);
    expect((await f.resolve()).revisionIds).not.toContain(next.revisionId);
    expect((await f.resolve(false)).revisionIds).not.toContain(input.revisionId);
    const other = await f.client.begin((sql) =>
      f.skills.resolveAssignment("planning", sql, { projectID: f.otherProject, userID: f.author }),
    );
    expect(other.revisionIds).not.toContain(input.revisionId);
    await expect(
      f.skills.chooseLibrary({ ...choice, state: "required" }, f.author, f.project),
    ).rejects.toMatchObject({ status: 409 });
    await expect(
      f.skills.chooseLibrary({ ...choice, scope: "project" }, f.manager, f.project),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      f.skills.chooseLibrary({ ...choice, revisionId: next.revisionId }, f.author, f.project),
    ).rejects.toMatchObject({ status: 409 });
    await f.skills.chooseLibrary(
      { ...choice, expectedVersion: 1, state: "disable" },
      f.author,
      f.project,
    );
    await f.skills.setPublication(input.revisionId, false, f.admin);
    expect((await f.resolve()).revisionIds).not.toContain(input.revisionId);
    expect(
      (await f.skills.getLibrary(f.author, f.project)).choices.find(
        (row) => row.libraryId === input.libraryId,
      ),
    ).toMatchObject({
      revisionId: input.revisionId,
      state: "disable",
      version: 2,
    });
    await expect(
      f.skills.chooseLibrary({ ...choice, expectedVersion: 2 }, f.author, f.project),
    ).rejects.toMatchObject({ status: 409 });
    await f.skills.chooseLibrary(
      { ...choice, revisionId: next.revisionId, expectedVersion: 2 },
      f.author,
      f.project,
    );
    const sharedInput = f.save("project", "required-guidance");
    await f.skills.library.save(sharedInput, f.manager);
    const required = {
      ...choice,
      libraryId: sharedInput.libraryId,
      revisionId: sharedInput.revisionId,
      scope: "project",
      state: "required",
      expectedVersion: 0,
    };
    await f.skills.chooseLibrary(required, f.manager, f.project);
    expect((await f.resolve()).requiredRevisionIds).toContain(sharedInput.revisionId);
    await expect(
      f.skills.chooseLibrary(
        { ...required, scope: "personal", state: "disable" },
        f.author,
        f.project,
      ),
    ).rejects.toThrow("required");
    await f.skills.setPublication(sharedInput.revisionId, false, f.admin);
    await expect(f.resolve()).rejects.toMatchObject({ status: 503 });
    expect(
      (await f.skills.load([sharedInput.revisionId, input.revisionId])).map((row) => row.published),
    ).toEqual([false, false]);
    expect(await f.skills.load([])).toEqual([]);
    await expect(f.skills.load([crypto.randomUUID()])).rejects.toMatchObject({ status: 503 });
    await expect(
      f.skills.chooseLibrary({ ...choice, projectId: undefined }, f.author),
    ).rejects.toMatchObject({ status: 409 });
  } finally {
    await f.dispose();
  }
});

test("blocker availability matches admission for a retracted personal version without contaminating shared background work", async () => {
  const f = await fixture();
  try {
    const input = f.save();
    await f.skills.library.save(input, f.author);
    await f.skills.chooseLibrary(
      {
        libraryId: input.libraryId,
        revisionId: input.revisionId,
        scope: "personal",
        projectId: f.project,
        role: "planning",
        state: "enable",
        expectedVersion: 0,
      },
      f.author,
    );
    const next = {
      ...input,
      revisionId: crypto.randomUUID(),
      expectedRevision: 1,
      content: {
        ...input.content,
        instructions: "New publication must not replace the pinned revision",
      },
    };
    await f.skills.library.save(next, f.author);
    await f.skills.setPublication(input.revisionId, false, f.admin);
    const view = await f.skills.getLibrary(f.author, f.project);
    expect(librarySkillsAvailable(view.entries, view.choices, "planning")).toBe(false);
    await expect(f.resolve()).rejects.toMatchObject({ code: "unavailable", status: 503 });
    expect(librarySkillsAvailable(view.entries, view.choices, "planning", false)).toBe(true);
    expect((await f.resolve(false)).revisionIds).not.toContain(input.revisionId);
    expect((await f.resolve(false)).revisionIds).not.toContain(next.revisionId);
    expect((await f.skills.load([input.revisionId]))[0]).toMatchObject({
      content: input.content,
      published: false,
      revision: 1,
    });
    await f.skills.setPublication(input.revisionId, true, f.admin);
    const restored = await f.skills.getLibrary(f.author, f.project);
    expect(librarySkillsAvailable(restored.entries, restored.choices, "planning")).toBe(true);
    expect((await f.resolve()).revisionIds).toContain(input.revisionId);
    expect((await f.resolve()).revisionIds).not.toContain(next.revisionId);
  } finally {
    await f.dispose();
  }
});

test("canonical capabilities, required locks and Reset preserve other library choices", async () => {
  const f = await fixture();
  try {
    await f.skills.getLibrary(f.author, f.project);
    const input = f.save("system", "system-baseline");
    await f.skills.library.save(input, f.admin);
    const choice = {
      libraryId: input.libraryId,
      revisionId: input.revisionId,
      scope: "system",
      role: "planning",
      state: "required",
      expectedVersion: 0,
    };
    await expect(f.skills.library.save(f.save("system"), f.manager)).rejects.toMatchObject({
      status: 403,
    });
    await expect(f.skills.chooseLibrary(choice, f.manager)).rejects.toMatchObject({ status: 403 });
    await f.skills.chooseLibrary(choice, f.admin);
    for (const [scope, actor] of [
      ["project", f.manager],
      ["personal", f.author],
    ] as const)
      await expect(
        f.skills.chooseLibrary({ ...choice, projectId: f.project, scope, state: "enable" }, actor),
      ).rejects.toThrow("required");
    const second = f.save("project", "project-baseline");
    await f.skills.library.save(second, f.manager);
    const project = {
      ...choice,
      libraryId: second.libraryId,
      revisionId: second.revisionId,
      projectId: f.project,
      scope: "project",
      state: "enable",
    };
    await expect(f.skills.chooseLibrary(project, f.author)).rejects.toMatchObject({ status: 403 });
    await f.skills.chooseLibrary(project, f.manager);
    const personal = { ...project, scope: "personal", state: "disable" };
    await f.skills.chooseLibrary(personal, f.author);
    expect((await f.resolve()).revisionIds).not.toContain(second.revisionId);
    expect((await f.resolve(false)).revisionIds).toContain(second.revisionId);
    await expect(f.skills.chooseLibrary(personal, f.author)).rejects.toMatchObject({ status: 409 });
    await f.skills.chooseLibrary({ ...personal, state: "inherit", expectedVersion: 1 }, f.author);
    expect((await f.resolve()).revisionIds).toContain(second.revisionId);
    expect((await f.resolve()).requiredRevisionIds).toContain(input.revisionId);
    expect(
      (await f.skills.getLibrary(f.manager, f.project)).choices.some(
        (row) => row.scope === "personal",
      ),
    ).toBe(false);
    await expect(
      f.skills.setPublication(second.revisionId, false, f.manager),
    ).rejects.toMatchObject({ status: 403 });
    await f.skills.setPublication(second.revisionId, false, f.admin);
    const withdrawn = await f.skills.getLibrary(f.author, f.project);
    expect(librarySkillsAvailable(withdrawn.entries, withdrawn.choices, "planning")).toBe(false);
    await expect(f.resolve()).rejects.toMatchObject({ status: 503 });
    await f.skills.setPublication(second.revisionId, true, f.admin);
    const restored = await f.skills.getLibrary(f.author, f.project);
    expect(librarySkillsAvailable(restored.entries, restored.choices, "planning")).toBe(true);
    await expect(
      f.skills.setPublication(crypto.randomUUID(), false, f.admin),
    ).rejects.toMatchObject({ status: 404 });
    await f.client`DELETE FROM factory.project_membership WHERE project_id=${f.project} AND user_id=${f.author}`;
    await expect(f.skills.getLibrary(f.author, f.project)).rejects.toMatchObject({ status: 404 });
    await expect(
      f.skills.chooseLibrary({ ...personal, expectedVersion: 2 }, f.author),
    ).rejects.toMatchObject({ status: 404 });
  } finally {
    await f.dispose();
  }
});

test("disabled accounts cannot inspect, admit choices or use retained administrator grants", async () => {
  const f = await fixture();
  try {
    for (const field of ["disabled_at", "directory_disabled_at"] as const) {
      await f.client.unsafe(`UPDATE factory.account_access SET ${field}=now() WHERE user_id=$1`, [
        f.admin,
      ]);
      await expect(f.skills.getLibrary(f.admin, f.project)).rejects.toMatchObject({ status: 403 });
      await expect(
        f.skills.setPublication(crypto.randomUUID(), false, f.admin),
      ).rejects.toMatchObject({ status: 403 });
      await expect(f.skills.library.save(f.save(), f.admin)).rejects.toMatchObject({ status: 403 });
      await expect(f.skills.library.preview({}, f.admin)).rejects.toMatchObject({ status: 403 });
      await f.client.unsafe(`UPDATE factory.account_access SET ${field}=NULL WHERE user_id=$1`, [
        f.admin,
      ]);
    }
    await f.client`UPDATE factory.account_access SET directory_disabled_at=now() WHERE user_id=${f.author}`;
    await expect(f.skills.getLibrary(f.author, f.project)).rejects.toMatchObject({ status: 403 });
    await expect(f.skills.invocations(f.project, f.author, "planning")).rejects.toMatchObject({
      status: 403,
    });
    await expect(
      f.skills.chooseLibrary(
        {
          libraryId: crypto.randomUUID(),
          scope: "personal",
          projectId: f.project,
          role: "planning",
          state: "disable",
          expectedVersion: 0,
        },
        f.author,
        f.project,
      ),
    ).rejects.toMatchObject({ status: 403 });
  } finally {
    await f.dispose();
  }
});

test("shared Ticket evidence reveals only its exact admitted private revision and reads never start inference", async () => {
  const f = await fixture();
  try {
    const input = f.save();
    await f.skills.library.save(input, f.author);
    const ticket = crypto.randomUUID(),
      privateConversation = crypto.randomUUID(),
      sharedConversation = crypto.randomUUID();
    await f.client`INSERT INTO factory.ticket(id,project_id,title,created_by)
      VALUES(${ticket},${f.project},'Owned shared Skill proof',${f.author})`;
    for (const [id, ticketId] of [
      [privateConversation, null],
      [sharedConversation, ticket],
    ] as const)
      await f.client`INSERT INTO factory.ticket_conversation(id,project_id,ticket_id,created_by)
        VALUES(${id},${f.project},${ticketId},${f.author})`;
    async function turn(conversationId: string, ticketId: string | null) {
      const commandId = crypto.randomUUID();
      const command = {
        kind: "project-message",
        commandId,
        projectId: f.project,
        createdBy: f.author,
        conversationId,
        ticketId,
        text: "Owned retained guidance",
      };
      await f.client`INSERT INTO factory.agent_turn(id,command_id,project_id,ticket_id,conversation_id,created_by,input,input_digest,authority,state)
        VALUES(${crypto.randomUUID()},${commandId},${f.project},${ticketId},${conversationId},${f.author},
          ${JSON.stringify(command)}::jsonb,${createHash("sha256").update(JSON.stringify(command)).digest("hex")},
          ${JSON.stringify({ mode: "plan", conversationVersion: 1, modelId: "no-inference", skillRevisionIds: [input.revisionId] })}::jsonb,'completed')`;
    }
    await turn(privateConversation, null);
    await expect(
      f.skills.library.inspect(input.revisionId, f.manager, f.project),
    ).rejects.toMatchObject({ status: 404 });
    expect((await f.skills.getLibrary(f.manager, f.project)).sharedVersions).toEqual([]);
    await turn(sharedConversation, ticket);
    expect(
      (await f.skills.library.inspect(input.revisionId, f.manager, f.project)).content,
    ).toEqual(input.content);
    expect(
      (await f.skills.getLibrary(f.manager, f.project)).sharedVersions.map((row) => row.id),
    ).toEqual([input.revisionId]);
    await expect(
      f.skills.library.inspect(input.revisionId, f.manager, f.otherProject),
    ).rejects.toMatchObject({ status: 404 });
    const next = {
      ...input,
      expectedRevision: 1,
      revisionId: crypto.randomUUID(),
      content: { ...input.content, instructions: "Future private version" },
    };
    await f.skills.library.save(next, f.author);
    await expect(
      f.skills.library.inspect(next.revisionId, f.manager, f.project),
    ).rejects.toMatchObject({ status: 404 });
    await f.skills.setPublication(input.revisionId, false, f.admin);
    expect((await f.skills.library.inspect(input.revisionId, f.manager, f.project)).published).toBe(
      false,
    );
    await f.skills.getLibrary(f.author, f.project);
    await f.skills.getLibrary(f.admin);
    await f.skills.invocations(f.project, f.author, "planning");
    const [count] = await f.client<
      { count: number }[]
    >`SELECT count(*)::int AS count FROM factory.agent_turn`;
    expect(count?.count).toBe(2);
    await f.client`DELETE FROM factory.project_membership WHERE project_id=${f.project} AND user_id=${f.manager}`;
    await expect(
      f.skills.library.inspect(input.revisionId, f.manager, f.project),
    ).rejects.toMatchObject({ status: 404 });
  } finally {
    await f.dispose();
  }
});

test("Drizzle uses the caller's transaction and savepoint, including immutable revision rollback", async () => {
  const f = await fixture();
  try {
    const input = f.save();
    await expect(
      f.client.begin(async (sql) => {
        await f.skills.library.saveIn(sql, input, f.author);
        expect((await f.skills.load([input.revisionId], sql))[0]?.content).toEqual(input.content);
        expect(await f.skills.load([])).toEqual([]);
        await expect(f.skills.load([input.revisionId])).rejects.toMatchObject({ status: 503 });
        await expect(
          sql.savepoint(async (nested) => {
            const isolated = f.save();
            await f.skills.library.saveIn(nested, isolated, f.author);
            expect((await f.skills.load([isolated.revisionId], nested))[0]?.id).toBe(
              isolated.revisionId,
            );
            throw new Error("Owned savepoint rollback");
          }),
        ).rejects.toThrow("Owned savepoint rollback");
        const [count] = await sql<
          { count: number }[]
        >`SELECT count(*)::int AS count FROM factory.skill_revision`;
        expect(count?.count).toBe(1);
        throw new Error("Owned transaction rollback");
      }),
    ).rejects.toThrow("Owned transaction rollback");
    expect(await f.client`SELECT id FROM factory.skill_library`).toHaveLength(0);
    expect(await f.client`SELECT id FROM factory.skill_revision`).toHaveLength(0);
    expect(
      await f.client`SELECT id FROM factory.skill_library WHERE cover_key IS NOT NULL`,
    ).toHaveLength(0);
  } finally {
    await f.dispose();
  }
});

test("competing library saves wait on the real advisory lock and only one expected revision wins", async () => {
  const f = await fixture();
  const entered = Promise.withResolvers<void>(),
    release = Promise.withResolvers<void>();
  let first: Promise<unknown> | undefined, second: Promise<unknown> | undefined;
  try {
    const input = f.save();
    first = f.client
      .begin(async (sql) => {
        await f.skills.library.saveIn(sql, input, f.author);
        entered.resolve();
        await release.promise;
      })
      .then(
        () => null,
        (cause: unknown) => {
          entered.reject(cause);
          return cause;
        },
      );
    await entered.promise;
    const competingPID = Promise.withResolvers<number>();
    second = f.client
      .begin(async (sql) => {
        const [session] = await sql<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
        if (!session) throw new Error("Owned competing session missing");
        competingPID.resolve(session.pid);
        return f.skills.library.saveIn(
          sql,
          { ...input, revisionId: crypto.randomUUID() },
          f.author,
        );
      })
      .then(
        () => null,
        (cause: unknown) => {
          competingPID.reject(cause);
          return cause;
        },
      );
    const pid = await competingPID.promise;
    let contended = false;
    const deadline = Date.now() + 3_000;
    while (Date.now() < deadline) {
      const [activity] = await f.client<
        { waiting: boolean }[]
      >`SELECT wait_event_type='Lock' AS waiting FROM pg_stat_activity WHERE pid=${pid}`;
      if (activity?.waiting) {
        contended = true;
        break;
      }
      await Bun.sleep(10);
    }
    expect(contended).toBe(true);
    release.resolve();
    expect(await first).toBeNull();
    expect(await second).toMatchObject({ status: 409 });
    expect(await f.client`SELECT id FROM factory.skill_revision`).toHaveLength(1);
    expect((await f.skills.load([input.revisionId]))[0]?.revision).toBe(1);
  } finally {
    release.resolve();
    await Promise.allSettled([first, second]);
    await f.dispose();
  }
});

test("competing per-library choices at every scope cannot replace a winner", async () => {
  const f = await fixture();
  try {
    await f.skills.getLibrary(f.author, f.project);
    const input = f.save();
    await f.skills.library.save(input, f.author);
    const choice = {
      libraryId: input.libraryId,
      projectId: f.project,
      scope: "personal",
      role: "planning",
      state: "disable",
      revisionId: input.revisionId,
      expectedVersion: 0,
    };
    const systemInput = f.save("system");
    await f.skills.library.save(systemInput, f.admin);
    for (const [scope, actor, libraryId, revisionId] of [
      ["personal", f.author, input.libraryId, input.revisionId],
      ["project", f.manager, systemInput.libraryId, systemInput.revisionId],
      ["system", f.admin, systemInput.libraryId, systemInput.revisionId],
    ] as const) {
      const race = () =>
        f.skills.chooseLibrary(
          {
            ...choice,
            scope,
            libraryId,
            revisionId,
            ...(scope === "system" ? { projectId: undefined } : {}),
          },
          actor,
        );
      const results = await Promise.allSettled([race(), race()]);
      expect(results.filter((row) => row.status === "fulfilled")).toHaveLength(1);
      expect(results.find((row) => row.status === "rejected")).toMatchObject({
        status: "rejected",
        reason: { status: 409 },
      });
    }
    await f.client`UPDATE factory.operation SET payload=jsonb_set(payload,'{version}','9007199254740990'::jsonb,true) WHERE kind='skills.choice' AND payload->>'libraryId'=${input.libraryId}`;
    await f.skills.chooseLibrary(
      { ...choice, expectedVersion: 9007199254740990 },
      f.author,
      f.project,
    );
    expect(
      (await f.skills.getLibrary(f.author, f.project)).choices.find(
        (row) => row.libraryId === input.libraryId,
      )?.version,
    ).toBe(Number.MAX_SAFE_INTEGER);
  } finally {
    await f.dispose();
  }
});

test("Change invocations keep the first approved exact revisions, skip review authority and order PostgreSQL microseconds", async () => {
  const f = await fixture();
  try {
    const first = crypto.randomUUID(),
      next = crypto.randomUUID();
    const libraryId = crypto.randomUUID();
    await f.skills.library.save(
      {
        libraryId,
        scope: "system",
        revisionId: first,
        expectedRevision: 0,
        content: f.content("change-guidance"),
      },
      f.admin,
    );
    await f.skills.library.save(
      {
        libraryId,
        scope: "system",
        revisionId: next,
        expectedRevision: 1,
        content: { ...f.content("change-guidance"), instructions: "Future guidance" },
      },
      f.admin,
    );
    const ticket = crypto.randomUUID(),
      requirement = crypto.randomUUID(),
      approval = crypto.randomUUID(),
      change = crypto.randomUUID();
    const body = "# Approved exact requirements\n";
    await f.client`INSERT INTO factory.ticket(id,project_id,title,created_by)
      VALUES(${ticket},${f.project},'Owned approved Change',${f.author})`;
    await f.client`INSERT INTO factory.requirement_revision(id,ticket_id,ordinal,canonical_content,content_digest,created_by)
      VALUES(${requirement},${ticket},1,${body},${createHash("sha256").update(body).digest("hex")},${f.author})`;
    await f.client`INSERT INTO factory.requirement_approval(id,ticket_id,requirement_revision_id,approved_by)
      VALUES(${approval},${ticket},${requirement},${f.author})`;
    await f.client`INSERT INTO factory.change(id,project_id,ticket_id,requirement_approval_id,branch_name,base_sha,state,created_by)
      VALUES(${change},${f.project},${ticket},${approval},${`factory/change-${change.replaceAll("-", "").slice(0, 12)}`},
        ${"a".repeat(40)},'branch-pending',${f.author})`;
    const early = "2026-11-20 10:20:30.123456+00",
      later = "2026-11-20 10:20:30.123457+00";
    async function turn(id: string, createdAt: string, ids: string[], review = false) {
      const commandId = crypto.randomUUID(),
        reviewId = crypto.randomUUID();
      const command = {
        kind: review ? "change-review" : "change-start",
        commandId,
        projectId: f.project,
        ticketId: ticket,
        changeId: change,
        conversationId: null,
        createdBy: f.author,
        ...(review ? { reviewId } : {}),
      };
      const authority = {
        mode: "build",
        requirementRevisionId: requirement,
        modelId: "no-inference",
        skillRevisionIds: ids,
        ...(review
          ? {
              review: {
                reviewId,
                verificationId: crypto.randomUUID(),
                commitSha: "b".repeat(40),
                baseSha: "a".repeat(40),
              },
            }
          : {}),
      };
      await f.client`INSERT INTO factory.agent_turn(id,command_id,project_id,ticket_id,change_id,created_by,input,input_digest,authority,state,created_at)
        VALUES(${id},${commandId},${f.project},${ticket},${change},${f.author},${JSON.stringify(command)}::jsonb,
          ${createHash("sha256").update(JSON.stringify(command)).digest("hex")},${JSON.stringify(authority)}::jsonb,'completed',${createdAt}::timestamptz)`;
    }
    // Reversed UUID order within one millisecond exposes accidental JS Date sorting.
    await turn("10000000-0000-4000-8000-000000000002", later, [next]);
    await turn("f0000000-0000-4000-8000-000000000003", early, [first]);
    await turn(
      "00000000-0000-4000-8000-000000000001",
      "2026-11-20 10:20:30.123455+00",
      [next],
      true,
    );
    await f.skills.setPublication(first, false, f.admin);
    const invocation = await f.skills.invocations(f.project, f.manager, "build", change);
    expect(invocation.skills.map((row) => row.id)).toEqual([first]);
    expect(invocation.conflicts).toEqual([]);
    expect((await f.skills.load([next, first])).map((row) => row.id)).toEqual([next, first]);
    const [retained] = await f.client<
      { text: string }[]
    >`SELECT created_at::text AS text FROM factory.agent_turn WHERE id='f0000000-0000-4000-8000-000000000003'`;
    expect(retained?.text).toBe(early);
    expect(Object.keys((await f.skills.load([first]))[0] ?? {}).sort()).toEqual([
      "content",
      "digest",
      "id",
      "published",
      "revision",
    ]);
    await expect(
      f.skills.invocations(f.otherProject, f.manager, "build", change),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      f.skills.invocations(f.project, f.manager, "planning", change),
    ).rejects.toMatchObject({ status: 409 });
    await expect(
      f.skills.invocations(f.project, f.manager, "build", crypto.randomUUID()),
    ).rejects.toMatchObject({ status: 404 });
  } finally {
    await f.dispose();
  }
});

test("load rejects corrupt content digests and system proposals grant only installation management", async () => {
  const f = await fixture();
  try {
    const input = f.save();
    await f.skills.library.save(input, f.author);
    const proposal = crypto.randomUUID();
    await f.skills.library.propose(proposal, input.revisionId, "system", undefined, f.author);
    expect((await f.skills.getLibrary(f.admin)).proposals.map((row) => row.id)).toEqual([proposal]);
    expect((await f.skills.library.inspect(input.revisionId, f.admin)).content).toEqual(
      input.content,
    );
    expect((await f.skills.getLibrary(f.manager, f.project)).proposals).toEqual([]);
    await expect(
      f.skills.library.inspect(input.revisionId, f.manager, f.project),
    ).rejects.toMatchObject({ status: 404 });
    await expect(f.skills.library.accept(proposal, f.manager)).rejects.toMatchObject({
      status: 403,
    });
    await expect(f.skills.library.accept(crypto.randomUUID(), f.admin)).rejects.toMatchObject({
      status: 404,
    });
    const accepted = await f.skills.library.accept(proposal, f.admin);
    expect(
      (await f.skills.getLibrary(f.author)).entries.some((row) => row.id === accepted.libraryId),
    ).toBe(true);
    const corrupt = crypto.randomUUID();
    await f.client`INSERT INTO factory.skill_revision(id,skill_key,revision,content,content_digest,created_by,published,published_updated_by,published_updated_at)
      VALUES(${corrupt},'owned-corrupt',1,${JSON.stringify(f.content("owned-corrupt"))}::jsonb,${"f".repeat(64)},${f.admin},true,${f.admin},now())`;
    await expect(f.skills.load([corrupt])).rejects.toMatchObject({ status: 503 });
  } finally {
    await f.dispose();
  }
});
