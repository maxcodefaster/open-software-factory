import { afterAll, beforeAll, expect, test } from "bun:test";
import { SubstrateRPCError } from "#runtime-kubernetes/substrate-control";
import { createWorkspaceCollaboration } from "../../apps/factory/src/workspace/collaboration";
import { createWorkspaceCommands } from "../../apps/factory/src/workspace/commands";
import { createWorkspaceComputeAccess } from "../../apps/factory/src/workspace/compute-access";
import { createWorkspaceSourceController } from "../../apps/factory/src/workspace/source-controller";
import { createSubstrateSources } from "../../apps/factory/src/workspace/substrate-source";
import { ownedPostgresServer } from "../fixtures/postgres-server";
import { startSubstrateFixtureWorkspace, substrateFixture } from "../fixtures/substrate";

const inheritedPostgres = process.env["FACTORY_TEST_POSTGRES"];
let postgres: Awaited<ReturnType<typeof ownedPostgresServer>> | undefined;
beforeAll(async () => {
  if (!inheritedPostgres) {
    postgres = await ownedPostgresServer();
    process.env["FACTORY_TEST_POSTGRES"] = JSON.stringify(postgres.identity);
  }
}, 60_000);
afterAll(async () => {
  if (inheritedPostgres === undefined) delete process.env["FACTORY_TEST_POSTGRES"];
  else process.env["FACTORY_TEST_POSTGRES"] = inheritedPostgres;
  await postgres?.dispose();
});

async function retainedReadFixture(kind: "personal" | "ticket" = "ticket") {
  const f = await substrateFixture("a".repeat(40), kind);
  const source = createSubstrateSources(f.database, f.hub);
  let actor: ReturnType<typeof f.actor> | undefined;
  let creates = 0;
  let resumes = 0;
  let suspendGeneration = 0;
  let resumeProbe: (() => Promise<void>) | undefined;
  const requests: string[] = [];
  const attach = source.attach;
  source.attach = async (workspaceID, actorUID, sql) => {
    // Controlled already-imported tree after the real adapter persists its binding.
    if (!(await source.lease(workspaceID, sql))) await f.admitActorSource(actorUID, sql);
    await attach(workspaceID, actorUID, sql);
  };
  try {
    if (kind === "ticket")
      await f.database.client`UPDATE factory.change_writer SET state='human',user_id=${f.userID}
        WHERE change_id=${f.changeID}`;
    const runtime = await f.controller(async (method) => {
      if (method === "GetAtespace") return f.space;
      if (method === "GetActorTemplate") return f.template;
      if (method === "GetActor") {
        if (!actor) throw new SubstrateRPCError("NotFound", "absent");
        return structuredClone(actor);
      }
      if (method === "CreateActor") {
        creates++;
        actor = await f.createdActor();
        return structuredClone(actor);
      }
      if (method === "ResumeActor" && actor) {
        resumes++;
        actor.metadata.version = String(Number(actor.metadata.version) + 1);
        actor.status = {
          ...actor.status,
          state: resumeProbe ? "ACTOR_STATE_RESUMING" : "ACTOR_STATE_RUNNING",
          workerAssignment: { sandboxRuntime: f.config.runtime },
        };
        await resumeProbe?.();
        actor.status.state = "ACTOR_STATE_RUNNING";
        return { actor: structuredClone(actor) };
      }
      if (method === "SuspendActor" && actor) {
        const uuid = crypto.randomUUID();
        const generation = ++suspendGeneration;
        actor.metadata.version = String(Number(actor.metadata.version) + 1);
        actor.status = {
          state: "ACTOR_STATE_SUSPENDED",
          lastAssignedGeneration: generation,
          snapshots: [
            {
              uuid,
              generation,
              owner: "SNAPSHOT_OWNER_ACTOR",
              fidelity: "SNAPSHOT_FIDELITY_ROOTFS",
              actorTemplateUid: f.config.templateUID,
              sandboxRuntime: f.config.runtime,
              durableSnapshot: {
                state: "SNAPSHOT_STORAGE_STATE_COMPLETED",
                object: {
                  snapshotUri: `s3://owned/atespaces/${f.atespace}/actors/${actor.metadata.uid}/snapshots/${uuid}`,
                },
              },
            },
          ],
        };
        return { actor: structuredClone(actor) };
      }
      throw new Error(`Unexpected controlled native operation ${method}`);
    }, source);
    if (kind === "ticket") await runtime.startPersisted(f.changeID, f.userID);
    else await runtime.start(f.projectID, f.userID);
    await f.database.client`UPDATE factory.runtime_attempt SET state='ready',ready_at=now()
      WHERE id=${f.attemptID}`;
    await runtime.pause(f.attemptID);
    f.hub.sourceConnected = () => actor?.status.state === "ACTOR_STATE_RUNNING";
    f.hub.ready = () => false;
    f.hub.request = async (attemptID, channel, _request, path) => {
      expect([attemptID, channel]).toEqual([f.attemptID, "source"]);
      requests.push(path);
      return Response.json({ content: "cmV0YWluZWQ=", version: "retained-version" });
    };
    const controller = createWorkspaceSourceController(f.database, f.hub, source, {
      // Match the application's composed wake seam, including sourceOnly.
      async wakeForAccess(workspaceID, userID, signal, write = true) {
        await createWorkspaceComputeAccess(f.database, f.hub, runtime, () => false)(
          workspaceID,
          userID,
          write,
          undefined,
          signal,
          true,
        );
      },
    });
    return {
      ...f,
      runtime,
      controller,
      source,
      requests,
      creates: () => creates,
      resumes: () => resumes,
      actor: () => actor,
      onResume(probe: () => Promise<void>) {
        resumeProbe = probe;
      },
      async dispose() {
        await controller.close();
        await source.close();
        await f.dispose();
      },
    };
  } catch (cause) {
    await source.close();
    await f.dispose();
    throw cause;
  }
}

