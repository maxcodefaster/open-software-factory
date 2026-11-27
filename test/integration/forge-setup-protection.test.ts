import { expect, test } from "bun:test";
import { forgeUsername } from "#forge/access";
import { createForgeAccessReconciliation } from "../../apps/factory/src/access/forge";
import { fixture } from "../fixtures/change-agent-turns";
import { factoryProcess } from "../fixtures/factory-process";

test("Change branch reconciliation persists exact text writers before confirming Forge protection", async () => {
  const owned = await fixture();
  const owner = "factory";
  let expectedWriters: readonly string[] = [];
  let protections = 0;
  let loseProtectionResponse = false;
  try {
    const forge = createForgeAccessReconciliation({
      database: owned.database,
      owner,
      origin: "https://example.invalid",
      publicOrigin: "https://example.invalid",
      forge: {
        readAccount: async () => undefined,
        ensureAccount: async () => 1,
        removeAlternativeGrants: async () => {},
        repositoryGrant: async () => {},
        protectBranch: async (input) => {
          expect(input.writers).toEqual(expectedWriters);
          const [intent] = await owned.database.client<
            { writers: string[]; merger: string; confirmed: boolean }[]
          >`SELECT payload->'writers' AS writers,payload->>'merger' AS merger,
              COALESCE((result->>'confirmed')::boolean, false) AS confirmed
            FROM factory.operation
            WHERE idempotency_key=${`forge.branch:${owned.projectID}:${input.branch}`}`;
          expect(intent).toEqual({
            writers: [...expectedWriters],
            merger: owner,
            confirmed: false,
          });
          protections++;
          if (loseProtectionResponse) throw new Error("Owned protection acknowledgement lost");
        },
      },
    });
    for (const writers of [
      [],
      ["developer-two", "developer-one"],
      ["writer'quoted", "writer,comma", 'writer"quoted', "writer\\slash", "writer'quoted"],
    ]) {
      expectedWriters = Object.freeze([...writers]);
      await forge.protectChange(owned.changeID, expectedWriters);
      const [intent] = await owned.database.client<
        { writers: string[]; merger: string; confirmed: boolean }[]
      >`SELECT payload->'writers' AS writers,payload->>'merger' AS merger,
          COALESCE((result->>'confirmed')::boolean, false) AS confirmed
        FROM factory.operation
        WHERE idempotency_key=(
          SELECT 'forge.branch:' || ${owned.projectID} || ':' || branch_name
          FROM factory.change WHERE id=${owned.changeID}
        )`;
      expect(intent).toEqual({ writers: [...expectedWriters], merger: owner, confirmed: true });
    }
    expect(protections).toBe(3);
    loseProtectionResponse = true;
    await expect(forge.protectChange(owned.changeID, expectedWriters)).rejects.toThrow(
      "acknowledgement lost",
    );
    const [unconfirmed] = await owned.database.client<{ confirmed: boolean }[]>`
      SELECT COALESCE((result->>'confirmed')::boolean, false) AS confirmed
      FROM factory.operation
      WHERE kind='forge.branch'
        AND payload->>'projectId'=${owned.projectID}
        AND payload->'writers'=${JSON.stringify([...expectedWriters])}::jsonb`;
    expect(unconfirmed?.confirmed).toBe(false);
    loseProtectionResponse = false;
    await forge.protectChange(owned.changeID, expectedWriters);
    expect(protections).toBe(5);
  } finally {
    await owned.dispose();
  }
}, 30_000);

