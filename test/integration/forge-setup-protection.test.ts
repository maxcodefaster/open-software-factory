import { expect, test } from "bun:test";
import { createForgeAccessReconciliation } from "../../apps/factory/src/access/forge";
import { fixture } from "../fixtures/change-agent-turns";
import { factoryProcess } from "../fixtures/factory-process";

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
    } finally {
      await database.client.end({ timeout: 2 });
      await host.dispose();
    }
  },
  30_000,
);
