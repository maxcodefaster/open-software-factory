import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { zeroDrizzle } from "@rocicorp/zero/server/adapters/drizzle";
import { desktopBackgroundKeys } from "../../packages/interface-domain/src/background";
import { zeroQueries, zeroSchema } from "../../packages/zero-schema/src";
import { zeroServerMutators } from "../../packages/zero-schema/src/server";
import { factoryProcess } from "../fixtures/factory-process";
import { createProjectRoute } from "../../apps/factory/src/routes/projects";

test("new Projects spread persistent backgrounds across the catalogue, including concurrent registrations", async () => {
  const owned = await factoryProcess();
  const database = owned.connect();
  const manager = crypto.randomUUID();
  try {
    await database.client`INSERT INTO auth."user"(id,name,email)
      VALUES(${manager},'Project manager',${`${manager}@background.test`})`;
    await database.client`INSERT INTO factory.administrator(user_id) VALUES(${manager})`;
    const register = createProjectRoute({
      database,
      localRepositoryOrigin: "https://forge.test",
      forgeOwner: "factory",
      session: async () => ({ user: { id: manager } }),
      ensureStaging: async () => {},
      generateKnowledge: async () => {},
      ensureKnowledgeHook: async () => {},
    });
    const create = async (index: number) => {
      const response = await register(
        new Request("https://factory.test/api/projects", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            slug: `background-${index}`,
            name: `Background ${index}`,
            repositoryUrl: `https://forge.test/factory/background-${index}`,
            defaultBranch: "main",
            devcontainerPath: ".devcontainer/devcontainer.json",
          }),
        }),
      );
      expect(response.status).toBe(201);
      return (await response.json()) as { id: string; desktopBackgroundKey: string };
    };
    const first = [];
    for (let index = 0; index < 6; index++) first.push(await create(index));
    expect(new Set(first.map((project) => project.desktopBackgroundKey)).size).toBe(6);
    const concurrent = await Promise.all(
      Array.from({ length: 12 }, (_, index) => create(index + 6)),
    );
    const projects = [...first, ...concurrent];
    for (const key of desktopBackgroundKeys)
      expect(projects.filter((project) => project.desktopBackgroundKey === key)).toHaveLength(3);
    await database.client`UPDATE factory.project SET name=name || ' renamed'`;
    const listed = await register(new Request("https://factory.test/api/projects"));
    expect(listed.status).toBe(200);
    const body = (await listed.json()) as { projects: typeof projects };
    for (const project of projects)
      expect(body.projects.find((row) => row.id === project.id)?.desktopBackgroundKey).toBe(
        project.desktopBackgroundKey,
      );
    await expect(
      database.client`UPDATE factory.project SET desktop_background_key='https://example.invalid/art.jpg'
        WHERE id=${first[0]!.id}`.execute(),
    ).rejects.toThrow("check constraint");
  } finally {
    await database.client.end();
    await owned.dispose();
  }
});