test.each(["active", "delivered"] as const)(
  "composed current-file read wakes the retained %s Ticket Actor without acquiring editing",
  async (state) => {
    const f = await retainedReadFixture();
    const commands = createWorkspaceCommands(f.database, f.hub, f.runtime, "owned-command-key");
    try {
      if (state === "delivered") {
        const turnID = crypto.randomUUID();
        // Completed commissioned work is retained; this never dispatches inference.
        await f.database.client`INSERT INTO factory.agent_turn
          (id,command_id,project_id,ticket_id,change_id,created_by,input,input_digest,authority,state)
          VALUES(${turnID},${turnID},${f.projectID},${f.ticketID},${f.changeID},${f.userID},
            '{"kind":"change-start"}',${"a".repeat(64)},
            jsonb_build_object('mode','build','requirementRevisionId',
              (SELECT approval.requirement_revision_id FROM factory.change c
                JOIN factory.requirement_approval approval ON approval.id=c.requirement_approval_id
                WHERE c.id=${f.changeID})),'completed')`;
        await f.database
          .client`UPDATE factory.change_writer SET state='agent',turn_id=${turnID},user_id=NULL
          WHERE change_id=${f.changeID}`;
      } else
        await f.database.client`UPDATE factory.change_writer SET state='unassigned',user_id=NULL
          WHERE change_id=${f.changeID}`;
      // Successful Delivery also records this final inference-stop marker.
      // It is not destructive Workspace Stop or a ban on current-file reads.
      await f.database.client`UPDATE factory.change SET state=${state},
        cancel_requested_at=CASE WHEN ${state}='delivered' THEN now() ELSE NULL END
        WHERE id=${f.changeID}`;
      const before = await f.database.client`SELECT * FROM factory.change_writer`;
      const lease = await f.database.client`SELECT * FROM factory.substrate_source`;
      const actorUID = f.actor()?.metadata.uid;
      await expect(f.runtime.startPersisted(f.changeID, f.userID)).rejects.toThrow(
        /Ticket execution|commissioned Ticket writer/,
      );
      for (const operation of ["list", "read"]) {
        const response = await f.controller.forward(
          f.workspaceID,
          f.userID,
          operation,
          new Request(`https://factory.test/${operation}`, {
            method: "POST",
            body: '{"path":"README.md"}',
          }),
        );
        expect(response.status).toBe(200);
        expect(await response.json()).toMatchObject({ version: "retained-version" });
      }
      expect(f.resumes()).toBe(2); // Initial Start plus one same-Actor read wake.
      expect(f.creates()).toBe(1);
      expect(f.requests).toHaveLength(2);
      expect(f.actor()?.metadata.uid).toBe(actorUID);
      expect(await f.database.client`SELECT * FROM factory.change_writer`).toEqual(before);
      expect(await f.database.client`SELECT * FROM factory.substrate_source`).toEqual(lease);
      expect(await f.database.client`SELECT id FROM factory.agent_turn`).toHaveLength(
        state === "delivered" ? 1 : 0,
      );
      expect(
        await f.database.client`SELECT id FROM factory.agent_turn WHERE state<>'completed'`,
      ).toHaveLength(0);
      expect(await f.database.client`SELECT id FROM factory.runtime_attempt`).toHaveLength(1);
      expect((await f.runtime.get(f.attemptID))?.state).toBe("starting");
      await expect(
        f.controller.forward(
          f.workspaceID,
          f.userID,
          "write",
          new Request("https://factory.test/write", {
            method: "POST",
            body: '{"path":"README.md"}',
          }),
        ),
      ).rejects.toThrow("observation-only");
      for (const kind of ["shell", "terminal"] as const)
        await expect(
          commands.start(
            f.userID,
            {
              workspaceID: f.workspaceID,
              requestID: crypto.randomUUID(),
              command: "must not execute",
              env: {},
            },
            kind,
          ),
        ).rejects.toThrow("observation-only");
      expect(
        await f.database.client`SELECT id FROM factory.operation WHERE kind='workspace.command'`,
      ).toHaveLength(0);
    } finally {
      await commands.close();
      await f.dispose();
    }
  },
  30_000,
);

test("delivered read wake admits only the retained Source Parent during native Resume", async () => {
  const f = await retainedReadFixture();
  try {
    await f.database.client`UPDATE factory.change SET state='delivered',cancel_requested_at=now()
      WHERE id=${f.changeID}`;
    const request = (role: "parent" | "child") =>
      new Request("https://factory.test/internal/runtime-connect", {
        headers: {
          "x-factory-runtime-attempt": f.attemptID,
          "x-factory-runtime-generation": "1",
          "x-factory-runtime-actor-uid": f.actor()?.metadata.uid ?? "",
          "x-factory-connector-role": role,
        },
      });
    f.onResume(async () => {
      expect(await f.runtime.authorizeConnector(request("parent"))).toBe(true);
      expect(await f.runtime.authorizeConnector(request("child"))).toBe(false);
    });
    expect(
      (
        await f.controller.forward(
          f.workspaceID,
          f.userID,
          "list",
          new Request("https://factory.test/list", { method: "POST", body: '{"path":""}' }),
        )
      ).status,
    ).toBe(200);
    expect(await f.runtime.authorizeConnector(request("parent"))).toBe(true);
    expect(await f.runtime.authorizeConnector(request("child"))).toBe(false);
    await f.runtime.status(f.attemptID, "source-ready");
    expect(f.resumes()).toBe(2);
    expect(f.creates()).toBe(1);
  } finally {
    await f.dispose();
  }
}, 30_000);

