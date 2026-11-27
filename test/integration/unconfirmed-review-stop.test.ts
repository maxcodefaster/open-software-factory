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
import { observe } from "../fixtures/pinned-opencode";

async function waitingReview(bind = true, failedReview?: "pending" | "incomplete") {
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
    if (failedReview) {
      expect(
        await f.turns.failPending(turn.id, turn.ownerToken, "Review runtime startup failed"),
      ).toBe(true);
      if (failedReview === "incomplete")
        await f.database
          .client`UPDATE factory.candidate_review SET state='incomplete',completed_at=now()
          WHERE id=${f.reviewID}`;
    }
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

test("review startup failure before OpenCode readiness settles the review and ordinary Stop without rewriting the failed Turn", async () => {
  const f = await candidateReviewFixture();
  let starts = 0;
  const controller = f.controller(async () => {
    starts++;
    await f.database
      .client`UPDATE factory.runtime_attempt SET state='failed' WHERE id=${f.attemptID}`;
    return null;
  });
  try {
    await f.database
      .client`UPDATE factory.runtime_attempt SET state='starting' WHERE id=${f.attemptID}`;
    await controller.review(f.changeID, f.reviewID, f.userID);
    const turn = await observe(
      () => f.turn(f.reviewID),
      (turn) => turn?.state === "failed",
      "Review startup did not fail before native dispatch",
    );
    if (!turn) throw new Error("Missing failed review Turn");
    await observe(
      () =>
        f.database
          .client`SELECT state FROM factory.change_agent_session WHERE change_id=${f.changeID}`,
      (rows) => rows[0]?.["state"] === "failed",
    );
    expect(await f.review()).toMatchObject({ state: "incomplete", result: null, turnID: turn.id });
    const stop = createChangeAgentStop(f.database, f.hub);
    await stop.persist(f.changeID);
    const [session] = await f.database.client<
      { id: string; confirmed: boolean; implementation: boolean }[]
    >`
      SELECT stop_id AS id,native_session_confirmed_at IS NOT NULL AS confirmed,
        implementation_session_confirmed_at IS NOT NULL AS implementation
      FROM factory.change_agent_session WHERE change_id=${f.changeID}`;
    if (!session) throw new Error("Missing captured review Stop");
    expect(session).toMatchObject({ confirmed: false, implementation: true });
    expect(await stop.confirm(f.changeID, session.id, "observe")).toBe(true);
    expect(await f.turn(f.reviewID)).toEqual(turn);
    expect(await f.review()).toMatchObject({ state: "incomplete", result: null });
    const [stopped] = await f.database.client`SELECT state,stop_pending,stop_dispatched
      FROM factory.change_agent_session WHERE change_id=${f.changeID}`;
    expect(stopped).toEqual({ state: "stopped", stop_pending: false, stop_dispatched: false });
    expect(starts).toBe(1);
    expect(f.requests()).toBe(0);
    expect(f.interrupts()).toBe(0);
    expect(f.commitCalls).toEqual([]);
  } finally {
    await f.dispose();
  }
}, 30_000);

test.each(["pending", "incomplete"] as const)(
  "Stop confirms an undispatched failed review with %s projection without replacing its outcome",
  async (state) => {
    const f = await waitingReview(true, state);
    try {
      const before = await f.session();
      const turn = await f.turn(f.reviewID);
      expect(turn?.state).toBe("failed");
      expect(await f.stop.confirm(f.changeID, before.id, "observe")).toBe(true);
      expect(await f.session()).toEqual({ ...before, pending: false });
      expect(await f.turn(f.reviewID)).toEqual(turn);
      expect((await f.review())?.state).toBe(state);
      expect(f.requests()).toBe(0);
      expect(f.interrupts()).toBe(0);
    } finally {
      await f.dispose();
    }
  },
);

test.each(["completed", "superseded", "cancelled"] as const)(
  "late review startup failure preserves a %s review",
  async (boundary) => {
    const f = await candidateReviewFixture();
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const controller = f.controller(async () => {
      entered.resolve();
      await release.promise;
      await f.database
        .client`UPDATE factory.runtime_attempt SET state='failed' WHERE id=${f.attemptID}`;
      return null;
    });
    try {
      await f.database
        .client`UPDATE factory.runtime_attempt SET state='starting' WHERE id=${f.attemptID}`;
      await controller.review(f.changeID, f.reviewID, f.userID);
      await entered.promise;
      if (boundary === "completed")
        await f.database.client`UPDATE factory.candidate_review
          SET state='passed',result='{"verdict":"passed","summary":"Retained accepted report"}'::jsonb,
            completed_at=now() WHERE id=${f.reviewID}`;
      if (boundary === "superseded")
        await f.database.client`INSERT INTO factory.candidate_review(
          id,verification_id,ordinal,supersedes_id,change_id,commit_sha,base_sha,created_by)
          SELECT ${crypto.randomUUID()},verification_id,ordinal+1,id,change_id,commit_sha,base_sha,created_by
          FROM factory.candidate_review WHERE id=${f.reviewID}`;
      if (boundary === "cancelled")
        await f.database
          .client`UPDATE factory.change SET cancel_requested_at=now() WHERE id=${f.changeID}`;
      const before = await f.review();
      release.resolve();
      await observe(
        () =>
          f.database
            .client`SELECT state FROM factory.change_agent_session WHERE change_id=${f.changeID}`,
        (rows) => rows[0]?.["state"] === "failed",
      );
      expect((await f.turn(f.reviewID))?.state).toBe("failed");
      expect(await f.review()).toEqual(before);
      expect(f.requests()).toBe(0);
      expect(f.interrupts()).toBe(0);
    } finally {
      release.resolve();
      await f.dispose();
    }
  },
);

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
  test.each([undefined, "pending", "incomplete"] as const)(
    `review Stop and maintenance retain the barrier for ${unsafe}, failed projection=%s`,
    async (failedReview) => {
      const f = await waitingReview(unsafe !== "different-intent", failedReview);
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
            await sql`INSERT INTO factory.operation(
              id,kind,scope_type,scope_id,idempotency_key,state,payload)
              VALUES(${workerID},'runtime.input_stop','runtime_attempt',${f.attemptID},
                ${`runtime.input_stop:${workerID}`},'intended',
                jsonb_build_object(
                  'stopId',${workerID}::text,'runtimeAttemptId',${f.attemptID}::text,
                  'workspaceId',${f.workspaceID}::text,'changeId',${f.changeID}::text,
                  'actorUid',${crypto.randomUUID()}::text,
                  'assignment','{"mode":"interrupt"}'::jsonb,'checkpoint','{}'::jsonb
                ))`;
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
            await sql`DELETE FROM factory.operation WHERE id=${workerID} AND kind='runtime.input_stop'`;
          });
        await f.dispose();
      }
    },
  );
}

