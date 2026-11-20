import { expect, test } from "bun:test";
import { createForgeAccessReconciliation } from "../../apps/factory/src/access/forge";
import { forgeUsername } from "../../packages/forge/src/access";
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
          >`SELECT writers,merger,confirmed FROM factory.forge_branch_intent
            WHERE project_id=${owned.projectID} AND branch=${input.branch}`;
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
      >`SELECT writers,merger,confirmed FROM factory.forge_branch_intent
        WHERE project_id=${owned.projectID} AND branch=(
          SELECT branch_name FROM factory.change WHERE id=${owned.changeID}
        )`;
      expect(intent).toEqual({ writers: [...expectedWriters], merger: owner, confirmed: true });
    }
    expect(protections).toBe(3);
    loseProtectionResponse = true;
    await expect(forge.protectChange(owned.changeID, expectedWriters)).rejects.toThrow(
      "acknowledgement lost",
    );
    const [unconfirmed] = await owned.database.client<{ confirmed: boolean }[]>`
      SELECT confirmed FROM factory.forge_branch_intent WHERE project_id=${owned.projectID} AND writers=${[...expectedWriters]}::text[]`;
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
    await database.client`INSERT INTO factory.forge_connection(source_name,discovery_url,redirect_uri,source_id,state,intended_by)
      VALUES('Factory','https://example.invalid/oidc','https://example.invalid/callback',1,'ready',${owned.userID})`;
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
    await database.client`INSERT INTO factory.project_repository_intent(command_id,setup_id,user_id,project_id,name,slug,kind,source_url,fingerprint,state)
      SELECT ${crypto.randomUUID()},${crypto.randomUUID()},${owned.userID},id,name,slug,'import','https://example.invalid/owned/import',${"a".repeat(64)},'committed'
      FROM factory.project WHERE id=${owned.projectID}`;
    await forge.reconcile(owned.userID);
    expect(protections.at(-1)?.protectedFiles).toBeUndefined();
    await database.client`INSERT INTO factory.project_setup_readiness(project_id,task,state,command_id)
      VALUES(${owned.projectID},'configuration','ready',${crypto.randomUUID()})`;
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
      await database.client`INSERT INTO factory.project(id,slug,name,repository_url,default_branch,devcontainer_path,created_by)
        VALUES(${other},${`foreign-${other}`},'External Project',${`https://foreign.invalid/factory/foreign-${other}`},'main','.devcontainer/devcontainer.json',${owned.userID})`;
      await database.client`INSERT INTO factory.project_membership(project_id,user_id,role,updated_by)
        VALUES(${other},${owned.userID},'developer',${owned.userID})`;
      await database.client`INSERT INTO factory.forge_connection(source_name,discovery_url,redirect_uri,source_id,state,intended_by)
        VALUES('Factory','https://example.invalid/oidc','https://example.invalid/callback',1,'ready',${owned.userID})`;
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
        ...(await database.client`SELECT confirmed FROM factory.forge_grant_intent
        WHERE project_id=${owned.projectID} AND user_id=${owned.userID}`),
      ]).toEqual([{ confirmed: true }]);
      expect(
        await database.client`SELECT project_id FROM factory.forge_grant_intent
        WHERE project_id=${other}`,
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
      await database.client`INSERT INTO factory.forge_connection(source_name,discovery_url,redirect_uri,source_id,state,intended_by)
        VALUES('Factory','https://factory.owned.test/oidc','https://git.owned.test/callback',7,'ready',${owned.userID})`;
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
              SELECT desired,confirmed FROM factory.forge_grant_intent WHERE project_id=${owned.projectID} AND user_id=${userID}`;
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
        SELECT state,source_id::int AS source FROM factory.forge_account_intent WHERE user_id=${owned.userID}`;
      expect(unsettled).toEqual({ state: "create-intended", source: 7 });
      fail = false;
      await access.reconcile(owned.userID);
      const desired = failure === "lost-grant";
      const [settled] = await database.client<{ state: string; observed: number }[]>`
        SELECT state,forge_user_id::int AS observed FROM factory.forge_account_intent WHERE user_id=${owned.userID}`;
      expect(settled).toEqual({ state: desired ? "ready" : "disabled", observed: 71 });
      const [grant] = await database.client<{ desired: boolean; confirmed: boolean }[]>`
        SELECT desired,confirmed FROM factory.forge_grant_intent WHERE project_id=${owned.projectID} AND user_id=${owned.userID}`;
      expect(grant).toEqual({ desired, confirmed: desired });
      expect(enabled).toEqual([false, false, desired]);
    } finally {
      await database.client.end({ timeout: 2 });
      await host.dispose();
    }
  },
  60_000,
);