test("account reconciliation preserves initial import setup's workflow ownership", async () => {
  const host = await factoryProcess();
  const database = host.connect(1);
  try {
    const owned = await fixture(undefined, undefined, database);
    await database.client`INSERT INTO factory.operation(id,kind,scope_type,scope_id,idempotency_key,state,created_by,payload,completed_at)
      VALUES(${crypto.randomUUID()},'access.forge_connection','installation','00000000-0000-0000-0000-000000000000','access.forge_connection:singleton','ready',${owned.userID},
        ${JSON.stringify({
          sourceName: "Factory",
          discoveryUrl: "https://example.invalid/oidc",
          redirectUri: "https://example.invalid/callback",
          sourceId: 1,
          intendedBy: owned.userID,
          observedAt: new Date().toISOString(),
        })}::jsonb,now())`;
    const protections: Array<{ branch: string; protectedFiles?: string }> = [];
    const forge = createForgeAccessReconciliation({
      database,
      owner: "factory",
      origin: "https://example.invalid",
      publicOrigin: "https://example.invalid",
      forge: {
        readAccount: async () => undefined,
        ensureAccount: async () => 1,
        removeAlternativeGrants: async () => {},
        repositoryGrant: async () => {},
        protectBranch: async (input) => {
          expect(input.writers).toEqual([]);
          protections.push(input);
        },
      },
    });
    await database.client`UPDATE factory.project SET repository_url=${`https://example.invalid/factory/build-turn-${owned.projectID.replaceAll("-", "").slice(0, 12)}.git`}
      WHERE id=${owned.projectID}`;
    await forge.reconcile(owned.userID);
    expect(protections.at(-1)?.protectedFiles).toBe(".forgejo/workflows/factory-verification.yml");
    await database.client`INSERT INTO factory.operation(id,kind,scope_type,scope_id,idempotency_key,state,payload,created_by,completed_at)
      SELECT ${crypto.randomUUID()},'projects.repository_intent','project',id::text,'projects.repository_intent:' || id::text,'committed',
        jsonb_build_object('setupId',${crypto.randomUUID()}::text,'name',name,'slug',slug,'kind','import','sourceUrl','https://example.invalid/owned/import','credentialKey',NULL,'fingerprint',${"a".repeat(64)}::text),
        ${owned.userID},now()
      FROM factory.project WHERE id=${owned.projectID}`;
    await forge.reconcile(owned.userID);
    expect(protections.at(-1)?.protectedFiles).toBeUndefined();
    await database.client`INSERT INTO factory.operation(id,kind,scope_type,scope_id,idempotency_key,state,payload,created_by,completed_at)
      VALUES(${crypto.randomUUID()},'projects.setup_readiness','project',${owned.projectID},${`projects.setup_readiness:${owned.projectID}:configuration`},'ready',${JSON.stringify({ task: "configuration", commandId: crypto.randomUUID() })}::jsonb,${owned.userID},now())`;
    await forge.reconcile(owned.userID);
    expect(protections.at(-1)?.protectedFiles).toBe(".forgejo/workflows/factory-verification.yml");
  } finally {
    await database.client.end({ timeout: 2 });
    await host.dispose();
  }
}, 30_000);

test.each(["private", "public"] as const)(
  "account reconciliation grants the configured %s Forge identity but never another host",
  async (scope) => {
    const host = await factoryProcess();
    const database = host.connect(1);
    try {
      const owned = await fixture(undefined, undefined, database);
      const origin = "http://forge.private.test";
      const publicOrigin = "https://git.public.test";
      const repository = `build-turn-${owned.projectID.replaceAll("-", "").slice(0, 12)}`;
      const other = crypto.randomUUID();
      await database.client`UPDATE factory.project
        SET repository_url=${`${scope === "public" ? publicOrigin : origin}/factory/${repository}.git`}
        WHERE id=${owned.projectID}`;
      await database.client`INSERT INTO factory.project(id,slug,name,repository_url,default_branch,actor_template_path,created_by)
        VALUES(${other},${`foreign-${other}`},'External Project',${`https://foreign.invalid/factory/foreign-${other}`},'main','.factory/actor-template.json',${owned.userID})`;
      await database.client`INSERT INTO factory.project_membership(project_id,user_id,role,updated_by)
        VALUES(${other},${owned.userID},'developer',${owned.userID})`;
      await database.client`INSERT INTO factory.operation(id,kind,scope_type,scope_id,idempotency_key,state,created_by,payload,completed_at)
        VALUES(${crypto.randomUUID()},'access.forge_connection','installation','00000000-0000-0000-0000-000000000000','access.forge_connection:singleton','ready',${owned.userID},
          ${JSON.stringify({
            sourceName: "Factory",
            discoveryUrl: "https://example.invalid/oidc",
            redirectUri: "https://example.invalid/callback",
            sourceId: 1,
            intendedBy: owned.userID,
            observedAt: new Date().toISOString(),
          })}::jsonb,now())`;
      const grants: Array<{ repository: string; enabled: boolean }> = [];
      const access = createForgeAccessReconciliation({
        database,
        owner: "factory",
        origin,
        publicOrigin,
        forge: {
          readAccount: async () => undefined,
          ensureAccount: async () => 1,
          removeAlternativeGrants: async (_userID, allowed) => {
            expect(allowed).toEqual([{ owner: "factory", name: repository }]);
          },
          repositoryGrant: async (_owner, name, _userID, enabled) => {
            grants.push({ repository: name, enabled });
          },
          protectBranch: async () => {},
        },
      });
      await access.reconcile(owned.userID);
      expect(grants).toEqual([{ repository, enabled: true }]);
      expect([
        ...(await database.client`SELECT (result->>'confirmed')::boolean AS confirmed
        FROM factory.operation
        WHERE idempotency_key=${`forge.grant:${owned.projectID}:${owned.userID}`}`),
      ]).toEqual([{ confirmed: true }]);
      expect(
        await database.client`SELECT payload->>'projectId' AS project_id
        FROM factory.operation
        WHERE kind='forge.grant' AND payload->>'projectId'=${other}`,
      ).toHaveLength(0);
      for (const repositoryURL of [
        `${publicOrigin}/factory/wrong-repository.git`,
        `${publicOrigin}/other-owner/${repository}.git`,
        `${publicOrigin}/factory/${repository}.git?token=owned-secret`,
        `${publicOrigin}/factory/${repository}.git#other`,
        `https://user:owned-secret@git.public.test/factory/${repository}.git`,
      ]) {
        await database.client`UPDATE factory.project SET repository_url=${repositoryURL} WHERE id=${owned.projectID}`;
        await expect(access.reconcile(owned.userID)).rejects.toThrow("recorded forge identity");
      }
      expect(grants).toEqual([{ repository, enabled: true }]);
    } finally {
      await database.client.end({ timeout: 2 });
      await host.dispose();
    }
  },
  30_000,
);