test("only active Project managers can change a shared background and unrelated Projects stay unchanged", async () => {
  const owned = await factoryProcess();
  const database = owned.connect();
  const manager = crypto.randomUUID();
  const developer = crypto.randomUUID();
  const outsider = crypto.randomUUID();
  const administrator = crypto.randomUUID();
  const projectId = crypto.randomUUID();
  const otherProjectId = crypto.randomUUID();
  const zero = zeroDrizzle(zeroSchema, database.db);
  const setBackground = (userId: string, id: string, key: (typeof desktopBackgroundKeys)[number]) =>
    zero.transaction((tx) =>
      zeroServerMutators.projects.setBackground.fn({
        tx,
        ctx: { userId, systemManager: userId === outsider },
        args: { projectId: id, desktopBackgroundKey: key },
      }),
    );
  try {
    for (const user of [manager, developer, outsider, administrator])
      await database.client`INSERT INTO auth."user"(id,name,email)
        VALUES(${user},'Background member',${`${user}@background.test`})`;
    await database.client`INSERT INTO factory.administrator(user_id) VALUES(${administrator})`;
    for (const id of [projectId, otherProjectId])
      await database.client`INSERT INTO factory.project(
        id,slug,name,repository_url,default_branch,devcontainer_path,created_by,desktop_background_key)
        VALUES(${id},${`background-${id}`},'Shared background','https://example.invalid/background.git',
          'main','.devcontainer/devcontainer.json',${manager},'river-landscape')`;
    await database.client`INSERT INTO factory.project_membership(project_id,user_id,role,manage_project,updated_by)
      VALUES(${projectId},${manager},'product-contributor',true,${manager}),
        (${projectId},${developer},'developer',false,${manager})`;
    const member = { userId: developer, systemManager: false };
    await setBackground(manager, projectId, "gulf-of-marseille");
    expect(
      (await zero.run(zeroQueries.projects.list.fn({ args: undefined, ctx: member })))[0]
        ?.desktopBackgroundKey,
    ).toBe("gulf-of-marseille");
    for (const user of [developer, outsider])
      await expect(setBackground(user, projectId, "scene-on-the-ice")).rejects.toThrow(
        user === developer ? "Project Manager access required" : "Project not found",
      );
    await expect(setBackground(manager, otherProjectId, "scene-on-the-ice")).rejects.toThrow(
      "Project not found",
    );
    await expect(
      setBackground(administrator, crypto.randomUUID(), "scene-on-the-ice"),
    ).rejects.toThrow("Project not found");
    await setBackground(administrator, projectId, "moonlit-landscape");
    await setBackground(administrator, projectId, "moonlit-landscape");
    for (const column of ["disabled_at", "directory_disabled_at"]) {
      await database.client.unsafe(
        `UPDATE factory.account_access SET ${column}=now() WHERE user_id=$1`,
        [manager],
      );
      await expect(setBackground(manager, projectId, "the-harvesters")).rejects.toThrow(
        "Project not found",
      );
      await database.client.unsafe(
        `UPDATE factory.account_access SET ${column}=NULL WHERE user_id=$1`,
        [manager],
      );
    }
    await database.client`UPDATE factory.project_membership SET manage_project=false
      WHERE project_id=${projectId} AND user_id=${manager}`;
    await expect(setBackground(manager, projectId, "the-harvesters")).rejects.toThrow(
      "Project Manager access required",
    );
    const [shared, other] = await Promise.all(
      [projectId, otherProjectId].map(async (id) => {
        const [row] = await database.client<{ key: string }[]>`
          SELECT desktop_background_key AS key FROM factory.project WHERE id=${id}`;
        return row?.key;
      }),
    );
    expect(shared).toBe("moonlit-landscape");
    expect(other).toBe("river-landscape");
    expect(await database.client`SELECT * FROM factory.user_ui_preference`).toHaveLength(0);
  } finally {
    await database.client.end();
    await owned.dispose();
  }
});

test("upgrading existing Projects retains the creator's artwork without changing identities or personal preferences", async () => {
  const owned = await factoryProcess();
  const database = owned.connect(1);
  const creator = crypto.randomUUID();
  const anotherCreator = crypto.randomUUID();
  const projectId = crypto.randomUUID();
  const otherProjectId = crypto.randomUUID();
  try {
    // Reconstruct the immediately preceding schema in this test's private database.
    await database.client.unsafe(`
      DROP TRIGGER project_background_assignment ON factory.project;
      DROP FUNCTION factory.assign_project_background();
      ALTER TABLE factory.project DROP COLUMN desktop_background_key;
      DELETE FROM factory.schema_migration WHERE version=16;
    `);
    for (const id of [creator, anotherCreator])
      await database.client`INSERT INTO auth."user"(id,name,email)
        VALUES(${id},'Existing owner',${`${id}@background.test`})`;
    await database.client`INSERT INTO factory.user_ui_preference(user_id,desktop_background_key)
      VALUES(${creator},'the-harvesters')`;
    for (const [id, user] of [
      [projectId, creator],
      [otherProjectId, anotherCreator],
    ] as const)
      await database.client`INSERT INTO factory.project(
        id,slug,name,repository_url,default_branch,devcontainer_path,created_by)
        VALUES(${id},${`existing-${id}`},'Existing Project','https://example.invalid/existing.git',
          'main','.devcontainer/devcontainer.json',${user})`;
    const before = await database.client`
      SELECT to_jsonb(project) AS project FROM factory.project project ORDER BY id`;
    const preferences = await database.client`SELECT * FROM factory.user_ui_preference`;
    await database.client.unsafe(
      await readFile("packages/db/migrations/0016_project_backgrounds.sql", "utf8"),
    );
    for (const id of [projectId, otherProjectId]) {
      const [row] = await database.client<{ key: string }[]>`
        SELECT desktop_background_key AS key FROM factory.project WHERE id=${id}`;
      expect(row?.key).toBe(id === projectId ? "the-harvesters" : "river-landscape");
    }
    expect(
      await database.client`SELECT to_jsonb(project)-'desktop_background_key' AS project
        FROM factory.project project ORDER BY id`,
    ).toEqual(before);
    expect(await database.client`SELECT * FROM factory.user_ui_preference`).toEqual(preferences);
  } finally {
    await database.client.end();
    await owned.dispose();
  }
});
