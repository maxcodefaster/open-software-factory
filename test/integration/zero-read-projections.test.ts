import { expect, test } from "bun:test";
import { zeroDrizzle } from "@rocicorp/zero/server/adapters/drizzle";
import { zeroQueries, zeroSchema } from "../../packages/zero-schema/src";
import { factoryProcess } from "../fixtures/factory-process";

test("read markers are atomic, content-free, scoped to current membership and private audiences", async () => {
  const host = await factoryProcess();
  const database = host.connect(2);
  const user = crypto.randomUUID(),
    colleague = crypto.randomUUID(),
    contributor = crypto.randomUUID();
  const project = crypto.randomUUID(),
    foreign = crypto.randomUUID(),
    ticket = crypto.randomUUID();
  const shared = crypto.randomUUID(),
    personal = crypto.randomUUID();
  try {
    for (const id of [user, colleague, contributor])
      await database.client`INSERT INTO auth."user"(id,name,email) VALUES(${id},'Owned read proof',${`${id}@read.test`})`;
    for (const id of [project, foreign])
      await database.client`INSERT INTO factory.project(id,slug,name,repository_url,default_branch,devcontainer_path,created_by)
        VALUES(${id},${`reads-${id}`},'Read proof','https://example.invalid/read.git','main','.devcontainer/devcontainer.json',${user})`;
    for (const [id, role] of [
      [user, "developer"],
      [colleague, "developer"],
      [contributor, "product-contributor"],
    ] as const)
      await database.client`INSERT INTO factory.project_membership(project_id,user_id,role,updated_by)
        VALUES(${project},${id},${role},${user})`;
    await database.client`INSERT INTO factory.ticket(id,project_id,title,created_by)
      VALUES(${ticket},${project},'Read proof',${user})`;
    await database.client`INSERT INTO factory.ticket_conversation(id,project_id,ticket_id,created_by)
      VALUES(${shared},${project},${ticket},${user}),(${personal},${project},NULL,${user})`;
    const marker = async () => {
      const [row] = await database.client<
        { revision: string }[]
      >`SELECT revision FROM factory.read_version
        WHERE project_id=${project} AND scope='ticket' AND resource_id=${ticket} AND audience='shared'`;
      if (!row) throw new Error("The owned Ticket read version is missing");
      return row.revision;
    };
    const before = await marker();
    await database.client`UPDATE factory.ticket SET updated_at=now() WHERE id=${ticket}`;
    expect(await marker()).toBe(before);
    await expect(
      database.client.begin(async (sql) => {
        await sql`UPDATE factory.ticket SET title='Rolled back' WHERE id=${ticket}`;
        throw new Error("rollback");
      }),
    ).rejects.toThrow("rollback");
    expect(await marker()).toBe(before);
    await database.client`UPDATE factory.ticket SET title='Committed' WHERE id=${ticket}`;
    expect(await marker()).not.toBe(before);
    await database.client`DELETE FROM factory.read_version WHERE scope='conversation'`;
    for (const [conversation, payload, body] of [
      [shared, { visibility: "developer" }, "Developer-only technical source"],
      [personal, {}, "Private research prompt"],
    ] as const)
      await database.client`INSERT INTO factory.conversation_entry
        (id,conversation_id,ordinal,kind,actor,mode,body,payload,created_by)
        VALUES(${crypto.randomUUID()},${conversation},1,'user-message','user','investigate',${body},${JSON.stringify(payload)}::jsonb,${user})`;
    const zero = zeroDrizzle(zeroSchema, database.db);
    const read = (userId: string, resourceId: string, systemManager = false, projectId = project) =>
      zero.run(
        zeroQueries.readVersions.list.fn({
          args: { projectId, scope: "conversation", resourceId },
          ctx: { userId, systemManager },
        }),
      );
    expect((await read(user, ticket)).map((row) => row.audience)).toEqual(["developer"]);
    expect(await read(contributor, ticket)).toEqual([]);
    expect((await read(user, project)).map((row) => row.audience)).toEqual([user]);
    expect(await read(colleague, project)).toEqual([]);
    expect(await read(colleague, project, true)).toEqual([]);
    expect(await read(user, ticket, false, foreign)).toEqual([]);
    await database.client`DELETE FROM factory.read_version WHERE scope='inbox'`;
    await database.client`INSERT INTO factory.ticket_follow(ticket_id,user_id,following) VALUES(${ticket},${user},true)`;
    const personalInbox = (userId: string) =>
      zero.run(
        zeroQueries.readVersions.list.fn({
          args: { scope: "inbox" },
          ctx: { userId },
        }),
      );
    expect((await personalInbox(user)).map((row) => row.audience)).toEqual([user]);
    expect(await personalInbox(colleague)).toEqual([]);
    const turn = crypto.randomUUID(),
      owner = crypto.randomUUID();
    await database.client`INSERT INTO factory.agent_turn
      (id,command_id,project_id,ticket_id,conversation_id,created_by,input,input_digest,authority,state,owner_token,owner_expires_at)
      VALUES(${turn},${turn},${project},${ticket},${shared},${user},
        '{"kind":"project-message","text":"Private provider input stays out of sync"}'::jsonb,
        ${"a".repeat(64)},'{"mode":"investigate"}'::jsonb,'running',${owner},now()+interval '1 minute')`;
    const beforeLease = JSON.stringify(await read(user, ticket));
    await database.client`UPDATE factory.agent_turn SET owner_expires_at=now()+interval '2 minutes',updated_at=now() WHERE id=${turn}`;
    expect(JSON.stringify(await read(user, ticket))).toBe(beforeLease);
    const retained = await database.client`SELECT * FROM factory.read_version`;
    expect(JSON.stringify(retained)).not.toContain("Private research prompt");
    expect(JSON.stringify(retained)).not.toContain("technical source");
    await database.client`DELETE FROM factory.project_membership WHERE project_id=${project} AND user_id=${user}`;
    expect(await read(user, ticket)).toEqual([]);
    expect(await read(user, project)).toEqual([]);
  } finally {
    await database.client.end();
    await host.dispose();
  }
}, 60_000);