test.each([
  "pending-coding",
  "pending-stop",
  "source-frozen",
  "never-ready",
  "stop-intended",
  "cancelled-ticket",
  "failed",
  "foreign-actor",
  "stale-native-version",
] as const)(
  "retained current-file wake refuses %s without native dispatch or Source changes",
  async (scenario) => {
    const f = await retainedReadFixture();
    try {
      if (scenario === "pending-coding") {
        const turnID = crypto.randomUUID();
        await f.database.client`INSERT INTO factory.agent_turn
          (id,command_id,project_id,ticket_id,change_id,created_by,input,input_digest,authority)
          VALUES(${turnID},${turnID},${f.projectID},${f.ticketID},${f.changeID},${f.userID},
            '{"kind":"change-start"}',${"b".repeat(64)},
            jsonb_build_object('mode','build','requirementRevisionId',
              (SELECT approval.requirement_revision_id FROM factory.change c
                JOIN factory.requirement_approval approval ON approval.id=c.requirement_approval_id
                WHERE c.id=${f.changeID})))`;
      }
      if (scenario === "pending-stop")
        await f.database.client`INSERT INTO factory.change_agent_session
          (change_id,runtime_attempt_id,state,created_by,stop_pending)
          VALUES(${f.changeID},${f.attemptID},'stopped',${f.userID},true)`;
      if (scenario === "source-frozen")
        await f.database.client`UPDATE factory.substrate_source SET writable=false,
          writer_epoch=writer_epoch+1,checkpoint_id=${crypto.randomUUID()}
          WHERE workspace_id=${f.workspaceID}`;
      if (scenario === "never-ready")
        await f.database
          .client`UPDATE factory.runtime_attempt SET ready_at=NULL WHERE id=${f.attemptID}`;
      if (scenario === "stop-intended")
        await f.database
          .client`UPDATE factory.runtime_attempt SET state='stopping',stop_intended_at=now()
          WHERE id=${f.attemptID}`;
      if (scenario === "cancelled-ticket")
        await f.database.client`UPDATE factory.change SET cancel_requested_at=now()
          WHERE id=${f.changeID}`;
      if (scenario === "failed")
        await f.database
          .client`UPDATE factory.runtime_attempt SET state='failed' WHERE id=${f.attemptID}`;
      const actor = f.actor();
      if (!actor) throw Error("Retained fixture Actor is missing");
      if (scenario === "foreign-actor") actor.metadata.uid = crypto.randomUUID();
      if (scenario === "stale-native-version") actor.metadata.version = "1";
      const lease = await f.database.client`SELECT * FROM factory.substrate_source`;
      await expect(f.runtime.resumeForSource(f.attemptID, f.userID)).rejects.toThrow(
        scenario === "foreign-actor"
          ? "Native Actor differs from its immutable create binding"
          : scenario === "stale-native-version"
            ? "Stale native resource version"
            : "Current retained Actor Source grant required",
      );
      expect(f.resumes()).toBe(1);
      expect(f.creates()).toBe(1);
      expect(f.requests).toEqual([]);
      expect(await f.database.client`SELECT * FROM factory.substrate_source`).toEqual(lease);
    } finally {
      await f.dispose();
    }
  },
  30_000,
);

test("source-only owner read wakes personal compute, but revocation during wake prevents the read", async () => {
  const f = await retainedReadFixture("personal");
  try {
    f.onResume(async () => {
      await f.database.client`UPDATE factory.project_membership SET role='product-contributor'
        WHERE project_id=${f.projectID} AND user_id=${f.userID}`;
    });
    await expect(
      f.controller.forward(
        f.workspaceID,
        f.userID,
        "read",
        new Request("https://factory.test/read", { method: "POST", body: '{"path":"README.md"}' }),
      ),
    ).rejects.toThrow("Developer access required");
    expect(f.resumes()).toBe(2); // Already-dispatched native outcome remains observable.
    expect(f.creates()).toBe(1);
    expect(f.requests).toEqual([]);
    expect(await f.database.client`SELECT id FROM factory.agent_turn`).toHaveLength(0);
  } finally {
    await f.dispose();
  }
}, 30_000);

test("background shared-editor synchronization never resumes paused canonical Source", async () => {
  const f = await retainedReadFixture("personal");
  const collaboration = createWorkspaceCollaboration(f.database, f.controller);
  const actor = { userID: f.userID, sessionID: crypto.randomUUID(), kind: "person" as const };
  const input = {
    path: "README.md",
    participantID: crypto.randomUUID(),
    clientID: 1,
    vector: "",
  };
  f.hub.request = async (_attemptID, _channel, _request, path) => {
    f.requests.push(path);
    return Response.json({
      kind: "file",
      content: "cmV0YWluZWQ=",
      version: "retained-version",
      size: 8,
      mtime: 1,
      ctime: 1,
    });
  };
  try {
    await collaboration.enable(f.userID, f.workspaceID, crypto.randomUUID());
    const lease = await f.source.lease(f.workspaceID);
    await expect(collaboration.sync(actor, f.workspaceID, input)).rejects.toThrow("paused");
    expect(f.resumes()).toBe(1); // Initial Start only, never the passive poll.
    expect(f.actor()?.status.state).toBe("ACTOR_STATE_SUSPENDED");
    expect(f.requests).toEqual([]);
    expect(await f.source.lease(f.workspaceID)).toEqual(lease);
    // Deliberate current-file access still wakes the original Actor, not inference.
    expect(
      (
        await f.controller.forward(
          f.workspaceID,
          f.userID,
          "read",
          new Request("https://factory.test/read", {
            method: "POST",
            body: '{"path":"README.md"}',
          }),
        )
      ).status,
    ).toBe(200);
    const synchronized = await collaboration.sync(actor, f.workspaceID, input);
    expect(synchronized.canWrite).toBe(true);
    await collaboration.edit(actor, f.workspaceID, {
      path: input.path,
      revision: synchronized.revision,
      edits: [{ offset: 8, deleteCount: 0, text: " unsaved shared buffer" }],
    });
    const savedBuffer = await f.database
      .client`SELECT y_state,sync_state,disk_version FROM factory.workspace_shared_document
        WHERE workspace_id=${f.workspaceID} AND path=${input.path}`;
    await f.runtime.pause(f.attemptID);
    const reads = f.requests.length;
    for (let poll = 0; poll < 3; poll++)
      await expect(collaboration.sync(actor, f.workspaceID, input)).rejects.toThrow("paused");
    expect(f.requests).toHaveLength(reads);
    expect(await f.source.lease(f.workspaceID)).toEqual(lease);
    expect(
      await f.database
        .client`SELECT y_state,sync_state,disk_version FROM factory.workspace_shared_document
        WHERE workspace_id=${f.workspaceID} AND path=${input.path}`,
    ).toEqual(savedBuffer);
    expect(f.resumes()).toBe(2);
    expect(f.creates()).toBe(1);
    // Explicit current-file reads, unlike background synchronization, still wake.
    const retained = await collaboration.read(f.userID, f.workspaceID, input.path);
    expect(retained.content).toBe("retained unsaved shared buffer");
    expect(retained.dirty).toBe(true);
    expect(f.resumes()).toBe(3);
    expect(await f.database.client`SELECT id FROM factory.agent_turn`).toHaveLength(0);
  } finally {
    await collaboration.close();
    await f.dispose();
  }
}, 30_000);

