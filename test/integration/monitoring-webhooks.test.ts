import { expect, test } from "bun:test";
import { createMonitoringController } from "../../apps/factory/src/monitoring/controller";
import { monitoringDigest, monitoringSignals } from "../../apps/factory/src/monitoring/payload";
import { createMonitoringRoutes } from "../../apps/factory/src/monitoring/routes";
import { factoryProcess } from "../fixtures/factory-process";
import { monitoringFixture } from "../fixtures/monitoring";
import { fixtureValue } from "../fixtures/value";

test("monitoring binds a shared source and Project, deduplicates occurrences and fences changed delegation", async () => {
  const fixture = await factoryProcess();
  const database = fixture.connect();
  const manager = crypto.randomUUID();
  const contributor = crypto.randomUUID();
  const project = crypto.randomUUID();
  const foreign = crypto.randomUUID();
  const connection = crypto.randomUUID();
  const revision = crypto.randomUUID();
  const hook = crypto.randomUUID();
  const woken: string[] = [];
  const controller = createMonitoringController(
    database,
    "owned-monitoring-key",
    "https://factory.example",
    (id) => woken.push(id),
  );
  const routes = createMonitoringRoutes(controller);
  const request = (url: string, value: unknown, extra: RequestInit = {}) =>
    routes.intake(
      new Request(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(value),
        ...extra,
      }),
    );
  const alert = {
    title: "Application exception",
    fingerprint: "owned-defect",
    projectId: foreign,
    context: { stack: "src/invoice.ts:17", token: "must-not-persist" },
  };
  try {
    for (const id of [manager, contributor])
      await database.client`INSERT INTO auth."user"(id,name,email,email_verified) VALUES(${id},'Owned monitoring account',${`${id}@monitoring.test`},true)`;
    await database.client`INSERT INTO factory.administrator(user_id) VALUES(${manager})`;
    for (const id of [project, foreign])
      await database.client`INSERT INTO factory.project(id,slug,name,repository_url,default_branch,devcontainer_path,created_by)
        VALUES(${id},${`monitoring-${id}`},'Owned monitoring Project','https://example.invalid/owned.git','main','.devcontainer/devcontainer.json',${manager})`;
    await database.client`INSERT INTO factory.project_membership(project_id,user_id,role,manage_project,updated_by)
      VALUES(${project},${contributor},'product-contributor',true,${manager})`;
    await database.client`INSERT INTO factory.mcp_library(id,scope,project_id) VALUES(${connection},'project',${project})`;
    await database.client`INSERT INTO factory.mcp_revision(id,library_id,revision,content,digest,created_by)
      VALUES(${revision},${connection},1,${JSON.stringify({
        name: "Owned source",
        description: "Read monitoring data",
        provider: "custom",
        endpoint: "https://source.example/mcp",
        authentication: "none",
        roles: ["planning", "build"],
      })}::jsonb,${"a".repeat(64)},${manager})`;
    const tool = {
      name: "read_issue",
      description: "Read an issue",
      inputSchema: { type: "object" },
      digest: "b".repeat(64),
      readOnlyHint: true,
    };
    await database.client`INSERT INTO factory.mcp_connection(id,revision_id,state,version,credential_epoch,tools,allowed_tools,authorized_by)
      VALUES(${connection},${revision},'ready',2,${crypto.randomUUID()},${JSON.stringify([tool])}::jsonb,
        ${JSON.stringify([{ name: tool.name, digest: tool.digest }])}::jsonb,${manager})`;
    const input = {
      id: hook,
      commandId: crypto.randomUUID(),
      expectedVersion: 0,
      name: "Owned alerts",
      connectionIds: [connection],
      enabled: true,
      delegation: "application-fix-and-delivery" as const,
    };
    await expect(controller.save(project, contributor, input)).rejects.toThrow("Developer");
    await expect(controller.save(foreign, manager, input)).rejects.toThrow("another Project");
    const created = await controller.save(project, manager, input);
    expect(created.url).toMatch(/^https:\/\/factory.example\/hooks\/inputs\//);
    const url = fixtureValue(created.url, "created.url");
    expect(
      (
        await request(url.replace("/hooks/inputs/", "/hooks/monitoring/"), {
          title: "Retained URL route check",
          status: "resolved",
        })
      )?.status,
    ).toBe(202);
    expect(await controller.save(project, manager, input)).toEqual(created);
    await expect(
      controller.save(project, manager, { ...input, name: "Changed command" }),
    ).rejects.toThrow("identity");
    const key = fixtureValue(url.split("/").at(-1), 'url.split("/").at(-1)');
    expect((await request(url.replace(key, "x".repeat(43)), alert))?.status).toBe(404);
    expect(
      (
        await request(url, alert, {
          headers: { origin: "https://foreign.example", "content-type": "application/json" },
        })
      )?.status,
    ).toBe(404);
    const receipts = await Promise.all(Array.from({ length: 8 }, () => request(url, alert)));
    for (const receipt of receipts) expect(receipt?.status).toBe(202);
    expect((await controller.view(project, manager)).incidents).toHaveLength(1);
    let view = await controller.view(project, manager);
    expect(view.incidents[0]?.occurrences).toBe(8);
    expect(woken).toEqual([project]);
    expect((await controller.view(foreign, manager)).incidents).toEqual([]);
    const [incident] = await database.client<{ id: string; context: string; projectId: string }[]>`
      SELECT id,context,project_id AS "projectId" FROM factory.monitoring_incident WHERE hook_id=${hook}`;
    expect(incident?.context).not.toContain("must-not-persist");
    expect(incident?.projectId).toBe(project);
    expect(
      (await controller.authorize(fixtureValue(incident, "incident").id)).assignments[0]
        ?.connectionId,
    ).toBe(connection);
    expect(
      (await request(url, { ...alert, status: "resolved", fingerprint: "resolved" }))?.status,
    ).toBe(202);
    expect((await request(url, [], {}))?.status).toBe(400);
    expect((await request(url, alert, { body: "{" }))?.status).toBe(400);
    expect((await request(url, alert, { body: "x".repeat(128 * 1024 + 1) }))?.status).toBe(409);
    await database.client`UPDATE factory.monitoring_hook SET received_count=119,received_window=now() WHERE id=${hook}`;
    expect((await request(url, alert))?.status).toBe(202);
    expect((await request(url, alert))?.status).toBe(429);
    const rotated = await controller.change(project, hook, manager, "rotate", {
      commandId: crypto.randomUUID(),
      expectedVersion: 1,
    });
    expect(rotated.url).not.toBe(url);
    await expect(controller.authorize(fixtureValue(incident, "incident").id)).rejects.toThrow(
      "disabled",
    );
    expect((await request(url, alert))?.status).toBe(404);
    expect((await request(fixtureValue(rotated.url, "rotated.url"), alert))?.status).toBe(404);
    const enabled = { ...input, commandId: crypto.randomUUID(), expectedVersion: 2 };
    await controller.save(project, manager, enabled);
    await database.client`UPDATE factory.monitoring_hook SET received_count=0 WHERE id=${hook}`;
    expect((await request(fixtureValue(rotated.url, "rotated.url"), alert))?.status).toBe(202);
    view = await controller.view(project, manager);
    expect(view.incidents[0]?.occurrences).toBe(10);
    // Re-enabling does not re-commission the old incident or replace its frozen policy.
    await expect(controller.authorize(fixtureValue(incident, "incident").id)).rejects.toThrow(
      "delegation",
    );
    const [stored] = await database.client<
      { data: string }[]
    >`SELECT row_to_json(hook)::text AS data FROM factory.monitoring_hook hook WHERE id=${hook}`;
    expect(stored?.data).not.toContain(key);
    expect(stored?.data).not.toContain(fixtureValue(rotated.url, "rotated.url").split("/").at(-1));
    const fresh = await request(fixtureValue(rotated.url, "rotated.url"), {
      ...alert,
      fingerprint: "second-defect",
    });
    expect(fresh?.status).toBe(202);
    const newest = fixtureValue(
      (await controller.view(project, manager)).incidents[0],
      "(await controller.view(project, manager)).incidents[0]",
    );
    await database.client`UPDATE factory.mcp_connection SET state='revoked' WHERE id=${connection}`;
    await expect(controller.authorize(newest.id)).rejects.toThrow("Reconnect");
    expect(await controller.view(project, contributor)).toMatchObject({
      canManage: true,
      canDelegate: false,
      canDisable: true,
    });
    await controller.change(project, hook, contributor, "disable", {
      commandId: crypto.randomUUID(),
      expectedVersion: 3,
    });
    expect((await controller.view(project, contributor)).hooks[0]?.enabled).toBe(false);
  } finally {
    await database.client.end();
    await fixture.dispose();
  }
});

