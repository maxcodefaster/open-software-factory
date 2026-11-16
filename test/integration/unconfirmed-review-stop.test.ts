import { expect, test } from "bun:test";
import type { ServerWebSocket } from "bun";
import { createChangeAgentTransport } from "../../apps/factory/src/agent/change-transport";
import { createReviewAdmission } from "../../apps/factory/src/agent/review-admission";
import { createChangeAgentStop } from "../../apps/factory/src/agent/stop";
import {
  beginInstallationMaintenance,
  finishInstallationMaintenance,
  installationInMaintenance,
} from "../../apps/factory/src/installation/maintenance";
import { RuntimeHub, type RuntimeSocketData } from "../../apps/factory/src/runtime/hub";
import { candidateReviewFixture } from "../fixtures/candidate-review";

async function waitingReview(bind = true) {
  const f = await candidateReviewFixture();
  try {
    const accepted = await createReviewAdmission(f.database)(f.changeID, f.reviewID, f.userID);
    const turn = await f.turns.claimPending(accepted.turn.id);
    if (!turn?.ownerToken) throw new Error("Missing owned pending review");
    await f.writers.prepareAgent(f.changeID, turn.id);
    const [intent] = await f.database.client<{ sessionID: string }[]>`
      SELECT session_id AS "sessionID" FROM factory.change_agent_turn_intent WHERE turn_id=${turn.id}`;
    if (!intent) throw new Error("Missing review intent");
    await f.database.client.begin(async (sql) => {
      if (bind)
        await sql`UPDATE factory.change_agent_turn_intent SET runtime_attempt_id=${f.attemptID}
          WHERE turn_id=${turn.id}`;
      await sql`UPDATE factory.change_agent_session SET active_turn_id=${turn.id},
        opencode_session_id=${intent.sessionID},native_session_confirmed_at=NULL,state='starting'
        WHERE change_id=${f.changeID}`;
      await sql`UPDATE factory.runtime_attempt SET state='failed' WHERE id=${f.attemptID}`;
    });
    f.hub.connected = () => false;
    const stop = createChangeAgentStop(f.database, f.hub);
    await stop.persist(f.changeID);
    const session = async () => {
      const [row] = await f.database.client<
        {
          pending: boolean;
          id: string;
          turnID: string;
          sessionID: string;
          implementationSessionID: string;
          implementationConfirmed: boolean;
        }[]
      >`SELECT stop_pending AS pending,stop_id AS id,stop_turn_id AS "turnID",
        opencode_session_id AS "sessionID",implementation_session_id AS "implementationSessionID",
        implementation_session_confirmed_at IS NOT NULL AS "implementationConfirmed"
        FROM factory.change_agent_session WHERE change_id=${f.changeID}`;
      if (!row) throw new Error("Missing stopped review Session");
      return row;
    };
    return { ...f, stop, session, reviewTurnID: turn.id, ownerToken: turn.ownerToken };
  } catch (cause) {
    await f.dispose();
    throw cause;
  }
}

test("Stop confirms a distinct review that never crossed native Session confirmation", async () => {
  const f = await waitingReview();
  try {
    const before = await f.session();
    expect(before).toMatchObject({ pending: true, implementationConfirmed: true });
    expect(before.sessionID).not.toBe(before.implementationSessionID);
    expect(await f.stop.confirm(f.changeID, before.id, "observe")).toBe(true);
    expect(await f.session()).toEqual({ ...before, pending: false });
    expect((await f.review())?.state).toBe("pending");
    const [verification] = await f.database.client`SELECT state,commit_sha FROM factory.verification
      WHERE id=${f.verificationID}`;
    expect(verification).toEqual({ state: "succeeded", commit_sha: f.commit });
    expect(f.requests()).toBe(0);
    expect(f.interrupts()).toBe(0);
    expect(f.commitCalls).toEqual([]);
  } finally {
    await f.dispose();
  }
});

test("maintenance uses that same no-input proof without discarding the explicit Stop or history", async () => {
  const f = await waitingReview();
  try {
    const before = await f.session();
    await beginInstallationMaintenance(f.database);
    expect(await installationInMaintenance(f.database)).toBe(true);
    expect(await f.session()).toEqual({ ...before, pending: false });
    expect(f.requests()).toBe(0);
    expect(f.interrupts()).toBe(0);
  } finally {
    await finishInstallationMaintenance(f.database);
    await f.dispose();
  }
});