test("a connected cold-start Source is readable before Work readiness, without admitting a new writer", async () => {
  const f = await substrateFixture("a".repeat(40), "ticket");
  const source = createSubstrateSources(f.database, f.hub);
  const controller = createWorkspaceSourceController(f.database, f.hub, source);
  let reads = 0;
  try {
    const uid = crypto.randomUUID();
    await f.database.client.begin(async (sql) => {
      await sql`INSERT INTO factory.substrate_provision(owner_id,kind,intent) VALUES(${f.workspaceID},'workspace','{}')`;
      await sql`INSERT INTO factory.runtime_attempt(id,project_id,workspace_id,change_id,generation,revision,state,parent_connector_token_hash,create_intended_at,created_by,atespace,actor_name,binding_intent,actor_uid,create_attempted_at)
        VALUES(${f.attemptID},${f.projectID},${f.workspaceID},${f.changeID},1,${"a".repeat(40)},'create-intended',${"b".repeat(64)},now(),${f.userID},${f.atespace},${`runtime-${f.attemptID.replaceAll("-", "")}`},'{}',${uid},now())`;
      await sql`UPDATE factory.runtime_attempt SET state='starting' WHERE id=${f.attemptID}`;
      await sql`UPDATE factory.change SET runtime_attempt_id=${f.attemptID} WHERE id=${f.changeID}`;
    });
    await f.admitActorSource(uid);
    f.hub.sourceConnected = () => false;
    expect(await controller.get(f.workspaceID, f.userID)).toMatchObject({
      state: "preparing",
      failure: null,
    });
    f.hub.sourceConnected = () => true;
    f.hub.request = async (_attempt, channel) => {
      expect(channel).toBe("source");
      reads++;
      return Response.json({ content: "Y29sZC1zdGFydA==" });
    };
    expect(await controller.get(f.workspaceID, f.userID)).toMatchObject({
      state: "ready",
      failure: null,
    });
    expect(
      (
        await controller.forward(
          f.workspaceID,
          f.userID,
          "read",
          new Request("https://factory.test/read", {
            method: "POST",
            body: '{"path":"README.md"}',
          }),
        )
      ).status,
    ).toBe(200);
    expect(reads).toBe(1);
    await expect(
      controller.forward(
        f.workspaceID,
        f.userID,
        "write",
        new Request("https://factory.test/write", { method: "POST", body: '{"path":"README.md"}' }),
      ),
    ).rejects.toThrow("observation-only");
    expect(reads).toBe(1);
    const [attempt] = await f.database
      .client`SELECT state FROM factory.runtime_attempt WHERE id=${f.attemptID}`;
    expect(attempt?.["state"]).toBe("starting");
  } finally {
    await controller.close();
    await f.dispose();
  }
}, 30_000);

test("native Source rechecks slow uploads, orders revocation after writes and closes retained watches", async () => {
  const f = await substrateFixture();
  const runtime = await startSubstrateFixtureWorkspace(f);
  const source = createSubstrateSources(f.database, f.hub);
  const controller = createWorkspaceSourceController(f.database, f.hub, source);
  const finishWrite = Promise.withResolvers<void>();
  const writeStarted = Promise.withResolvers<void>();
  let calls = 0;
  let watchClosed = false;
  let pending: Promise<unknown> | undefined;
  try {
    const uid = (await runtime.get(f.attemptID))?.native?.actorUID;
    if (!uid) throw new Error("Native Source Actor is missing");
    await f.admitActorSource(uid);
    await f.database.client`UPDATE factory.runtime_attempt SET state='ready',ready_at=now()
      WHERE id=${f.attemptID}`;
    f.hub.sourceConnected = () => true;
    f.hub.request = async (_attempt, _channel, request, path) => {
      calls++;
      if (path.endsWith("/fence")) return Response.json({ confirmed: true });
      if (path.endsWith("/write")) {
        writeStarted.resolve();
        await finishWrite.promise;
        return Response.json({ saved: true });
      }
      if (path.endsWith("/events"))
        return new Response(
          new ReadableStream<Uint8Array>({
            start(target) {
              target.enqueue(new TextEncoder().encode('data: {"kind":"resync","path":""}\n\n'));
              request.signal.addEventListener(
                "abort",
                () => {
                  watchClosed = true;
                  target.close();
                },
                { once: true },
              );
            },
          }),
        );
      return Response.json({ content: "aHVtYW4=" });
    };
    let upload: ReadableStreamDefaultController<Uint8Array> | undefined;
    const slowWrite = controller.forward(
      f.workspaceID,
      f.userID,
      "write",
      new Request("https://factory.test/write", {
        method: "POST",
        body: new ReadableStream<Uint8Array>({
          start(target) {
            upload = target;
          },
        }),
      }),
    );
    const refused = slowWrite.then(
      () => "unexpected admission",
      (error: Error) => error.message,
    );
    await f.database.client`UPDATE factory.project_membership SET role='product-contributor'
      WHERE project_id=${f.projectID} AND user_id=${f.userID}`;
    upload?.enqueue(new TextEncoder().encode('{"path":"app.ts"}'));
    upload?.close();
    expect(await refused).toContain("Developer access required");
    expect(calls).toBe(0);
    await f.database.client`UPDATE factory.project_membership SET role='developer'
      WHERE project_id=${f.projectID} AND user_id=${f.userID}`;
    const watch = await controller.forward(
      f.workspaceID,
      f.userID,
      "events",
      new Request("https://factory.test/events"),
    );
    const reader = watch.body?.getReader();
    if (!reader) throw new Error("Native Source watch is missing");
    expect((await reader.read()).done).toBe(false);
    await controller.reconcileUserAccess(f.userID);
    expect(watchClosed).toBe(false);
    const write = controller.forward(
      f.workspaceID,
      f.userID,
      "write",
      new Request("https://factory.test/write", {
        method: "POST",
        body: '{"path":"app.ts"}',
      }),
    );
    pending = write;
    await writeStarted.promise;
    let revoked = false;
    const revoke = (async () => {
      await f.database.client`UPDATE factory.project_membership SET role='product-contributor'
        WHERE project_id=${f.projectID} AND user_id=${f.userID}`;
      revoked = true;
      await controller.reconcileUserAccess(f.userID);
    })();
    await Bun.sleep(50);
    expect(revoked).toBe(false);
    finishWrite.resolve();
    expect((await write).status).toBe(200);
    await revoke;
    expect(watchClosed).toBe(true);
    expect((await reader.read()).done).toBe(true);
    const before = calls;
    await expect(
      controller.forward(
        f.workspaceID,
        f.userID,
        "read",
        new Request("https://factory.test/read", {
          method: "POST",
          body: '{"path":"app.ts"}',
        }),
      ),
    ).rejects.toThrow("Developer access required");
    expect(calls).toBe(before);
  } finally {
    finishWrite.resolve();
    await pending?.catch(() => {});
    await controller.close();
    await f.dispose();
  }
}, 30_000);

