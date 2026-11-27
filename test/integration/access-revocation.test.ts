import { expect, test } from "bun:test";
import { createForgeIdentityRoutes } from "../../apps/factory/src/access/forge-routes";
import { createAccessRevocation } from "../../apps/factory/src/access/revocation";
import { eventually, factoryProcess } from "../fixtures/factory-process";

test("native Forge connection confirms independently while failed account reconciliation stays durable", async () => {
  const fixture = await factoryProcess();
  const database = fixture.connect();
  const id = crypto.randomUUID();
  const discoveryURL = "https://factory.test/api/auth/.well-known/openid-configuration";
  const redirectURI = "https://forge.test/user/oauth2/Factory/callback";
  let fresh = true;
  let loseClientReply = true;
  let clientCalls = 0;
  try {
    await database.client`INSERT INTO auth."user"(id,name,email) VALUES(${id},'Owned connection manager',${`${id}@company.test`})`;
    await database.client`INSERT INTO factory.administrator(user_id) VALUES(${id})`;
    const route = createForgeIdentityRoutes({
      database,
      identity: {
        requireFresh: async () => {
          if (!fresh) throw new Error("Owned authentication is not fresh");
        },
        ensureForgeClient: async () => {
          clientCalls++;
          expect(
            (
              await database.client`SELECT payload->>'discoveryUrl' AS discovery_url,
                payload->>'redirectUri' AS redirect_uri,
                payload->>'intendedBy' AS intended_by,
                state
              FROM factory.operation
              WHERE kind='access.forge_connection'`
            )[0],
          ).toEqual({
            discovery_url: discoveryURL,
            redirect_uri: redirectURI,
            intended_by: id,
            state: "create-intended",
          });
          if (loseClientReply) {
            loseClientReply = false;
            throw new Error("Owned lost client reply");
          }
          return "factory-forgejo";
        },
      },
      forgeOrigin: "https://forge.test",
      discoveryURL,
      reconcile: async () => {
        throw new Error("Owned native account mismatch");
      },
    });
    const clientRequest = (discovery = discoveryURL) =>
      new Request("https://factory.test/api/admin/forge/client", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ discoveryURL: discovery, redirectURI }),
      });
    fresh = false;
    await expect(route(clientRequest(), id)).rejects.toThrow("not fresh");
    expect(
      await database.client`SELECT id FROM factory.operation WHERE kind='access.forge_connection'`,
    ).toHaveLength(0);
    fresh = true;
    expect((await route(clientRequest("https://other.test/discovery"), id))?.status).toBe(400);
    expect(clientCalls).toBe(0);
    await expect(route(clientRequest(), id)).rejects.toThrow("lost client reply");
    expect((await route(clientRequest(), id))?.status).toBe(200);
    expect(clientCalls).toBe(2);
    const request = (sourceID: number) =>
      new Request("https://factory.test/api/admin/forge/connection", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sourceID }),
      });
    expect((await route(request(7), id))?.status).toBe(204);
    expect(
      (
        await database.client`SELECT state,payload->>'sourceId' AS source_id
        FROM factory.operation WHERE kind='access.forge_connection'`
      )[0],
    ).toMatchObject({ state: "ready", source_id: "7" });
    expect(
      (
        await database.client`SELECT (payload->>'version')::bigint > (payload->>'processedVersion')::bigint AS pending
        FROM factory.operation WHERE kind='access.revocation' AND scope_id=${id}`
      )[0]?.["pending"],
    ).toBe(true);
    expect((await route(request(8), id))?.status).toBe(409);
    const [before] = await database.client<{ version: string }[]>`
      SELECT payload->>'version' AS version
      FROM factory.operation WHERE kind='access.revocation' AND scope_id=${id}`;
    if (!before) throw new Error("Owned revocation version missing");
    expect((await route(request(7), id))?.status).toBe(204);
    expect(
      (
        await database.client`SELECT payload->>'version' AS version
        FROM factory.operation WHERE kind='access.revocation' AND scope_id=${id}`
      )[0]?.["version"],
    ).toBe(String(BigInt(before.version) + 1n));
  } finally {
    await database.client.end();
    await fixture.dispose();
  }
}, 30_000);