for (const unsafe of ["confirmed", "reused", "different-intent", "metadata-worker"] as const) {
  test(`review Stop and maintenance retain the barrier for ${unsafe}`, async () => {
    const f = await waitingReview(unsafe !== "different-intent");
    const workerID = crypto.randomUUID();
    try {
      if (unsafe === "confirmed")
        await f.database
          .client`UPDATE factory.change_agent_session SET native_session_confirmed_at=now()
          WHERE change_id=${f.changeID}`;
      if (unsafe === "reused")
        await f.database
          .client`UPDATE factory.change_agent_session SET implementation_session_id=opencode_session_id
          WHERE change_id=${f.changeID}`;
      if (unsafe === "metadata-worker")
        await f.database.client.begin(async (sql) => {
          // Deliberately seed an unmatched historical worker in this owned
          // controller database. A filtered current-owner lookup would omit
          // it; the raw outstanding record must still prevent the shortcut.
          await sql`SET LOCAL session_replication_role=replica`;
          await sql`INSERT INTO factory.substrate_input_stop(
            stop_id,runtime_attempt_id,workspace_id,change_id,actor_uid,assignment,checkpoint)
            VALUES(${workerID},${f.attemptID},${f.workspaceID},${f.changeID},${crypto.randomUUID()},
              '{"mode":"interrupt"}'::jsonb,'{}'::jsonb)`;
        });
      const before = await f.session();
      expect(await f.stop.confirm(f.changeID, before.id, "observe")).toBe(false);
      await expect(beginInstallationMaintenance(f.database)).rejects.toThrow(
        "Finish or explicitly stop",
      );
      expect(await installationInMaintenance(f.database)).toBe(false);
      expect((await f.session()).pending).toBe(true);
      expect(f.requests()).toBe(0);
      expect(f.interrupts()).toBe(0);
    } finally {
      if (unsafe === "metadata-worker")
        await f.database.client.begin(async (sql) => {
          await sql`SET LOCAL session_replication_role=replica`;
          await sql`DELETE FROM factory.substrate_input_stop WHERE stop_id=${workerID}`;
        });
      await f.dispose();
    }
  });
}

test("failed maintenance rolls its no-input proof publication back with unrelated active work", async () => {
  const f = await waitingReview();
  try {
    await f.database
      .client`INSERT INTO factory.knowledge_generation(id,project_id,source_commit_sha,created_by)
      VALUES(${crypto.randomUUID()},${f.projectID},${f.commit},${f.userID})`;
    const before = await f.session();
    await expect(beginInstallationMaintenance(f.database)).rejects.toThrow(
      "Finish or explicitly stop",
    );
    expect(await installationInMaintenance(f.database)).toBe(false);
    expect(await f.session()).toEqual(before);
  } finally {
    await f.database
      .client`DELETE FROM factory.knowledge_generation WHERE project_id=${f.projectID}`;
    await f.dispose();
  }
});

test("native admission already holding the Workspace lock prevents the pure Stop proof", async () => {
  const f = await waitingReview();
  const native = f.connect(1);
  try {
    await native.client`SELECT pg_advisory_lock(hashtext(${`runtime:${f.workspaceID}`}))`;
    const before = await f.session();
    expect(await f.stop.confirm(f.changeID, before.id, "observe")).toBe(false);
    await expect(beginInstallationMaintenance(f.database)).rejects.toThrow(
      "Finish or explicitly stop",
    );
    expect(await f.session()).toEqual(before);
    await native.client`SELECT pg_advisory_unlock(hashtext(${`runtime:${f.workspaceID}`}))`;
    expect(await f.stop.confirm(f.changeID, before.id, "observe")).toBe(true);
    expect((await f.session()).pending).toBe(false);
    expect(f.requests()).toBe(0);
    expect(f.interrupts()).toBe(0);
  } finally {
    await native.client`SELECT pg_advisory_unlock_all()`;
    await native.client.end();
    await f.dispose();
  }
});

test("clearing this no-input barrier never forwards a buffered late review prompt", async () => {
  const f = await waitingReview();
  const body = Promise.withResolvers<void>();
  const frames: { type: string }[] = [];
  const hub = new RuntimeHub(async () => {});
  const child = {
    data: { kind: "connector", role: "child", attemptID: f.attemptID, generation: 1 },
    close() {},
    send(raw: string) {
      frames.push(JSON.parse(raw));
      return 1;
    },
  } as unknown as ServerWebSocket<RuntimeSocketData>;
  hub.open(child);
  const transport = createChangeAgentTransport(
    f.database,
    hub,
    f.attemptID,
    f.reviewTurnID,
    f.ownerToken,
  );
  const result = transport(
    new Request(`http://opencode.runtime/api/session/${(await f.session()).sessionID}/prompt`, {
      method: "POST",
      body: new ReadableStream({
        async start(controller) {
          await body.promise;
          controller.enqueue(new TextEncoder().encode("{}"));
          controller.close();
        },
      }),
    }),
    `/api/session/${(await f.session()).sessionID}/prompt`,
  ).then(
    () => "sent",
    () => "rejected",
  );
  try {
    // Runtime readiness is not the reason forwarding must be denied.
    await f.database
      .client`UPDATE factory.runtime_attempt SET state='ready' WHERE id=${f.attemptID}`;
    expect(await f.stop.confirm(f.changeID, (await f.session()).id, "observe")).toBe(true);
    expect((await f.session()).pending).toBe(false);
    body.resolve();
    expect(await result).toBe("rejected");
    expect(frames.some((frame) => frame.type === "http-request")).toBe(false);
    expect(f.requests()).toBe(0);
    expect(f.interrupts()).toBe(0);
  } finally {
    body.resolve();
    await result;
    hub.revoke(f.attemptID);
    await f.dispose();
  }
});