test.each(["personal", "ticket"] as const)(
  "%s metadata observes an initializing Source-only Workspace without native compute",
  async (kind) => {
    const f = await substrateFixture("a".repeat(40), kind);
    f.hub.request = async () => {
      throw new Error("An unstarted Source read must not dispatch a native request");
    };
    const source = createSubstrateSources(f.database, f.hub);
    // Controlled metadata observation while the pinned Source initializer is
    // unfinished; this lane does not substitute a host process for Linux Source.
    source.available = async () => false;
    const controller = createWorkspaceSourceController(f.database, f.hub, source);
    try {
      const view =
        kind === "personal"
          ? await controller.ensurePersonal(f.projectID, f.userID)
          : await controller.ensureChange(f.changeID, f.userID);
      expect(view).toMatchObject({
        workspaceID: f.workspaceID,
        state: "preparing",
        epoch: 1,
      });
      expect((await controller.get(f.workspaceID, f.userID)).serviceID).toBe(view.serviceID);
      await expect(controller.get(crypto.randomUUID(), f.userID)).rejects.toThrow(
        "Workspace not found",
      );
      expect(await source.lease(f.workspaceID)).toMatchObject({
        owner: "service",
        actorUID: null,
        generation: 0,
        seedConfirmedAt: null,
      });
      expect(await f.database.client`SELECT id FROM factory.runtime_attempt`).toHaveLength(0);
      expect(
        await f.database
          .client`SELECT owner_id FROM factory.substrate_provision WHERE kind='workspace'`,
      ).toHaveLength(0);
      expect(await f.database.client`SELECT id FROM factory.development_workspace`).toHaveLength(1);
    } finally {
      await controller.close();
      await f.dispose();
    }
  },
  30_000,
);

test("Source shared-edit conflicts match literal path boundaries and rename destinations", async () => {
  const f = await substrateFixture();
  const source = createSubstrateSources(f.database, f.hub);
  const controller = createWorkspaceSourceController(f.database, f.hub, source);
  try {
    await f.database.client`INSERT INTO factory.workspace_shared_document
      (workspace_id,path,y_state,disk_version,sync_state)
      VALUES(${f.workspaceID},'dir%/unsaved.ts',${Buffer.alloc(0)},'owned-version','conflict')`;
    const request = (path: string, destination?: string) =>
      new Request("https://factory.test/source", {
        method: "POST",
        body: JSON.stringify({ path, destination }),
      });
    await expect(
      controller.forward(f.workspaceID, f.userID, "delete", request("dir%")),
    ).rejects.toThrow("Shared unsaved edits");
    await expect(
      controller.forward(f.workspaceID, f.userID, "write", request("dir%/unsaved.ts")),
    ).rejects.toThrow("Shared unsaved edits");
    await expect(
      controller.forward(f.workspaceID, f.userID, "rename", request("clean", "dir%")),
    ).rejects.toThrow("Shared unsaved edits");
    // The literal prefix does not treat '%' as a wildcard or match 'dir' to 'dir%'.
    await expect(
      controller.forward(f.workspaceID, f.userID, "delete", request("dir")),
    ).rejects.toThrow("Source is not initialized");
  } finally {
    await controller.close();
    await f.dispose();
  }
}, 30_000);