test("failed review Stop retains its original requirement approval binding", async () => {
  const f = await waitingReview(true, "incomplete");
  try {
    const revisionID = crypto.randomUUID();
    await f.database.client.begin(async (sql) => {
      await sql`INSERT INTO factory.requirement_revision(
        id,ticket_id,ordinal,canonical_content,content_digest,created_by)
        SELECT ${revisionID},ticket_id,ordinal+1,canonical_content,content_digest,created_by
        FROM factory.requirement_revision WHERE id=${f.revisionID}`;
      // Controlled malformed retained authority only, not a new approval or a
      // product mutation. The pure proof must reject this different basis.
      await sql`SET LOCAL session_replication_role=replica`;
      await sql`UPDATE factory.agent_turn
        SET authority=jsonb_set(authority,'{requirementRevisionId}',to_jsonb(${revisionID}::text))
        WHERE id=${f.reviewTurnID}`;
    });
    const before = await f.session();
    expect(await f.stop.confirm(f.changeID, before.id, "observe")).toBe(false);
    expect(await f.session()).toEqual(before);
    expect((await f.turn(f.reviewID))?.state).toBe("failed");
    expect(f.requests()).toBe(0);
    expect(f.interrupts()).toBe(0);
  } finally {
    await f.dispose();
  }
});

test("failed maintenance rolls its no-input proof publication back with unrelated active work", async () => {
  const f = await waitingReview();
  try {
    const generationID = crypto.randomUUID();
    await f.database
      .client`INSERT INTO factory.operation(id,kind,scope_type,scope_id,idempotency_key,active_key,state,created_by,payload)
      VALUES(${generationID},'knowledge.generation','project',${f.projectID},${`knowledge.generation:${generationID}`},${`knowledge.generation:${f.projectID}`},'pending',${f.userID},
        ${JSON.stringify({ id: generationID, projectId: f.projectID, sourceCommitSha: f.commit, pageCount: null, conflictCount: null, failure: null, createdBy: f.userID, modelId: null, attemptId: null, modelConnectionId: null, modelConnectionVersion: null, progress: null })}::jsonb)`;
    const before = await f.session();
    await expect(beginInstallationMaintenance(f.database)).rejects.toThrow(
      "Finish or explicitly stop",
    );
    expect(await installationInMaintenance(f.database)).toBe(false);
    expect(await f.session()).toEqual(before);
  } finally {
    await f.database
      .client`DELETE FROM factory.operation WHERE kind='knowledge.generation' AND scope_type='project' AND scope_id=${f.projectID}`;
    await f.dispose();
  }
});

test.each([undefined, "incomplete"] as const)(
  "native admission already holding the Workspace lock prevents the pure Stop proof, failed projection=%s",
  async (failedReview) => {
    const f = await waitingReview(true, failedReview);
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
  },
);

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
