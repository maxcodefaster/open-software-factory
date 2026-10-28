import { expect, test } from "bun:test";
import { createForgeAccessReconciliation } from "../../apps/factory/src/access/forge";
import { createChangeWriterController } from "../../apps/factory/src/access/writer-controller";
import { createExecutionReserve } from "../../apps/factory/src/runtime/reserve-controller";
import { createReserveStore } from "../../apps/factory/src/runtime/reserve-store";
import { defaultReservePolicy } from "../../packages/runtime-domain/src/reserve";
import { fixture } from "../fixtures/change-agent-turns";
import { executionPoolFixture } from "../fixtures/execution-pool";
import { factoryProcess } from "../fixtures/factory-process";
import {
  installOwnedRuntimeConfiguration,
  ownedFactoryboxProfile,
} from "../fixtures/runtime-configuration";

async function bounded<T>(work: Promise<T>, boundary: string) {
  return Promise.race([
    work,
    Bun.sleep(3_000).then(() => {
      throw new Error(`Application pool blocked by ${boundary}`);
    }),
  ]);
}

test("Forge reconciliation, writer handoff and reserve waits leave a one-connection application pool usable", async () => {
  const restoreConfiguration = installOwnedRuntimeConfiguration();
  const host = await factoryProcess();
  const database = host.connect(1);
  const release = Promise.withResolvers<void>();
  let reserve: ReturnType<typeof createExecutionReserve> | undefined;
  let reconcile: Promise<void> | undefined;
  let pool: Awaited<ReturnType<typeof executionPoolFixture>> | undefined;
  try {
    const owned = await fixture(undefined, undefined, database);
    await database.client`INSERT INTO factory.forge_connection(source_name,discovery_url,redirect_uri,source_id,state,intended_by)
      VALUES('Factory','https://example.invalid/oidc','https://example.invalid/callback',1,'ready',${owned.userID})`;
    const forge = createForgeAccessReconciliation({
      database,
      owner: "factory",
      forge: {
        readAccount: async () => undefined,
        ensureAccount: async () => 1,
        removeAlternativeGrants: async () => {},
        repositoryGrant: async () => {},
        protectBranch: async () => {},
      },
    });
    // A Project with a grant exercises nested branch protection, then final account settlement.
    await database.client`UPDATE factory.project SET repository_url=${`https://example.invalid/factory/build-turn-${owned.projectID.replaceAll("-", "").slice(0, 12)}.git`}
      WHERE id=${owned.projectID}`;
    await bounded(forge.reconcile(owned.userID), "Forge reconciliation");
    const writers = createChangeWriterController({
      database,
      agentUsername: "factory",
      protect: forge.protectChange,
      runtime: { stop: async () => {}, get: async () => ({ state: "stopped" }) },
      stopAgent: async () => {},
    });
    expect(
      (
        await bounded(
          writers.takeOver(owned.changeID, owned.userID, crypto.randomUUID()),
          "writer handoff",
        )
      ).canWrite,
    ).toBe(true);
    await database.client`UPDATE factory.runtime_attempt SET state='stopped' WHERE id=${owned.attemptID}`;
    const entered = Promise.withResolvers<void>();
    const image = `registry.invalid/runtime@sha256:${"1".repeat(64)}`;
    const images = { staging: image, verification: image };
    // Reserve preparation requires an exact healthy source template. An empty
    // database no longer starts anonymous workers merely to fill the pool.
    pool = await executionPoolFixture(
      database,
      createReserveStore(defaultReservePolicy, images, ownedFactoryboxProfile),
      ownedFactoryboxProfile,
      images,
    );
    reserve = createExecutionReserve(database, images, defaultReservePolicy, {
      async prepare() {
        entered.resolve();
        await release.promise;
        return {
          namespaceUID: "namespace",
          podUID: "pod",
          claimUID: "claim",
          ready: false,
          failed: false,
        };
      },
      retire: async () => {},
      activate: async () => ({
        namespaceUID: "namespace",
        podUID: "pod",
        claimUID: "claim",
        ready: true,
        failed: false,
      }),
      removeAssigned: async () => true,
    });
    reconcile = reserve.reconcile();
    await bounded(entered.promise, "reserve entry");
    expect(
      (await bounded(database.client`SELECT 1 AS available`, "reserve wait"))[0]?.["available"],
    ).toBe(1);
  } finally {
    release.resolve();
    await database.client.end({ timeout: 2 });
    await reconcile?.catch(() => undefined);
    await reserve?.close();
    await pool?.cleanup();
    await host.dispose();
    restoreConfiguration();
  }
}, 60_000);