test("bounded planning reads retain history search and subscribe to only the selected Wiki body", async () => {
  const host = await factoryProcess();
  const database = host.connect(2);
  const user = crypto.randomUUID(),
    project = crypto.randomUUID();
  const active = crypto.randomUUID(),
    removed = crypto.randomUUID(),
    page = crypto.randomUUID();
  const reference = "ffffff00-0000-4000-8000-000000000000";
  const leadingZero = "00000100-0000-4000-8000-000000000000";
  try {
    await database.client`INSERT INTO auth."user"(id,name,email) VALUES(${user},'Owned bounded proof',${`${user}@read.test`})`;
    await database.client`INSERT INTO factory.project(id,slug,name,repository_url,default_branch,devcontainer_path,created_by)
      VALUES(${project},${`reads-${project}`},'Read proof','https://example.invalid/read.git','main','.devcontainer/devcontainer.json',${user})`;
    await database.client`INSERT INTO factory.project_membership(project_id,user_id,role,updated_by)
      VALUES(${project},${user},'developer',${user})`;
    for (let index = 0; index < 53; index++)
      await database.client`INSERT INTO factory.ticket(id,project_id,title,state,created_by,updated_at)
        VALUES(${index === 0 ? reference : index === 1 ? leadingZero : crypto.randomUUID()},${project},
        ${index === 0 ? "Old invoice history" : `Completed ${index}`},'done',${user},${new Date(index * 1000).toISOString()}::timestamptz)`;
    await database.client`INSERT INTO factory.ticket(id,project_id,title,created_by)
      VALUES(${active},${project},'Current invoice',${user}),(${removed},${project},'Removed invoice',${user})`;
    await database.client`UPDATE factory.ticket SET trashed_at=now(),trashed_by=${user} WHERE id=${removed}`;
    const zero = zeroDrizzle(zeroSchema, database.db),
      ctx = { userId: user };
    const args = { projectId: project, limit: 3 };
    expect(
      (await zero.run(zeroQueries.tickets.active.fn({ args, ctx }))).map((row) => row.id),
    ).toEqual([active]);
    expect(await zero.run(zeroQueries.tickets.history.fn({ args, ctx }))).toHaveLength(3);
    expect(
      (await zero.run(zeroQueries.tickets.trash.fn({ args, ctx }))).map((row) => row.id),
    ).toEqual([removed]);
    for (const text of ["TCK-FFFFFF", "TCK-FFFF", "old invoice"])
      expect(
        (
          await zero.run(zeroQueries.tickets.find.fn({ args: { projectId: project, text }, ctx }))
        ).map((row) => row.id),
      ).toContain(reference);
    expect(
      (
        await zero.run(
          zeroQueries.tickets.find.fn({ args: { projectId: project, text: "TCK-000001" }, ctx }),
        )
      ).map((row) => row.id),
    ).toEqual([leadingZero]);
    expect(
      await zero.run(zeroQueries.tickets.find.fn({ args: { projectId: project, text: "" }, ctx })),
    ).toHaveLength(51);
    await database.client`INSERT INTO factory.knowledge_page
      (id,project_id,slug,title,current_body,generated_body,source_commit_sha,created_by)
      VALUES(${page},${project},'invoice','Invoice','Selected page body','Selected page body',${"a".repeat(40)},${user})`;
    const outline = await zero.run(
      zeroQueries.knowledge.outline.fn({ args: { projectId: project }, ctx }),
    );
    expect(outline).toHaveLength(1);
    expect(outline[0]).not.toHaveProperty("currentBody");
    expect(JSON.stringify(outline)).not.toContain("Selected page body");
    const selected = await zero.run(
      zeroQueries.knowledge.page.fn({ args: { projectId: project, pageId: page }, ctx }),
    );
    expect(selected?.currentBody).toBe("Selected page body");
    await database.client`UPDATE factory.knowledge_page SET title='Revised invoice',version=version+1 WHERE id=${page}`;
    expect(
      (await zero.run(zeroQueries.knowledge.outline.fn({ args: { projectId: project }, ctx })))[0]
        ?.title,
    ).toBe("Revised invoice");
    await database.client`UPDATE factory.knowledge_page SET state='archived' WHERE id=${page}`;
    expect(
      await zero.run(zeroQueries.knowledge.outline.fn({ args: { projectId: project }, ctx })),
    ).toEqual([]);
    expect(
      await zero.run(
        zeroQueries.knowledge.page.fn({ args: { projectId: project, pageId: page }, ctx }),
      ),
    ).toBeUndefined();
  } finally {
    await database.client.end();
    await host.dispose();
  }
}, 60_000);