test.each(["lost-grant", "authority-loss"] as const)(
  "reconciliation retains intent and keeps the account suspended after %s, then observes the exact current permission",
  async (failure) => {
    const host = await factoryProcess();
    const database = host.connect(1);
    try {
      const owned = await fixture(undefined, undefined, database);
      const repository = `build-turn-${owned.projectID.replaceAll("-", "").slice(0, 12)}`;
      await database.client`UPDATE factory.project SET repository_url=${`https://git.owned.test/factory/${repository}.git`} WHERE id=${owned.projectID}`;
      await database.client`INSERT INTO factory.operation(id,kind,scope_type,scope_id,idempotency_key,state,created_by,payload,completed_at)
        VALUES(${crypto.randomUUID()},'access.forge_connection','installation','00000000-0000-0000-0000-000000000000','access.forge_connection:singleton','ready',${owned.userID},
          ${JSON.stringify({
            sourceName: "Factory",
            discoveryUrl: "https://factory.owned.test/oidc",
            redirectUri: "https://git.owned.test/callback",
            sourceId: 7,
            intendedBy: owned.userID,
            observedAt: new Date().toISOString(),
          })}::jsonb,now())`;
      let fail = true;
      let accountCreated = false;
      const enabled: boolean[] = [];
      const access = createForgeAccessReconciliation({
        database,
        owner: "factory",
        origin: "https://git.owned.test",
        publicOrigin: "https://git.owned.test",
        forge: {
          readAccount: async () =>
            accountCreated
              ? {
                  id: 71,
                  login: forgeUsername(owned.userID),
                  login_name: owned.userID,
                  source_id: 7,
                  active: false,
                  prohibit_login: true,
                  is_admin: false,
                  restricted: true,
                }
              : undefined,
          ensureAccount: async (input) => {
            enabled.push(input.enabled);
            accountCreated = true;
            return 71;
          },
          removeAlternativeGrants: async () => {},
          protectBranch: async () => {},
          repositoryGrant: async (_owner, _repository, userID, desired) => {
            const [intent] = await database.client<
              { desired: boolean; confirmed: boolean | null }[]
            >`
              SELECT (payload->>'desired')::boolean AS desired,
                (result->>'confirmed')::boolean AS confirmed
              FROM factory.operation
              WHERE idempotency_key=${`forge.grant:${owned.projectID}:${userID}`}`;
            expect(intent).toEqual({ desired, confirmed: null });
            if (fail) {
              if (failure === "lost-grant") throw new Error("Owned grant acknowledgement lost");
              await database.client`UPDATE factory.project_membership SET role='product-contributor' WHERE project_id=${owned.projectID} AND user_id=${userID}`;
            }
          },
        },
      });
      await expect(access.reconcile(owned.userID)).rejects.toThrow(
        failure === "lost-grant" ? "acknowledgement lost" : "permissions changed",
      );
      expect(enabled).toEqual([false]);
      const [unsettled] = await database.client<{ state: string; source: number }[]>`
        SELECT state,(payload->>'sourceId')::int AS source FROM factory.operation
        WHERE active_key=${`forge.account:${owned.userID}`}`;
      expect(unsettled).toEqual({ state: "create-intended", source: 7 });
      fail = false;
      await access.reconcile(owned.userID);
      const desired = failure === "lost-grant";
      const [settled] = await database.client<{ state: string; observed: number }[]>`
        SELECT state,(result->>'forgeUserId')::int AS observed FROM factory.operation
        WHERE active_key=${`forge.account:${owned.userID}`}`;
      expect(settled).toEqual({ state: desired ? "ready" : "disabled", observed: 71 });
      const [grant] = await database.client<{ desired: boolean; confirmed: boolean }[]>`
        SELECT (payload->>'desired')::boolean AS desired,
          (result->>'confirmed')::boolean AS confirmed
        FROM factory.operation
        WHERE idempotency_key=${`forge.grant:${owned.projectID}:${owned.userID}`}`;
      expect(grant).toEqual({ desired, confirmed: desired });
      expect(enabled).toEqual([false, false, desired]);
    } finally {
      await database.client.end({ timeout: 2 });
      await host.dispose();
    }
  },
  60_000,
);
