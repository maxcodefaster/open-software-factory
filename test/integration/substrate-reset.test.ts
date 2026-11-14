import { expect, test } from "bun:test";
import { createChangeAgentStop } from "../../apps/factory/src/agent/stop";
import {
  nativeCapacityOwner,
  nativeCapacityPool,
  renderNativeCapacityPool,
} from "../../packages/runtime-kubernetes/src/substrate-capacity";
import { readResetResources } from "../../scripts/factory/reset-resources";
import { startSubstrateFixtureWorkspace, substrateFixture } from "../fixtures/substrate";
import { nativeCapacityFixture } from "../fixtures/substrate-capacity";

test("reset inventory uses native baseline records, including unbound provisioning and retained IDE/capacity intents", async () => {
  const f = await substrateFixture();
  try {
    expect(await readResetResources(f.database)).toEqual({
      nativeScopes: [],
      editorNamespaces: [],
      capacityPools: [],
    });
    const namespace = `fa-${f.attemptID.replaceAll("-", "")}`;
    // A recorded provision is included even before its first external call or
    // Actor binding. Unknown dispatched creates below must refuse reset.
    await f.database.client`INSERT INTO factory.substrate_workspace(workspace_id,generation,intent)
      VALUES(${f.workspaceID},1,${JSON.stringify({ configuration: { connection: f.config.connection } })}::jsonb)`;
    const resourceID = crypto.randomUUID();
    await f.database.client`INSERT INTO factory.developer_ide(user_id,state,image,resource_id)
      VALUES(${f.userID},'stopped',${`registry.invalid/ide@sha256:${"a".repeat(64)}`},${resourceID})`;
    const capacity = nativeCapacityFixture();
    const nodeUID = crypto.randomUUID();
    const pool = renderNativeCapacityPool(
      nativeCapacityPool.parse(capacity.base),
      {
        name: "owned",
        uid: nodeUID,
        bootID: crypto.randomUUID(),
        hostname: "owned",
        architecture: "amd64",
        resources: { cpuMilli: 2000, memoryMiB: 4096 },
      },
      capacity.selector,
      crypto.randomUUID(),
    );
    await f.database.client`INSERT INTO factory.substrate_worker_capacity(owner,node_uid,intent)
      VALUES(${nativeCapacityOwner(capacity.selector)},${nodeUID},
        ${JSON.stringify({ database: f.config.database, node: { uid: nodeUID }, pool })}::jsonb)`;
    expect(await readResetResources(f.database)).toEqual({
      nativeScopes: [{ name: namespace, connection: f.config.connection }],
      editorNamespaces: [`factory-editor-${resourceID.replaceAll("-", "")}`],
      capacityPools: [{ namespace: pool.metadata.namespace, name: pool.metadata.name }],
    });
    await f.database.client`UPDATE factory.substrate_worker_capacity SET attempted_at=now()`;
    await expect(readResetResources(f.database)).rejects.toThrow(
      "native create outcome is unconfirmed",
    );
    // A positive rejection settles that create, but cannot settle another one.
    await f.database.client`UPDATE factory.substrate_worker_capacity SET rejected=true`;
    expect((await readResetResources(f.database)).nativeScopes).toHaveLength(1);
    await f.database.client`UPDATE factory.substrate_workspace SET atespace_attempted_at=now()
      WHERE workspace_id=${f.workspaceID}`;
    await expect(readResetResources(f.database)).rejects.toThrow(
      "native create outcome is unconfirmed",
    );
  } finally {
    await f.dispose();
  }
}, 60_000);

test("native reset refuses an active Actor before taking an erasable inventory", async () => {
  const f = await substrateFixture();
  try {
    await startSubstrateFixtureWorkspace(f);
    await expect(readResetResources(f.database)).rejects.toThrow("finish active runtimes");
  } finally {
    await f.dispose();
  }
}, 60_000);

test("failed compute does not let reset discard an unconfirmed Coding Stop", async () => {
  const f = await substrateFixture("a".repeat(40), "ticket");
  try {
    // Controlled baseline records only. No Actor, engine or Source writer is
    // started to test this database-only reset refusal.
    await f.database.client`INSERT INTO factory.substrate_workspace(workspace_id,generation,intent)
      VALUES(${f.workspaceID},1,${JSON.stringify({ configuration: { connection: f.config.connection } })}::jsonb)`;
    await f.database.client.begin(async (sql) => {
      await sql`INSERT INTO factory.runtime_attempt(
        id,project_id,workspace_id,change_id,generation,revision,state,
        parent_connector_token_hash,child_connector_token_hash,create_intended_at,created_by)
        VALUES(${f.attemptID},${f.projectID},${f.workspaceID},${f.changeID},1,${"a".repeat(40)},
          'create-intended',${"b".repeat(64)},${"c".repeat(64)},now(),${f.userID})`;
      await sql`INSERT INTO factory.substrate_binding(runtime_attempt_id,atespace,actor_name,intent)
        VALUES(${f.attemptID},${f.atespace},${`runtime-${f.attemptID.replaceAll("-", "")}`},
          ${JSON.stringify({ connection: f.config.connection })}::jsonb)`;
      await sql`UPDATE factory.runtime_attempt SET state='failed' WHERE id=${f.attemptID}`;
      await sql`UPDATE factory.change SET runtime_attempt_id=${f.attemptID} WHERE id=${f.changeID}`;
      await sql`INSERT INTO factory.change_agent_session(
        change_id,runtime_attempt_id,opencode_session_id,state,created_by)
        VALUES(${f.changeID},${f.attemptID},'owned-native-session','working',${f.userID})`;
    });
    await expect(readResetResources(f.database)).rejects.toThrow("unconfirmed Coding Stop");
    await createChangeAgentStop(f.database, f.hub).persist(f.changeID);
    await expect(readResetResources(f.database)).rejects.toThrow("unconfirmed Coding Stop");
  } finally {
    await f.dispose();
  }
}, 60_000);
