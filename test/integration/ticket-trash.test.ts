import { expect, test } from "bun:test";
import { createChangeAdmission } from "../../apps/factory/src/agent/change-admission";
import { createChangeAgentStop } from "../../apps/factory/src/agent/stop";
import { createAgentTurnStore } from "../../apps/factory/src/agent/turn-store";
import { createTicketTrashController } from "../../apps/factory/src/change/trash";
import { buildModelID, fixture } from "../fixtures/change-agent-turns";
import { eventually, factoryProcess } from "../fixtures/factory-process";
import { nativeJobsFixture } from "../fixtures/native-jobs";

test("Trash fences admission before Stop, retains workspace and approval, and Restore dispatches nothing", async () => {
  const process = await factoryProcess();
  const db = process.connect();
  let controller: ReturnType<typeof createTicketTrashController> | undefined;
  let scope: Awaited<ReturnType<typeof fixture>> | undefined;
  let native: Awaited<ReturnType<typeof nativeJobsFixture>> | undefined;
  const release = Promise.withResolvers<void>();
  try {
    const owned = await fixture(undefined, undefined, db);
    scope = owned;
    async function readSource() {
      return (
        await db.client<
          Array<{
            id: string;
            branch: string;
            revision: string;
            atespace: string;
            actor: string;
            intent: unknown;
          }>
        >`SELECT workspace.id,workspace.source_branch AS branch,workspace.source_revision AS revision,
        binding.atespace,binding.actor_name AS actor,binding.intent
        FROM factory.development_workspace workspace
        JOIN factory.runtime_attempt attempt ON attempt.workspace_id=workspace.id AND attempt.id=${owned.attemptID}
        JOIN factory.substrate_binding binding ON binding.runtime_attempt_id=attempt.id
        WHERE workspace.id=${owned.workspaceID}`
      )[0];
    }
    const originalWorkspace = await readSource();
    if (!originalWorkspace) throw new Error("Owned Workspace is missing");
    const admission = createChangeAdmission(db, buildModelID);
    const admitted = await admission.admit(owned.changeID, owned.userID, {
      kind: "change-prompt",
      commandId: crypto.randomUUID(),
      text: "A bounded correction",
    });
    const verificationID = crypto.randomUUID();
    await db.client`INSERT INTO factory.verification(
      id,change_id,commit_sha,pull_request_number,runner_name,action_run_id,runner_uuid,
      runner_token,runner_job_handle,created_by)
      VALUES(${verificationID},${owned.changeID},${"d".repeat(40)},1,'owned-trash-verification',
        1,${crypto.randomUUID()},'owned-token','owned-trash-job',${owned.userID})`;
    native = await nativeJobsFixture(db, owned.projectID);
    const jobs = native;
    const verificationAttemptID = await jobs.startVerification(verificationID, owned.userID);
    const stop = createChangeAgentStop(db, owned.hub);
    const stopped: string[] = [];
    const reached = Promise.withResolvers<void>();
    controller = createTicketTrashController(
      db,
      {
        async stop(id) {
          stopped.push(id);
          if (id === verificationAttemptID) await jobs.stop(id);
          else {
            expect(id).toBe(owned.attemptID);
            // This Development observation has no dispatched Create or Actor.
            await db.client`UPDATE factory.runtime_attempt SET state='stopped' WHERE id=${id}`;
          }
        },
      },
      {
        async stop(id) {
          const [ticket] = await db.client<
            Array<{ trashed: boolean }>
          >`SELECT trashed_at IS NOT NULL AS trashed FROM factory.ticket WHERE id = ${owned.ticketID}`;
          expect(ticket?.trashed).toBe(true);
          await stop.persist(id);
          reached.resolve();
          await release.promise;
        },
      },
      { async stopForTrash() {} },
    );
    await controller.trash(owned.ticketID, owned.userID);
    await reached.promise;
    await expect(controller.restore(owned.ticketID, owned.userID, 2)).rejects.toThrow(
      "stop confirmation",
    );
    await expect(
      admission.admit(owned.changeID, owned.userID, {
        kind: "change-prompt",
        commandId: crypto.randomUUID(),
        text: "Cannot run from Trash",
      }),
    ).rejects.toThrow("latest approved");
    const [turn] = await db.client<
      Array<{ state: string }>
    >`SELECT state FROM factory.agent_turn WHERE id = ${admitted.turn.id}`;
    expect(turn?.state).toBe("stopped");
    release.resolve();
    await eventually(
      async () =>
        (
          await db.client<
            Array<{ pending: boolean }>
          >`SELECT trash_stop_pending AS pending FROM factory.ticket WHERE id = ${owned.ticketID}`
        )[0],
      (ticket) => ticket?.["pending"] === false,
      "Trash stop did not finish",
    );
    expect(stopped.toSorted()).toEqual([owned.attemptID, verificationAttemptID].toSorted());
    const [deleted] = await db.client`SELECT deleted_at IS NOT NULL AS confirmed
      FROM factory.substrate_binding WHERE runtime_attempt_id=${verificationAttemptID}`;
    expect(deleted).toEqual({ confirmed: true });
    const afterStop = jobs.calls.length;
    await controller.restore(owned.ticketID, owned.userID, 2);
    await controller.trash(owned.ticketID, owned.userID);
    await expect(controller.restore(owned.ticketID, owned.userID, 2)).rejects.toThrow(
      "Refresh Trash",
    );
    await eventually(
      async () =>
        (
          await db.client`SELECT trash_stop_pending AS pending FROM factory.ticket WHERE id = ${owned.ticketID}`
        )[0],
      (ticket) => ticket?.["pending"] === false,
      "Repeated Trash stop did not finish",
    );
    await controller.restore(owned.ticketID, owned.userID, 4);
    const [retained] = await db.client<
      Array<{
        trashed: boolean;
        attemptState: string;
        workspaceID: string;
        revisionID: string;
        turnCount: number;
      }>
    >`
      SELECT ticket.trashed_at IS NOT NULL AS trashed, attempt.state AS "attemptState", workspace.id AS "workspaceID",
        approval.requirement_revision_id AS "revisionID", (SELECT count(*)::integer FROM factory.agent_turn WHERE change_id = ${owned.changeID}) AS "turnCount"
      FROM factory.ticket ticket JOIN factory.requirement_approval approval ON approval.ticket_id = ticket.id
      JOIN factory.development_workspace workspace ON workspace.ticket_id = ticket.id
      JOIN factory.runtime_attempt attempt ON attempt.workspace_id = workspace.id WHERE ticket.id = ${owned.ticketID}`;
    expect(retained).toEqual({
      trashed: false,
      attemptState: "stopped",
      workspaceID: originalWorkspace.id,
      revisionID: owned.revisionID,
      turnCount: 1,
    });
    expect(await readSource()).toEqual(originalWorkspace);
    expect(originalWorkspace.atespace).toBe(`fa-${owned.attemptID.replaceAll("-", "")}`);
    expect(originalWorkspace.actor).toBe(`runtime-${owned.attemptID.replaceAll("-", "")}`);
    expect(jobs.calls).toHaveLength(afterStop);
    expect(jobs.calls.filter((call) => call.method === "CreateActor")).toHaveLength(1);
    expect(jobs.calls.filter((call) => call.method === "DeleteActor")).toHaveLength(1);
    expect(owned.requests()).toBe(0);
    // Pending OpenCode input remains an explicit Stop-recovery barrier after Restore.
    await expect(
      admission.admit(owned.changeID, owned.userID, {
        kind: "change-prompt",
        commandId: crypto.randomUUID(),
        text: "No implicit resume",
      }),
    ).rejects.toThrow("Stop");
    await db.client`UPDATE factory.change SET state = 'delivering' WHERE id = ${owned.changeID}`;
    await expect(controller.trash(owned.ticketID, owned.userID)).rejects.toThrow("Delivery");
  } finally {
    release.resolve();
    controller?.close();
    try {
      await native?.close();
      await db.client.end();
      await process.dispose();
    } finally {
      scope?.restoreEnvironment();
    }
  }
}, 60_000);