async function mutationFixture(
  state: "paused" | "pausing" | "resuming" | "stopped" | "failed" | "new" = "paused",
) {
  const f = await substrateFixture();
  const source = createSubstrateSources(f.database, f.hub);
  const actorUID = crypto.randomUUID();
  const saved = { content: "saved bytes", version: "saved-v1" };
  const calls: {
    operation: string;
    owner: string;
    epoch: string | null;
    input: Record<string, unknown>;
  }[] = [];
  source.available = async () => true;
  source.forward = async (_workspace, _attempt, operation, request, sql) => {
    const [lease] = await sql<{ owner: string }[]>`SELECT owner FROM factory.substrate_source
      WHERE workspace_id=${f.workspaceID}`;
    if (!lease) throw new Error("Owned Source lease missing");
    const input = operation === "events" ? {} : ((await request.json()) as Record<string, unknown>);
    calls.push({
      operation,
      owner: lease.owner,
      epoch: request.headers.get("X-Factory-Writer-Epoch"),
      input,
    });
    if (operation === "write") {
      if (input["version"] !== saved.version) return new Response(null, { status: 409 });
      saved.content = Buffer.from(String(input["content"]), "base64").toString();
      saved.version = "saved-v2";
    }
    return Response.json({
      content: Buffer.from(saved.content).toString("base64"),
      version: saved.version,
    });
  };
  f.hub.sourceConnected = () => true;
  try {
    await f.database.client.begin(async (sql) => {
      if (state === "new") {
        const seed = {
          version: 1,
          id: crypto.randomUUID(),
          workspaceID: f.workspaceID,
          projectID: f.projectID,
          repositoryURL: "https://example.invalid/fixture.git",
          revision: "a".repeat(40),
          branch: f.branch,
        };
        await sql`INSERT INTO factory.substrate_source(workspace_id,owner,service_base,seed)
          VALUES(${f.workspaceID},'service',${seed.id},${JSON.stringify(seed)}::text::jsonb)`;
        return;
      }
      const snapshotID = crypto.randomUUID();
      const checkpoint = {
        actorUID,
        templateUID: f.config.templateUID,
        uuid: snapshotID,
        generation: 1,
        owner: "SNAPSHOT_OWNER_ACTOR",
        fidelity: "SNAPSHOT_FIDELITY_ROOTFS",
        actorTemplateUid: f.config.templateUID,
        sandboxRuntime: f.config.runtime,
        durableSnapshot: {
          state: "SNAPSHOT_STORAGE_STATE_COMPLETED",
          object: {
            snapshotUri: `s3://owned/atespaces/${f.atespace}/actors/${actorUID}/snapshots/${snapshotID}`,
          },
        },
      };
      await sql`INSERT INTO factory.runtime_attempt(id,project_id,workspace_id,generation,revision,state,
          parent_connector_token_hash,create_intended_at,created_by,
          atespace,actor_name,binding_intent,actor_uid,create_attempted_at,checkpoint,observation)
        VALUES(${f.attemptID},${f.projectID},${f.workspaceID},1,${"a".repeat(40)},'create-intended',
          ${"b".repeat(64)},now(),${f.userID},
          ${f.atespace},${`runtime-${f.attemptID.replaceAll("-", "")}`},'{}',${actorUID},now(),
          ${JSON.stringify(checkpoint)}::text::jsonb,
          ${JSON.stringify({ status: { state: "ACTOR_STATE_SUSPENDED", lastAssignedGeneration: 1 } })}::text::jsonb)`;
      await sql`UPDATE factory.runtime_attempt SET state='paused' WHERE id=${f.attemptID}`;
      await f.admitActorSource(actorUID, sql);
      const id = crypto.randomUUID();
      await sql`UPDATE factory.substrate_source SET writable=false,writer_epoch=2,checkpoint_id=${id}
        WHERE workspace_id=${f.workspaceID}`;
      await sql`UPDATE factory.substrate_source SET generation=1,
        checkpoint=${JSON.stringify({ id, workspaceID: f.workspaceID, actorUID, generation: 1, writerEpoch: 2 })}::text::jsonb
        WHERE workspace_id=${f.workspaceID}`;
      await sql`UPDATE factory.substrate_source SET owner='service',writable=true,writer_epoch=3,
        service_base=checkpoint_id,checkpoint_id=NULL WHERE workspace_id=${f.workspaceID}`;
      await sql`UPDATE factory.runtime_attempt SET state=${state} WHERE id=${f.attemptID}`;
      if (state === "stopped") {
        await sql`UPDATE factory.runtime_attempt SET stop_intended_at=now(),
          delete_intended_at=now(),deleted_at=now() WHERE id=${f.attemptID}`;
      }
    });
    return {
      ...f,
      source,
      saved,
      calls,
      request(operation = "write", body?: BodyInit) {
        return new Request(`https://factory.test/${operation}`, {
          method: operation === "events" ? "GET" : "POST",
          ...(operation === "events"
            ? {}
            : {
                body:
                  body ??
                  JSON.stringify({
                    path: "app.ts",
                    destination: "renamed.ts",
                    version: "saved-v1",
                    content: Buffer.from("uploaded bytes").toString("base64"),
                  }),
              }),
        });
      },
      async resume() {
        // Controlled Source handoff only; no native RPC, process or inference.
        await f.database.client.begin(async (sql) => {
          const id = crypto.randomUUID();
          await sql`UPDATE factory.substrate_source SET writable=false,writer_epoch=4,checkpoint_id=${id}
            WHERE workspace_id=${f.workspaceID}`;
          await sql`UPDATE factory.substrate_source SET generation=2,
            checkpoint=${JSON.stringify({ id, workspaceID: f.workspaceID, actorUID, generation: 2, writerEpoch: 4 })}::text::jsonb
            WHERE workspace_id=${f.workspaceID}`;
          await sql`UPDATE factory.substrate_source SET owner='actor',writable=true,writer_epoch=5,
            checkpoint_id=NULL WHERE workspace_id=${f.workspaceID}`;
          await sql`UPDATE factory.runtime_attempt SET state='ready' WHERE id=${f.attemptID}`;
        });
      },
    };
  } catch (cause) {
    await source.close();
    await f.dispose();
    throw cause;
  }
}

test.each(["read", "list"])(
  "paused retained Actor Source wakes for %s before Work or App readiness",
  async (operation) => {
    const f = await mutationFixture();
    try {
      await f.resume();
      await f.database
        .client`UPDATE factory.runtime_attempt SET state='paused' WHERE id=${f.attemptID}`;
      const before = [
        ...(await f.database
          .client`SELECT * FROM factory.substrate_source WHERE workspace_id=${f.workspaceID}`),
      ];
      let wakes = 0;
      const controller = createWorkspaceSourceController(f.database, f.hub, f.source, {
        async wakeForAccess(workspaceID, userID, signal, write) {
          expect([workspaceID, userID, write]).toEqual([f.workspaceID, f.userID, false]);
          signal?.throwIfAborted();
          wakes++;
          // Source Parent is available while Work preparation is still pending.
          await f.database
            .client`UPDATE factory.runtime_attempt SET state='starting' WHERE id=${f.attemptID}`;
        },
      });
      try {
        expect((await controller.get(f.workspaceID, f.userID)).state).toBe("paused");
        const response = await controller.forward(
          f.workspaceID,
          f.userID,
          operation,
          f.request(operation),
        );
        expect(response.status).toBe(200);
        expect(wakes).toBe(1);
        expect([
          ...(await f.database
            .client`SELECT * FROM factory.substrate_source WHERE workspace_id=${f.workspaceID}`),
        ]).toEqual(before);
        const [attempt] = await f.database
          .client`SELECT state FROM factory.runtime_attempt WHERE id=${f.attemptID}`;
        expect(attempt?.["state"]).toBe("starting");
      } finally {
        await controller.close();
      }
    } finally {
      await f.dispose();
    }
  },
  30_000,
);

