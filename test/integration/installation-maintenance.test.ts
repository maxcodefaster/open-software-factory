import { expect, test } from "bun:test";
import { createAgentTurnStore } from "../../apps/factory/src/agent/turn-store";
import {
  beginInstallationMaintenance,
  finishInstallationMaintenance,
  installationInMaintenance,
} from "../../apps/factory/src/installation/maintenance";
import { createUsageJournal } from "../../apps/factory/src/usage/journal";
import { unknownCounters } from "../../packages/conversation-domain/src/usage";
import type { createDatabase } from "../../packages/db/src/client";
import { eventually, factoryProcess } from "../fixtures/factory-process";

test("upgrade admission serializes against real inference intent and never discards pending work", async () => {
  const host = await factoryProcess();
  const database = host.connect();
  const userID = crypto.randomUUID();
  const projectID = crypto.randomUUID();
  const generationID = crypto.randomUUID();
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let writing: Promise<unknown> | undefined;
  try {
    await database.client`
      INSERT INTO auth."user"(id,name,email,email_verified)
      VALUES(${userID},'Owned maintenance fixture',${`maintenance-${userID}@factory.local`},true)`;
    await database.client`
      INSERT INTO factory.project(id,slug,name,repository_url,default_branch,devcontainer_path,created_by)
      VALUES(${projectID},${`maintenance-${projectID}`},'Owned maintenance fixture',
        'https://example.invalid/maintenance','main','.devcontainer/devcontainer.json',${userID})`;
    writing = database.client.begin(async (sql) => {
      await sql`
        INSERT INTO factory.knowledge_generation(id,project_id,source_commit_sha,created_by)
        VALUES(${generationID},${projectID},${"a".repeat(40)},${userID})`;
      entered.resolve();
      await release.promise;
    });
    await entered.promise;
    const maintenance = beginInstallationMaintenance(database).then(
      () => ({ allowed: true, message: "" }),
      (cause: Error) => ({ allowed: false, message: cause.message }),
    );
    await eventually(
      async () => {
        const [waiting] = await database.client<{ waiting: boolean }[]>`
          SELECT EXISTS(SELECT 1 FROM pg_stat_activity
            WHERE datname=current_database() AND wait_event_type='Lock'
              AND query LIKE '%UPDATE factory.installation_maintenance SET enabled=true%') AS waiting`;
        return waiting?.waiting;
      },
      Boolean,
      "Maintenance did not wait for the actual concurrent admission transaction",
    );
    release.resolve();
    await writing;
    const result = await maintenance;
    expect(result.allowed).toBe(false);
    expect(result.message).toContain("Finish or explicitly stop");
    expect(await installationInMaintenance(database)).toBe(false);
    const [retained] = await database.client<{ state: string }[]>`
      SELECT state FROM factory.knowledge_generation WHERE id=${generationID}`;
    expect(retained?.state).toBe("pending");

    await database.client`
      UPDATE factory.knowledge_generation SET state='failed',completed_at=now()
      WHERE id=${generationID}`;
    await beginInstallationMaintenance(database);
    expect(await installationInMaintenance(database)).toBe(true);
    const admitWhilePaused = async () => {
      await database.client`
        INSERT INTO factory.knowledge_generation(id,project_id,source_commit_sha,created_by)
        VALUES(${crypto.randomUUID()},${projectID},${"a".repeat(40)},${userID})`;
    };
    await expect(admitWhilePaused()).rejects.toThrow("maintenance");
    await finishInstallationMaintenance(database);
    expect(await installationInMaintenance(database)).toBe(false);
    await database.client`
      INSERT INTO factory.knowledge_generation(id,project_id,source_commit_sha,created_by)
      VALUES(${crypto.randomUUID()},${projectID},${"a".repeat(40)},${userID})`;
  } finally {
    release.resolve();
    await writing?.catch(() => {});
    await database.client.end();
    await host.dispose();
  }
}, 60_000);