test("Input intake serializes the fifty-unsettled bound, rolls back overflow and still counts duplicates", async () => {
  const f = await monitoringFixture();
  const key = fixtureValue(f.url.split("/").at(-1), "owned webhook key");
  const receive = (fingerprints: string[]) =>
    f.controller.receive(
      f.hookId,
      key,
      monitoringDigest(fingerprints),
      fingerprints.flatMap((fingerprint) =>
        monitoringSignals({ title: "Owned bounded request", fingerprint }),
      ),
    );
  const count = async () => {
    const [row] = await f.database.client<{ count: number }[]>`
      SELECT count(*)::integer AS count FROM factory.monitoring_incident WHERE hook_id=${f.hookId}`;
    return row?.count;
  };
  try {
    expect(
      await receive(Array.from({ length: 49 }, (_, index) => `request-${index}`)),
    ).toMatchObject({
      accepted: 49,
    });
    // All three unsettled states consume the same bound.
    await f.database.client`UPDATE factory.monitoring_incident SET state='diagnosing'
      WHERE hook_id=${f.hookId} AND fingerprint=${monitoringSignals({ fingerprint: "request-0" })[0]?.fingerprint ?? ""}`;
    await f.database.client`UPDATE factory.monitoring_incident SET state='implementing'
      WHERE hook_id=${f.hookId} AND fingerprint=${monitoringSignals({ fingerprint: "request-1" })[0]?.fingerprint ?? ""}`;
    await expect(receive(["overflow-first", "overflow-second"])).rejects.toThrow("50 unsettled");
    expect(await count()).toBe(49);
    const [rate] = await f.database.client<{ receivedCount: number }[]>`
      SELECT received_count AS "receivedCount" FROM factory.monitoring_hook WHERE id=${f.hookId}`;
    expect(rate?.receivedCount).toBe(1);

    const competing = await Promise.allSettled([receive(["last-a"]), receive(["last-b"])]);
    expect(competing.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(competing.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect(await count()).toBe(50);
    expect(await receive(["request-0"])).toMatchObject({ accepted: 0, duplicates: 1 });
    expect(await count()).toBe(50);
    expect(
      await f.controller.receive(
        f.hookId,
        key,
        monitoringDigest("resolved"),
        monitoringSignals({ title: "Owned resolved", fingerprint: "ignored", status: "resolved" }),
      ),
    ).toMatchObject({ accepted: 0, duplicates: 0, ignored: 1 });

    await f.database.client`UPDATE factory.monitoring_incident SET state='prepared'
      WHERE hook_id=${f.hookId} AND fingerprint=${monitoringSignals({ fingerprint: "request-1" })[0]?.fingerprint ?? ""}`;
    expect(await receive(["after-settlement"])).toMatchObject({ accepted: 1 });
    expect(await count()).toBe(51);
    await f.database.client`UPDATE factory.monitoring_hook
      SET received_count=120,received_window=now()-interval '2 minutes' WHERE id=${f.hookId}`;
    expect(await receive(["request-0"])).toMatchObject({ limited: false, duplicates: 1 });
    const [reset] = await f.database.client<{ count: number; current: boolean }[]>`
      SELECT received_count AS count,received_window > now()-interval '1 minute' AS current
      FROM factory.monitoring_hook WHERE id=${f.hookId}`;
    expect(reset).toEqual({ count: 1, current: true });
  } finally {
    await f.dispose();
  }
});