test("Trash prevents an already dispatched Interview from publishing or retaining execution authority", async () => {
  const process = await factoryProcess();
  const db = process.connect();
  let controller: ReturnType<typeof createTicketTrashController> | undefined;
  let scope: Awaited<ReturnType<typeof fixture>> | undefined;
  try {
    const owned = await fixture(undefined, undefined, db);
    scope = owned;
    const ticketID = crypto.randomUUID();
    const conversationID = crypto.randomUUID();
    await db.client`INSERT INTO factory.ticket(id, project_id, title, created_by)
      VALUES (${ticketID}, ${owned.projectID}, 'Owned Interview', ${owned.userID})`;
    await db.client`INSERT INTO factory.ticket_conversation(id, project_id, ticket_id, created_by)
      VALUES (${conversationID}, ${owned.projectID}, ${ticketID}, ${owned.userID})`;
    const turns = createAgentTurnStore(db);
    const project = await turns.admit(
      {
        kind: "project-message",
        commandId: crypto.randomUUID(),
        projectId: owned.projectID,
        ticketId: ticketID,
        conversationId: conversationID,
        createdBy: owned.userID,
        text: "Investigate",
      },
      { mode: "investigate", conversationVersion: 1, modelId: buildModelID, skillRevisionIds: [] },
    );
    const owner = await turns.claimPending(project.turn.id);
    if (!owner?.ownerToken) throw new Error("Project owner required");
    expect(await turns.beginDispatch(project.turn.id, owner.ownerToken)).toBeTruthy();
    controller = createTicketTrashController(
      db,
      { async stop() {} },
      { async stop() {} },
      { async stopForTrash() {} },
    );
    await controller.trash(ticketID, owned.userID);
    expect(await turns.validateExecution(project.turn.id, owner.ownerToken)).toBe(false);
    await eventually(
      () => turns.get(project.turn.id),
      (turn) => turn?.state === "stopped",
      "Interview did not stop",
    );
    expect(await turns.renew(project.turn.id, owner.ownerToken)).toBe(false);
    let published = false;
    expect(
      await turns.settle(
        project.turn.id,
        owner.ownerToken,
        "completed",
        "Late proposal",
        async () => {
          published = true;
        },
      ),
    ).toBe(false);
    expect(published).toBe(false);
  } finally {
    controller?.close();
    try {
      await db.client.end();
      await process.dispose();
    } finally {
      scope?.restoreEnvironment();
    }
  }
}, 60_000);