async function dispatchedProject(database: ReturnType<typeof createDatabase>) {
  const userID = crypto.randomUUID();
  const projectID = crypto.randomUUID();
  const conversationID = crypto.randomUUID();
  await database.client`INSERT INTO auth."user"(id,name,email,email_verified)
    VALUES(${userID},'Owned expired planning',${`planning-${userID}@factory.local`},true)`;
  await database.client`INSERT INTO factory.project(id,slug,name,repository_url,default_branch,devcontainer_path,created_by)
    VALUES(${projectID},${`planning-${projectID}`},'Owned expired planning',
      'https://example.invalid/planning','main','.devcontainer/devcontainer.json',${userID})`;
  await database.client`INSERT INTO factory.project_membership(project_id,user_id,role,updated_by)
    VALUES(${projectID},${userID},'developer',${userID})`;
  await database.client`INSERT INTO factory.ticket_conversation(id,project_id,mode,created_by)
    VALUES(${conversationID},${projectID},'plan',${userID})`;
  const store = createAgentTurnStore(database);
  const { turn } = await store.admit(
    {
      kind: "project-message",
      commandId: crypto.randomUUID(),
      projectId: projectID,
      ticketId: null,
      conversationId: conversationID,
      createdBy: userID,
      text: "Owned planning dispatch",
    },
    { mode: "plan", conversationVersion: 1, modelId: "owned-maintenance" },
  );
  const owner = await store.claimPending(turn.id);
  if (!owner?.ownerToken) throw new Error("Owned planning owner required");
  expect(await store.beginDispatch(turn.id, owner.ownerToken)).not.toBeNull();
  return { store, turn, owner, userID, projectID };
}

for (const observed of [false, true]) {
  test(`upgrade reconciles expired Project dispatch without replay or lost usage (${observed ? "interrupted" : "unobserved"})`, async () => {
    const host = await factoryProcess();
    const database = host.connect();
    try {
      const { store, turn, owner, userID, projectID } = await dispatchedProject(database);
      const journal = createUsageJournal(database);
      const operationID = `turn:${turn.id}`;
      await journal.begin({
        id: operationID,
        projectID,
        userID,
        purpose: "requirements",
        engine: "mastra",
        provider: "openai",
        model: "owned-maintenance",
        rate: null,
      });
      if (observed) {
        await journal.record(operationID, {
          eventID: "unobserved",
          source: "unobserved",
          outcome: "interrupted",
          counters: unknownCounters(),
          occurredAt: new Date().toISOString(),
        });
        await journal.settle(operationID, "interrupted");
      }
      // Only this fixture's lease expires. No retained installation is modified.
      await database.client`UPDATE factory.agent_turn
        SET owner_expires_at=clock_timestamp()-interval '1 second' WHERE id=${turn.id}`;
      await beginInstallationMaintenance(database);
      expect(await installationInMaintenance(database)).toBe(true);
      expect(await store.get(turn.id)).toMatchObject({
        state: "uncertain",
        ownerToken: null,
        ownerExpiresAt: null,
      });
      expect(await store.settle(turn.id, owner.ownerToken ?? "", "completed", "Late result")).toBe(
        false,
      );
      const [operation] = await database.client<{ outcome: string }[]>`
        SELECT outcome FROM factory.usage_operation WHERE id=${operationID}`;
      expect(operation?.outcome).toBe(observed ? "interrupted" : "unknown");
      const entries = await database.client<{ event_id: string; outcome: string }[]>`
        SELECT event_id,outcome FROM factory.usage_entry WHERE operation_id=${operationID}`;
      expect([...entries]).toEqual([
        {
          event_id: observed ? "unobserved" : "recovery:unobserved",
          outcome: observed ? "interrupted" : "unknown",
        },
      ]);
    } finally {
      await database.client.end();
      await host.dispose();
    }
  }, 60_000);
}

test("upgrade never quarantines a live Project owner to pass its admission guard", async () => {
  const host = await factoryProcess();
  const database = host.connect();
  try {
    const { store, turn, owner } = await dispatchedProject(database);
    await expect(beginInstallationMaintenance(database)).rejects.toThrow(
      "Finish or explicitly stop",
    );
    expect(await installationInMaintenance(database)).toBe(false);
    expect(await store.get(turn.id)).toMatchObject({
      state: "dispatching",
      ownerToken: owner.ownerToken,
    });
  } finally {
    await database.client.end();
    await host.dispose();
  }
}, 60_000);