test("failed native reconciliation stays pending without blocking other accounts or server startup", async () => {
  const fixture = await factoryProcess();
  const database = fixture.connect();
  const failedID = crypto.randomUUID();
  const healthyID = crypto.randomUUID();
  const laterIDs: string[] = Array.from({ length: 65 }, () => crypto.randomUUID());
  const observer = createAccessRevocation(database, async (id) => {
    if (id === failedID) throw new Error("Owned invalid forge mapping");
  });
  try {
    const ids = [failedID, healthyID, ...laterIDs];
    await database.client`INSERT INTO auth."user"(id,name,email)
      SELECT id::uuid,'Owned reconciliation',id||'@company.test' FROM unnest(${ids}::text[]) id`;
    await database.client`UPDATE factory.account_access SET disabled_at=now() WHERE user_id=ANY(${ids}::uuid[])`;
    await observer.start();
    const rows = await database.client<{ userID: string; done: boolean }[]>`
      SELECT scope_id AS "userID",(payload->>'version')::bigint=(payload->>'processedVersion')::bigint AS done
      FROM factory.operation WHERE kind='access.revocation'`;
    expect(rows.find((row) => row.userID === failedID)?.done).toBe(false);
    expect(rows.find((row) => row.userID === healthyID)?.done).toBe(true);
    expect(rows.filter((row) => laterIDs.includes(row.userID) && row.done)).toHaveLength(65);
    await expect(observer.drain()).rejects.toThrow("Owned invalid forge mapping");
  } finally {
    await observer.close();
    await database.client.end();
    await fixture.dispose();
  }
}, 30_000);

test("native directory disablement commits recoverable revocation; response loss and a newer change stay pending", async () => {
  const fixture = await factoryProcess();
  const database = fixture.connect();
  const userID = crypto.randomUUID();
  let observer: ReturnType<typeof createAccessRevocation> | undefined;
  try {
    await database.client`INSERT INTO auth."user"(id,name,email) VALUES(${userID},'Owned revoked member',${`${userID}@company.test`})`;
    await database.client`INSERT INTO auth.session(id,user_id,token,expires_at) VALUES(${crypto.randomUUID()},${userID},${crypto.randomUUID()},now()+interval '7 days')`;
    await database.client`UPDATE factory.account_access SET directory_disabled_at=now() WHERE user_id=${userID}`;
    expect(await database.client`SELECT id FROM auth.session WHERE user_id=${userID}`).toHaveLength(
      0,
    );
    const calls: boolean[] = [];
    let lost = true;
    observer = createAccessRevocation(database, async (_, disabled) => {
      calls.push(disabled);
      if (lost) {
        lost = false;
        throw new Error("Owned lost revocation acknowledgement");
      }
    });
    await expect(observer.drain()).rejects.toThrow("lost revocation");
    expect(
      (
        await database.client`SELECT payload->>'processedVersion' AS processed_version
        FROM factory.operation WHERE kind='access.revocation' AND scope_id=${userID}`
      )[0]?.["processed_version"],
    ).toBe("0");
    await observer.close();
    observer = createAccessRevocation(database, async (id, disabled) => {
      calls.push(disabled);
      if (disabled)
        await database.client`UPDATE factory.account_access SET directory_disabled_at=NULL WHERE user_id=${id}`;
    });
    await observer.drain();
    expect(
      (
        await database.client`SELECT payload->>'version' AS version,payload->>'processedVersion' AS processed_version
        FROM factory.operation WHERE kind='access.revocation' AND scope_id=${userID}`
      )[0],
    ).toMatchObject({ version: "2", processed_version: "0" });
    await observer.drain();
    expect(calls).toEqual([true, true, false]);
    await observer.start();
    await database.client`UPDATE factory.account_access SET disabled_at=now() WHERE user_id=${userID}`;
    await eventually(
      async () =>
        (
          await database.client`SELECT (payload->>'version')::bigint=(payload->>'processedVersion')::bigint AS done
          FROM factory.operation WHERE kind='access.revocation' AND scope_id=${userID}`
        )[0]?.["done"],
      Boolean,
      "Committed access notification was not consumed",
    );
    expect(calls.at(-1)).toBe(true);
  } finally {
    await observer?.close();
    await database.client.end();
    await fixture.dispose();
  }
}, 60_000);

