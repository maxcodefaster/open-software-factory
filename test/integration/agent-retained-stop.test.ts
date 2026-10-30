import { expect, test } from "bun:test";
import { createChangeAdmission } from "../../apps/factory/src/agent/change-admission";
import { createChangeAgentStop } from "../../apps/factory/src/agent/stop";
import { createUsageJournal } from "../../apps/factory/src/usage/journal";
import { unknownCounters } from "../../packages/conversation-domain/src/usage";
import { buildModelID, fixture } from "../fixtures/change-agent-turns";

test("a stopped reused Session settles its saved Stop through exact retained native evidence", async () => {
  const owned = await fixture();
  const connected = owned.hub.connected;
  owned.hub.connected = () => false;
  const observed: unknown[] = [];
  try {
    const admitted = await createChangeAdmission(owned.database, buildModelID).admit(
      owned.changeID,
      owned.userID,
      { kind: "change-repair", commandId: crypto.randomUUID(), text: "Retained repair" },
    );
    await owned.database.client`UPDATE factory.change_agent_turn_intent
      SET runtime_attempt_id=${owned.attemptID} WHERE turn_id=${admitted.turn.id}`;
    await owned.database.client`UPDATE factory.change_agent_session
      SET state='starting',active_turn_id=${admitted.turn.id} WHERE change_id=${owned.changeID}`;
    const stop = createChangeAgentStop(owned.database, owned.hub, async (target) => {
      observed.push(target);
      return true;
    });
    await stop.persist(owned.changeID);
    await owned.database.client`UPDATE factory.runtime_attempt SET state='stopped'
      WHERE id=${owned.attemptID}`;
    const [before] = await owned.database.client<
      {
        stop_id: string;
        runtime_attempt_id: string;
        opencode_session_id: string;
        stop_turn_id: string;
      }[]
    >`
      SELECT stop_id,runtime_attempt_id,opencode_session_id,stop_turn_id
      FROM factory.change_agent_session WHERE change_id=${owned.changeID}`;
    if (!before) throw new Error("Owned saved Stop is missing");
    const operationID = `turn:${admitted.turn.id}`;
    await createUsageJournal(owned.database).begin({
      id: operationID,
      projectID: owned.projectID,
      userID: owned.userID,
      purpose: "coding",
      engine: "opencode",
      provider: "openai",
      model: buildModelID,
      rate: null,
    });
    expect(await stop.confirm(owned.changeID)).toBe(true);
    expect(observed).toEqual([
      {
        changeID: owned.changeID,
        stopID: before.stop_id,
        attemptID: owned.attemptID,
        sessionID: owned.sessionID,
        promptID: `msg_factory_${admitted.turn.id.replaceAll("-", "")}`,
        mode: "interrupt",
      },
    ]);
    const [after] = await owned.database.client`
      SELECT stop_id,runtime_attempt_id,opencode_session_id,stop_turn_id,stop_pending
      FROM factory.change_agent_session WHERE change_id=${owned.changeID}`;
    expect(after).toEqual({ ...before, stop_pending: false });
    expect(owned.requests()).toBe(0);
    expect(owned.interrupts()).toBe(0);
    expect(owned.commitCalls).toEqual([]);
    const [operation] = await owned.database.client<{ outcome: string; settled: boolean }[]>`
      SELECT outcome,settled_at IS NOT NULL AS settled FROM factory.usage_operation WHERE id=${operationID}`;
    expect(operation).toEqual({ outcome: "interrupted", settled: true });
    const [usage] = await owned.database.client<{ counters: unknown; nano_usd: string | null }[]>`
      SELECT counters,nano_usd::text FROM factory.usage_entry WHERE operation_id=${operationID}`;
    expect(usage).toEqual({ counters: unknownCounters(), nano_usd: null });
    expect(
      await owned.database
        .client`SELECT id FROM factory.agent_turn WHERE change_id=${owned.changeID}`,
    ).toHaveLength(1);
  } finally {
    owned.hub.connected = connected;
    await owned.dispose();
  }
});

test.each(["Stop", "generation", "runtime"] as const)(
  "late retained native proof cannot clear a changed %s",
  async (changed) => {
    const owned = await fixture();
    const connected = owned.hub.connected;
    owned.hub.connected = () => false;
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let checking: Promise<boolean> | undefined;
    try {
      const admitted = await createChangeAdmission(owned.database, buildModelID).admit(
        owned.changeID,
        owned.userID,
        { kind: "change-repair", commandId: crypto.randomUUID(), text: "Owned Stop race" },
      );
      await owned.database.client`UPDATE factory.change_agent_turn_intent
        SET runtime_attempt_id=${owned.attemptID} WHERE turn_id=${admitted.turn.id}`;
      await owned.database.client`UPDATE factory.change_agent_session SET
        state='starting',active_turn_id=${admitted.turn.id} WHERE change_id=${owned.changeID}`;
      const stop = createChangeAgentStop(owned.database, owned.hub, async () => {
        entered.resolve();
        await release.promise;
        return true;
      });
      await stop.persist(owned.changeID);
      await owned.database
        .client`UPDATE factory.runtime_attempt SET state='stopped' WHERE id=${owned.attemptID}`;
      checking = stop.confirm(owned.changeID);
      await entered.promise;
      if (changed === "Stop")
        await owned.database
          .client`UPDATE factory.change_agent_session SET stop_id=${crypto.randomUUID()}
          WHERE change_id=${owned.changeID}`;
      else if (changed === "generation")
        await owned.database
          .client`UPDATE factory.change SET runtime_attempt_id=NULL WHERE id=${owned.changeID}`;
      else
        await owned.database
          .client`UPDATE factory.runtime_attempt SET state='ready' WHERE id=${owned.attemptID}`;
      release.resolve();
      expect(await checking).toBe(false);
      const [session] = await owned.database.client<{ pending: boolean }[]>`
        SELECT stop_pending AS pending FROM factory.change_agent_session WHERE change_id=${owned.changeID}`;
      expect(session?.pending).toBe(true);
      expect(owned.requests()).toBe(0);
      expect(owned.interrupts()).toBe(0);
    } finally {
      release.resolve();
      await checking?.catch(() => {});
      owned.hub.connected = connected;
      await owned.dispose();
    }
  },
);
