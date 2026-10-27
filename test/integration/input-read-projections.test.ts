import { expect, test } from "bun:test";
import { zeroDrizzle } from "@rocicorp/zero/server/adapters/drizzle";
import { zeroQueries, zeroSchema } from "../../packages/zero-schema/src";
import { monitoringFixture } from "../fixtures/monitoring";

test("Input activity and shared source metadata invalidate independently without replicating private contents", async () => {
  const fixture = await monitoringFixture();
  const { database, projectId, source } = fixture;
  const markers = () => database.client<{ scope: string; revision: string }[]>`
    SELECT scope,revision FROM factory.read_version WHERE project_id=${projectId}
      AND scope IN ('inputs','sources') ORDER BY scope`;
  try {
    const before = await markers();
    const incident = await fixture.receive("owned-input-read");
    const activity = await markers();
    expect(activity.find((row) => row.scope === "inputs")?.revision).not.toBe(
      before.find((row) => row.scope === "inputs")?.revision,
    );
    expect(activity.find((row) => row.scope === "sources")?.revision).toBe(
      before.find((row) => row.scope === "sources")?.revision,
    );
    await database.client`UPDATE factory.monitoring_incident
      SET owner_token=${crypto.randomUUID()},owner_expires_at=now()+interval '1 minute' WHERE id=${incident}`;
    expect(await markers()).toEqual(activity);
    await database.client`UPDATE factory.mcp_connection SET version=version+1 WHERE id=${source.id}`;
    const configuration = await markers();
    expect(configuration.find((row) => row.scope === "sources")?.revision).not.toBe(
      activity.find((row) => row.scope === "sources")?.revision,
    );
    expect(configuration.find((row) => row.scope === "inputs")?.revision).toBe(
      activity.find((row) => row.scope === "inputs")?.revision,
    );
    await fixture.addSource("personal");
    expect(await markers()).toEqual(configuration);
    await expect(
      database.client.begin(async (sql) => {
        await sql`UPDATE factory.monitoring_hook SET name='Rolled back' WHERE id=${fixture.hookId}`;
        throw new Error("owned rollback");
      }),
    ).rejects.toThrow("owned rollback");
    expect(await markers()).toEqual(configuration);
    const zero = zeroDrizzle(zeroSchema, database.db);
    for (const scope of ["inputs", "sources"] as const) {
      expect(
        await zero.run(
          zeroQueries.readVersions.list.fn({
            args: { projectId, scope, resourceId: projectId },
            ctx: { userId: crypto.randomUUID() },
          }),
        ),
      ).toEqual([]);
    }
    const release = crypto.randomUUID();
    await database.client`INSERT INTO factory.project_release
      (id,project_id,command_id,version,commit_sha,notes,created_by)
      VALUES(${release},${projectId},${crypto.randomUUID()},'1.0.0',${"a".repeat(40)},'Owned release read',${fixture.userId})`;
    const releaseMarker = () => database.client<{ revision: string }[]>`
      SELECT revision FROM factory.read_version WHERE project_id=${projectId} AND scope='releases'`;
    const previousRelease = await releaseMarker();
    await database.client`INSERT INTO factory.release_attempt
      (id,release_id,command_id,ordinal,runner_token)
      VALUES(${crypto.randomUUID()},${release},${crypto.randomUUID()},1,'owned-private-runner-token')`;
    expect(await releaseMarker()).not.toEqual(previousRelease);
    const replicated = await database.client`SELECT * FROM factory.read_version`;
    expect(JSON.stringify(replicated)).not.toContain("Invoice exception");
    expect(JSON.stringify(replicated)).not.toContain("src/invoice.ts");
    expect(JSON.stringify(replicated)).not.toContain("secret");
    expect(JSON.stringify(replicated)).not.toContain("owned-private-runner-token");
  } finally {
    await fixture.dispose();
  }
}, 60_000);

test("Project authority changes invalidate Inputs, sources and Releases without polling or private contents", async () => {
  const fixture = await monitoringFixture();
  const { database, projectId } = fixture;
  const userId = crypto.randomUUID();
  const markers = () => database.client<{ scope: string; revision: string }[]>`
    SELECT scope,revision FROM factory.read_version WHERE project_id=${projectId}
      AND audience='shared' AND scope IN ('inputs','sources','releases') ORDER BY scope`;
  try {
    await database.client`INSERT INTO auth."user"(id,name,email)
      VALUES(${userId},'Owned Project manager',${`${userId}@factory.test`})`;
    await database.client`INSERT INTO factory.project_membership
      (project_id,user_id,role,manage_project,updated_by)
      VALUES(${projectId},${userId},'product-contributor',true,${fixture.userId})`;
    expect((await fixture.controller.view(projectId, userId)).canManage).toBe(true);
    const before = await markers();
    await database.client`UPDATE factory.project_membership SET manage_project=false
      WHERE project_id=${projectId} AND user_id=${userId}`;
    const after = await markers();
    expect(after.map((row) => row.scope)).toEqual(["inputs", "releases", "sources"]);
    for (const row of after)
      expect(row.revision).not.toBe(
        before.find((previous) => previous.scope === row.scope)?.revision,
      );
    expect((await fixture.controller.view(projectId, userId)).canManage).toBe(false);
    await expect(
      database.client.begin(async (sql) => {
        await sql`UPDATE factory.project_membership SET manage_project=true
          WHERE project_id=${projectId} AND user_id=${userId}`;
        throw new Error("Owned permission rollback");
      }),
    ).rejects.toThrow("Owned permission rollback");
    expect(await markers()).toEqual(after);
    await database.client`UPDATE factory.project_membership SET role=role
      WHERE project_id=${projectId} AND user_id=${userId}`;
    expect(await markers()).toEqual(after);
    const zero = zeroDrizzle(zeroSchema, database.db);
    const version = await zero.run(
      zeroQueries.readVersions.list.fn({
        args: { projectId, scope: "inputs", resourceId: projectId },
        ctx: { userId },
      }),
    );
    expect(version.map((row) => row.revision)).toEqual(
      after.filter((row) => row.scope === "inputs").map((row) => row.revision),
    );
    expect(JSON.stringify(await markers())).not.toContain(userId);
  } finally {
    await fixture.dispose();
  }
}, 60_000);
