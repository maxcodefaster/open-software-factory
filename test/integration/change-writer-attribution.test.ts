import { expect, test } from "bun:test";
import { createChangeAdmission } from "../../apps/factory/src/agent/change-admission";
import { createChangeAgentStop } from "../../apps/factory/src/agent/stop";
import { createAgentTurnStore } from "../../apps/factory/src/agent/turn-store";
import { buildModelID, fixture } from "../fixtures/change-agent-turns";

test("shared writer projection names the Agent commissioner without calling them the human holder", async () => {
  const owned = await fixture();
  try {
    const admitted = await createChangeAdmission(owned.database, buildModelID).admit(
      owned.changeID,
      owned.userID,
      { kind: "change-start", commandId: crypto.randomUUID() },
    );
    expect(await owned.writers.view(owned.changeID, owned.userID)).toMatchObject({
      state: "agent-preparing",
      canWrite: false,
      actor: {
        kind: "agent",
        user: { id: owned.userID, name: "Owned Build Admission" },
        delegated: false,
      },
      requester: null,
    });
    await expect(owned.writers.view(owned.changeID, crypto.randomUUID())).rejects.toThrow();
    await owned.writers.prepareAgent(owned.changeID, admitted.turn.id);
    const turns = createAgentTurnStore(owned.database);
    const pending = await turns.claimPending(admitted.turn.id);
    if (!pending?.ownerToken) throw new Error("Owned writer attribution lease missing");
    await turns.failPending(pending.id, pending.ownerToken, "Owned settled failure");
    const before = await owned.writers.status(owned.changeID, owned.userID);
    const after = await owned.writers.status(owned.changeID, owned.userID);
    expect(before).toMatchObject({
      state: "agent",
      canWrite: false,
      actor: { workState: "failed", user: { id: owned.userID } },
    });
    expect(after.epoch).toBe(before.epoch);
    const [runtime] = await owned.database.client<{ state: string }[]>`
      SELECT state FROM factory.runtime_attempt WHERE id=${owned.attemptID}`;
    expect(runtime?.state).toBe("ready");
    expect(owned.requests()).toBe(0);
  } finally {
    await owned.dispose();
  }
});

test("shared writer reads expose pending Stop without clearing it or offering writing", async () => {
  const owned = await fixture();
  try {
    const admitted = await createChangeAdmission(owned.database, buildModelID).admit(
      owned.changeID,
      owned.userID,
      { kind: "change-start", commandId: crypto.randomUUID() },
    );
    await owned.writers.prepareAgent(owned.changeID, admitted.turn.id);
    await createChangeAgentStop(owned.database, owned.hub).persist(owned.changeID);
    const before = await owned.writers.status(owned.changeID, owned.userID);
    const after = await owned.writers.status(owned.changeID, owned.userID);
    expect(before).toMatchObject({
      state: "agent",
      canWrite: false,
      stopPending: true,
      actor: { workState: "stopped", user: { id: owned.userID } },
    });
    expect(after).toEqual(before);
    const [session] = await owned.database.client<{ pending: boolean }[]>`
      SELECT stop_pending AS pending FROM factory.change_agent_session
      WHERE change_id=${owned.changeID}`;
    expect(session?.pending).toBe(true);
    expect(owned.requests()).toBe(0);
    expect(owned.interrupts()).toBe(0);
  } finally {
    await owned.dispose();
  }
});