test("Trash retains unknown Stop outcomes, rechecks access and recovers only its persisted attempts", async () => {
  const process = await factoryProcess();
  const db = process.connect();
  let controller: ReturnType<typeof createTicketTrashController> | undefined;
  let scope: Awaited<ReturnType<typeof fixture>> | undefined;
  let confirm = false;
  const stopped: string[] = [];
  try {
    const owned = await fixture(undefined, undefined, db);
    scope = owned;
    const otherID = crypto.randomUUID();
    await db.client`INSERT INTO auth."user"(id,name,email) VALUES(${otherID},'Unrelated author',${`${otherID}@trash.test`})`;
    // Failed attempts also require exact Stop confirmation before Restore.
    await db.client`UPDATE factory.runtime_attempt SET state='failed' WHERE id=${owned.attemptID}`;
    controller = createTicketTrashController(
      db,
      {
        async stop(id) {
          stopped.push(id);
          expect(id).toBe(owned.attemptID);
          if (!confirm) throw new Error("Owned Stop acknowledgement unavailable");
          await db.client`UPDATE factory.runtime_attempt SET state='stopped' WHERE id=${id}`;
        },
      },
      { async stop() {} },
      { async stopForTrash() {} },
    );
    await expect(controller.trash(owned.ticketID, otherID)).rejects.toMatchObject({
      code: "not-found",
    });
    expect(stopped).toHaveLength(0);
    await controller.trash(owned.ticketID, owned.userID);
    const read = async () =>
      (
        await db.client`
      SELECT version::integer AS version,trashed_at AS at,trashed_by AS author,
        trash_stop_pending AS pending,trash_error AS error FROM factory.ticket WHERE id=${owned.ticketID}`
      )[0];
    const first = await eventually(
      read,
      (row) => typeof row?.["error"] === "string",
      "Unknown Stop was not retained",
    );
    expect(first).toMatchObject({ version: 2, author: owned.userID, pending: true });
    await expect(controller.restore(owned.ticketID, owned.userID, 2)).rejects.toThrow(
      "stop confirmation",
    );
    await controller.trash(owned.ticketID, owned.userID);
    const repeated = await eventually(
      read,
      (row) => typeof row?.["error"] === "string",
      "Repeated Stop was not observed",
    );
    expect(repeated).toEqual(first);
    await db.client`DELETE FROM factory.project_membership WHERE project_id=${owned.projectID} AND user_id=${owned.userID}`;
    await expect(controller.restore(owned.ticketID, owned.userID, 2)).rejects.toMatchObject({
      code: "not-found",
    });
    await expect(controller.trash(owned.ticketID, owned.userID)).rejects.toMatchObject({
      code: "not-found",
    });
    await db.client`INSERT INTO factory.project_membership(project_id,user_id,role,updated_by)
      VALUES(${owned.projectID},${owned.userID},'product-contributor',${owned.userID})`;
    confirm = true;
    await controller.recover();
    await eventually(
      read,
      (row) => row?.["pending"] === false,
      "Persisted Stop recovery did not finish",
    );
    const stopCount = stopped.length;
    await controller.restore(owned.ticketID, owned.userID, 2);
    expect(await read()).toMatchObject({
      version: 3,
      at: null,
      author: null,
      pending: false,
      error: null,
    });
    controller.close();
    await controller.recover();
    expect(stopped).toHaveLength(stopCount);
    expect(stopped.every((id) => id === owned.attemptID)).toBe(true);
    expect(owned.requests()).toBe(0);
    expect(
      await db.client`SELECT id FROM factory.requirement_approval WHERE ticket_id=${owned.ticketID} AND requirement_revision_id=${owned.revisionID}`,
    ).toHaveLength(1);
    expect(
      await db.client`SELECT id FROM factory.agent_turn WHERE ticket_id=${owned.ticketID}`,
    ).toHaveLength(0);
  } finally {
    controller?.close();
    try {
      await db.client.end();
      await process.dispose();
    } finally {
      scope?.restoreEnvironment();
    }
  }
}, 60_000);