test.each(["write", "mkdir", "delete", "rename"])(
  "paused native Source wakes before %s without holding Source or authority locks",
  async (operation) => {
    const f = await mutationFixture();
    const order: string[] = [];
    const controller = createWorkspaceSourceController(f.database, f.hub, f.source, {
      async wakeForAccess(workspaceID, userID, signal) {
        expect([workspaceID, userID]).toEqual([f.workspaceID, f.userID]);
        expect(signal).toBeInstanceOf(AbortSignal);
        expect(signal?.aborted).toBe(false);
        order.push("wake");
        // Re-entering Source would deadlock/time out if wake held its lock.
        const read = await controller.forward(workspaceID, userID, "read", f.request("read"));
        expect(read.status).toBe(200);
        expect(f.calls.map((call) => call.operation)).toEqual(["read"]);
        await f.resume();
        order.push("resumed");
      },
    });
    try {
      const response = await controller.forward(
        f.workspaceID,
        f.userID,
        operation,
        f.request(operation),
      );
      expect(response.status).toBe(200);
      expect(order).toEqual(["wake", "resumed"]);
      expect(f.calls.map((call) => [call.operation, call.owner, call.epoch])).toEqual([
        ["read", "service", null],
        [operation, "actor", "5"],
      ]);
      expect(f.calls.at(-1)?.input["version"]).toBe("saved-v1");
      if (operation === "write") expect(f.saved.content).toBe("uploaded bytes");
    } finally {
      await controller.close();
      await f.dispose();
    }
  },
  30_000,
);

test.each(["pausing", "resuming"] as const)(
  "Source mutations reject %s without racing lifecycle or waking",
  async (state) => {
    const f = await mutationFixture(state);
    let wakes = 0;
    const controller = createWorkspaceSourceController(f.database, f.hub, f.source, {
      async wakeForAccess() {
        wakes++;
      },
    });
    try {
      await expect(
        controller.forward(f.workspaceID, f.userID, "write", f.request()),
      ).rejects.toThrow("changing state");
      expect(wakes).toBe(0);
      expect(f.calls).toEqual([]);
      expect(f.saved.content).toBe("saved bytes");
    } finally {
      await controller.close();
      await f.dispose();
    }
  },
  30_000,
);

test("retained Source reads and metadata never wake compute or inference", async () => {
  const f = await mutationFixture();
  let wakes = 0;
  const controller = createWorkspaceSourceController(f.database, f.hub, f.source, {
    async wakeForAccess() {
      wakes++;
      throw new Error("Reads must not wake");
    },
  });
  try {
    await controller.get(f.workspaceID, f.userID);
    for (const operation of ["stat", "list", "read", "search", "events"]) {
      const response = await controller.forward(
        f.workspaceID,
        f.userID,
        operation,
        f.request(operation),
      );
      expect(response.status).toBe(200);
      await response.text();
    }
    expect(wakes).toBe(0);
    expect(f.saved.content).toBe("saved bytes");
    expect(await f.database.client`SELECT id FROM factory.agent_turn`).toHaveLength(0);
  } finally {
    await controller.close();
    await f.dispose();
  }
}, 30_000);

test.each(["new", "stopped", "failed"] as const)(
  "existing writable independent %s Source stays editable without starting compute",
  async (state) => {
    const f = await mutationFixture(state);
    let wakes = 0;
    const controller = createWorkspaceSourceController(f.database, f.hub, f.source, {
      async wakeForAccess() {
        wakes++;
        throw new Error("Never restart compute");
      },
    });
    try {
      expect((await controller.forward(f.workspaceID, f.userID, "write", f.request())).status).toBe(
        200,
      );
      expect(wakes).toBe(0);
      expect(f.saved.content).toBe("uploaded bytes");
      expect(f.calls.map((call) => call.owner)).toEqual(["service"]);
      const attempts = await f.database.client`SELECT state FROM factory.runtime_attempt`;
      expect(attempts).toHaveLength(state === "new" ? 0 : 1);
      if (state !== "new") expect(attempts[0]?.["state"]).toBe(state);
    } finally {
      await controller.close();
      await f.dispose();
    }
  },
  30_000,
);

test.each([
  "missing-callback",
  "rejected",
  "still-paused",
  "no-owner-handoff",
  "revoked",
  "unauthorized",
] as const)(
  "unconfirmed Source wake (%s) preserves saved bytes and shared buffers",
  async (scenario) => {
    const f = await mutationFixture();
    const buffer = Buffer.from("retained unsaved shared buffer");
    let wakes = 0;
    const controller = createWorkspaceSourceController(
      f.database,
      f.hub,
      f.source,
      scenario === "missing-callback"
        ? undefined
        : {
            async wakeForAccess() {
              wakes++;
              if (scenario === "rejected") throw new Error("Owned wake rejected");
              if (scenario === "still-paused") return;
              if (scenario === "no-owner-handoff") {
                await f.database
                  .client`UPDATE factory.runtime_attempt SET state='ready' WHERE id=${f.attemptID}`;
                return;
              }
              await f.resume();
              // Also proves the preflight did not retain membership locks.
              await f.database
                .client`UPDATE factory.project_membership SET role='product-contributor'
            WHERE project_id=${f.projectID} AND user_id=${f.userID}`;
            },
          },
    );
    try {
      await f.database
        .client`INSERT INTO factory.workspace_shared_document(workspace_id,path,y_state,disk_version,sync_state)
        VALUES(${f.workspaceID},'app.ts',${buffer},'saved-v1','dirty')`;
      if (scenario === "unauthorized")
        await f.database.client`UPDATE factory.project_membership SET role='product-contributor'
          WHERE project_id=${f.projectID} AND user_id=${f.userID}`;
      const expected = {
        "missing-callback": "Resume this Workspace",
        rejected: "Owned wake rejected",
        "still-paused": "Compute is not resumed",
        "no-owner-handoff": "Source resume is unconfirmed",
        revoked: "Developer access required",
        unauthorized: "Developer access required",
      };
      await expect(
        controller.forward(f.workspaceID, f.userID, "write", f.request(), true),
      ).rejects.toThrow(expected[scenario]);
      expect(wakes).toBe(scenario === "missing-callback" || scenario === "unauthorized" ? 0 : 1);
      expect(f.calls).toEqual([]);
      expect(f.saved).toEqual({ content: "saved bytes", version: "saved-v1" });
      const [shared] = await f.database.client<
        { state: Buffer; syncState: string; version: string }[]
      >`
        SELECT y_state AS state,sync_state AS "syncState",disk_version AS version FROM factory.workspace_shared_document
        WHERE workspace_id=${f.workspaceID} AND path='app.ts'`;
      expect(shared).toEqual({ state: buffer, syncState: "dirty", version: "saved-v1" });
    } finally {
      await controller.close();
      await f.dispose();
    }
  },
  30_000,
);