test("revocation acknowledgement preserves bigint versions above the safe-integer limit and leaves a newer intent pending", async () => {
  const fixture = await factoryProcess();
  const database = fixture.connect();
  const userID = crypto.randomUUID();
  let calls = 0;
  const observer = createAccessRevocation(database, async () => {
    if (++calls === 1)
      await database.client`UPDATE factory.operation
        SET state='pending',
          payload=jsonb_set(payload,'{version}',to_jsonb(((payload->>'version')::bigint + 1))),
          completed_at=NULL,
          updated_at=now()
        WHERE kind='access.revocation' AND scope_id=${userID}`;
  });
  try {
    await database.client`INSERT INTO auth."user"(id,name,email)
      VALUES(${userID},'Owned exact revocation',${`${userID}@company.test`})`;
    await database.client`INSERT INTO factory.operation(id,kind,scope_type,scope_id,idempotency_key,state,payload)
      VALUES(${crypto.randomUUID()},'access.revocation','user',${userID},${`access.revocation:${userID}`},'pending',
        jsonb_build_object('userId',${userID}::text,'version',9007199254740993::bigint,'processedVersion',0))`;
    await observer.drain();
    expect(
      (
        await database.client`SELECT payload->>'version' AS version,payload->>'processedVersion' AS processed_version
        FROM factory.operation WHERE kind='access.revocation' AND scope_id=${userID}`
      )[0],
    ).toEqual({ version: "9007199254740994", processed_version: "0" });
    await observer.drain();
    expect(
      (
        await database.client`SELECT payload->>'version' AS version,payload->>'processedVersion' AS processed_version
        FROM factory.operation WHERE kind='access.revocation' AND scope_id=${userID}`
      )[0],
    ).toEqual({ version: "9007199254740994", processed_version: "9007199254740994" });
    expect(calls).toBe(2);
  } finally {
    await observer.close();
    await database.client.end();
    await fixture.dispose();
  }
}, 30_000);

test("new Projects commit access reconciliation for existing System Managers and their initial Developer", async () => {
  const fixture = await factoryProcess();
  const database = fixture.connect();
  const managerID = crypto.randomUUID();
  const projectID = crypto.randomUUID();
  try {
    await database.client`INSERT INTO auth."user"(id,name,email) VALUES(${managerID},'Owned manager',${`${managerID}@company.test`})`;
    await database.client`INSERT INTO factory.administrator(user_id) VALUES(${managerID})`;
    await database.client.begin(async (sql) => {
      await sql`INSERT INTO factory.project(id,slug,name,repository_url,default_branch,actor_template_path,created_by)
        VALUES(${projectID},${`owned-${projectID}`},'Owned new Project','https://forge.test/factory/product','main','.factory/actor-template.json',${managerID})`;
      await sql`INSERT INTO factory.project_membership(project_id,user_id,role,manage_project,updated_by)
        VALUES(${projectID},${managerID},'developer',true,${managerID})`;
    });
    expect(
      (
        await database.client`SELECT payload->>'version' AS version,payload->>'processedVersion' AS processed_version
        FROM factory.operation WHERE kind='access.revocation' AND scope_id=${managerID}`
      )[0],
    ).toMatchObject({ version: "2", processed_version: "0" });
    const calls: string[] = [];
    const observer = createAccessRevocation(database, async (id) => {
      calls.push(id);
    });
    try {
      await observer.start();
    } finally {
      await observer.close();
    }
    expect(calls).toEqual([managerID]);
  } finally {
    await database.client.end();
    await fixture.dispose();
  }
}, 30_000);