test("Source finishes an uploaded write body before waking and committing saved bytes", async () => {
  const f = await mutationFixture();
  let wakes = 0;
  const controller = createWorkspaceSourceController(f.database, f.hub, f.source, {
    async wakeForAccess() {
      wakes++;
      await f.resume();
    },
  });
  let upload: ReadableStreamDefaultController<Uint8Array> | undefined;
  let pending: Promise<Response> | undefined;
  try {
    const body = new ReadableStream<Uint8Array>({
      start(target) {
        upload = target;
      },
    });
    pending = controller.forward(f.workspaceID, f.userID, "write", f.request("write", body));
    await Bun.sleep(20);
    expect(wakes).toBe(0);
    expect(f.calls).toEqual([]);
    upload?.enqueue(
      new TextEncoder().encode(
        JSON.stringify({
          path: "app.ts",
          version: "saved-v1",
          content: Buffer.from("complete upload").toString("base64"),
        }),
      ),
    );
    upload?.close();
    expect((await pending).status).toBe(200);
    expect(wakes).toBe(1);
    expect(f.saved.content).toBe("complete upload");
  } finally {
    upload?.error(new Error("Owned upload cleanup"));
    await pending?.catch(() => {});
    await controller.close();
    await f.dispose();
  }
}, 30_000);

test("Source keeps the caller's saved-file version fence after wake", async () => {
  const f = await mutationFixture();
  const controller = createWorkspaceSourceController(f.database, f.hub, f.source, {
    async wakeForAccess() {
      await f.resume();
      f.saved.content = "concurrent saved bytes";
      f.saved.version = "saved-during-resume";
    },
  });
  try {
    expect((await controller.forward(f.workspaceID, f.userID, "write", f.request())).status).toBe(
      409,
    );
    expect(f.calls[0]?.input["version"]).toBe("saved-v1");
    expect(f.saved.content).toBe("concurrent saved bytes");
  } finally {
    await controller.close();
    await f.dispose();
  }
}, 30_000);

test.each(["request-abort", "controller-close", "wake-ignores-abort"] as const)(
  "cancelled Source wake (%s) cannot dispatch a save or discard shared buffers",
  async (scenario) => {
    const f = await mutationFixture();
    const entered = Promise.withResolvers<AbortSignal>();
    const finish = Promise.withResolvers<void>();
    const requestAbort = new AbortController();
    const buffer = Buffer.from("unsaved buffer retained across cancelled wake");
    const controller = createWorkspaceSourceController(f.database, f.hub, f.source, {
      async wakeForAccess(_workspaceID, _userID, signal) {
        if (!signal) throw new Error("Source wake signal missing");
        entered.resolve(signal);
        if (scenario === "wake-ignores-abort") {
          await finish.promise;
          // A dispatched resume may still finish; cancellation must not roll
          // it back, but must prevent the now-cancelled file mutation.
          await f.resume();
          return;
        }
        await new Promise<void>((_resolve, reject) => {
          if (signal.aborted) reject(signal.reason);
          else signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
      },
    });
    let outcome: Promise<string> | undefined;
    let closed = false;
    try {
      await f.database
        .client`INSERT INTO factory.workspace_shared_document(workspace_id,path,y_state,disk_version,sync_state)
        VALUES(${f.workspaceID},'app.ts',${buffer},'saved-v1','dirty')`;
      outcome = controller
        .forward(
          f.workspaceID,
          f.userID,
          "write",
          new Request(f.request(), { signal: requestAbort.signal }),
          true,
        )
        .then(
          () => "unexpected mutation",
          (cause: Error) => cause.name,
        );
      const signal = await entered.promise;
      expect(signal.aborted).toBe(false);
      if (scenario === "controller-close") {
        await controller.close();
        closed = true;
      } else requestAbort.abort();
      expect(signal.aborted).toBe(true);
      finish.resolve();
      expect(await outcome).toBe("AbortError");
      expect(f.calls).toEqual([]);
      expect(f.saved).toEqual({ content: "saved bytes", version: "saved-v1" });
      const [shared] = await f.database.client<
        { state: Buffer; syncState: string; version: string }[]
      >`SELECT y_state AS state,sync_state AS "syncState",disk_version AS version FROM factory.workspace_shared_document
        WHERE workspace_id=${f.workspaceID} AND path='app.ts'`;
      expect(shared).toEqual({ state: buffer, syncState: "dirty", version: "saved-v1" });
    } finally {
      requestAbort.abort();
      finish.resolve();
      await outcome;
      if (!closed) await controller.close();
      await f.dispose();
    }
  },
  30_000,
);

test("Source request cancelled during authorization cannot start its paused wake", async () => {
  const f = await mutationFixture();
  const locked = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const requestAbort = new AbortController();
  let wakes = 0;
  const controller = createWorkspaceSourceController(f.database, f.hub, f.source, {
    async wakeForAccess() {
      wakes++;
      await f.resume();
    },
  });
  let holding: Promise<unknown> | undefined;
  let outcome: Promise<string> | undefined;
  try {
    holding = f.database.client.begin(async (sql) => {
      await sql`SELECT user_id FROM factory.project_membership
        WHERE project_id=${f.projectID} AND user_id=${f.userID} FOR UPDATE`;
      locked.resolve();
      await release.promise;
    });
    await locked.promise;
    outcome = controller
      .forward(
        f.workspaceID,
        f.userID,
        "write",
        new Request(f.request(), { signal: requestAbort.signal }),
      )
      .then(
        () => "unexpected mutation",
        (cause: Error) => cause.name,
      );
    await Bun.sleep(20);
    requestAbort.abort();
    release.resolve();
    await holding;
    expect(await outcome).toBe("AbortError");
    expect(wakes).toBe(0);
    expect(f.calls).toEqual([]);
    expect(f.saved).toEqual({ content: "saved bytes", version: "saved-v1" });
  } finally {
    requestAbort.abort();
    release.resolve();
    await holding;
    await outcome;
    await controller.close();
    await f.dispose();
  }
}, 30_000);
