import { expect, test } from "bun:test";
import type { ServerWebSocket } from "bun";
import { hashConnectorToken, runtimeConnectorTokens } from "#runtime-domain/identity";
import {
  type NativeActor,
  nativeActor,
  type SubstrateCall,
  SubstrateRPCError,
} from "#runtime-kubernetes/substrate-control";
import { claimAgentWriterIn } from "../../apps/factory/src/access/change-writer";
import { createCodingRuntimeShutdown } from "../../apps/factory/src/agent/runtime-shutdown";
import { createAgentTurnStore } from "../../apps/factory/src/agent/turn-store";
import type { RuntimeSocketData } from "../../apps/factory/src/runtime/hub";
import {
  createSubstrateExecution,
  type SubstrateConfiguration,
} from "../../apps/factory/src/runtime/substrate";
import {
  dispatchActorRPCIn,
  intendActorRPCIn,
} from "../../apps/factory/src/runtime/substrate-rpc-facts";
import {
  createSubstrateSources,
  type SubstrateSourceHandoff,
} from "../../apps/factory/src/workspace/substrate-source";
import { substrateFixture } from "../fixtures/substrate";

function controlledGrantedSource(
  f: Awaited<ReturnType<typeof substrateFixture>>,
  source: ReturnType<typeof createSubstrateSources>,
): SubstrateSourceHandoff {
  return {
    ...source,
    async attach(workspaceID, actorUID, sql) {
      expect(workspaceID).toBe(f.workspaceID);
      if (!(await source.lease(workspaceID, sql))) await f.admitActorSource(actorUID);
      // These pause fixtures begin after a committed import, not native cold restore.
      expect(await source.lease(workspaceID, sql)).toMatchObject({
        actorUID,
        owner: "actor",
      });
    },
  };
}

async function handoffEvent<T>(promise: Promise<T>, name: string) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(Error(`Recorded handoff did not reach ${name}`)), 5_000);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function retainedTicketPause(everReady = true) {
  const f = await substrateFixture("a".repeat(40), "ticket");
  f.config.deployment = "fresh-workspaces";
  let actor: NativeActor | null = null;
  const effects: string[] = [];
  let lostSuspendResponse: "running" | "completed" | undefined;
  const source = createSubstrateSources(f.database, f.hub, {
    async put() {
      throw Error("Ordinary Pause must not export Source objects");
    },
    async read() {
      throw Error("Ordinary Pause must not restore Source objects");
    },
    async remove() {
      throw Error("Source must not be discarded");
    },
    async open() {
      throw Error("Unused Source operation");
    },
  });
  const controller = await f.controller(
    async (method) => {
      if (method === "GetAtespace") return f.space;
      if (method === "GetActorTemplate") return f.template;
      if (method === "GetActor") {
        if (!actor) throw new SubstrateRPCError("NotFound", "absent");
        return structuredClone(actor);
      }
      if (method === "CreateActor") {
        effects.push(method);
        actor = await f.createdActor();
        return structuredClone(actor);
      }
      if (method === "ResumeActor" && actor) {
        effects.push(method);
        actor.metadata.version = "3";
        actor.status = {
          state: "ACTOR_STATE_RUNNING",
          workerAssignment: { sandboxRuntime: f.config.runtime },
        };
        return { actor: structuredClone(actor) };
      }
      if (method === "SuspendActor" && actor) {
        const lease = await source.lease(f.workspaceID);
        expect(lease).toMatchObject({
          actorUID: actor.metadata.uid,
          owner: "actor",
          writerEpoch: 1,
          writable: true,
          generation: 0,
          checkpoint: null,
          checkpointID: null,
        });
        const [dispatch] = await f.database.client`
        SELECT (payload->>'attemptedAt') IS NOT NULL AS attempted FROM factory.operation
        WHERE kind='runtime.actor_rpc' AND scope_type='runtime_attempt'
          AND scope_id=${f.attemptID} AND payload->>'action'='suspend'`;
        expect(dispatch?.["attempted"]).toBe(true);
        effects.push(method);
        if (lostSuspendResponse === "running") throw Error("Native Suspend response timed out");
        const uuid = crypto.randomUUID();
        actor.metadata.version = "4";
        actor.status = {
          state: "ACTOR_STATE_SUSPENDED",
          lastAssignedGeneration: 1,
          snapshots: [
            {
              uuid,
              generation: 1,
              owner: "SNAPSHOT_OWNER_ACTOR",
              fidelity: "SNAPSHOT_FIDELITY_ROOTFS",
              actorTemplateUid: f.config.templateUID,
              sandboxRuntime: f.config.runtime,
              durableSnapshot: {
                state: "SNAPSHOT_STORAGE_STATE_COMPLETED",
                object: {
                  snapshotUri: `s3://owned/prefix/atespaces/${f.atespace}/actors/${actor.metadata.uid}/snapshots/${uuid}`,
                },
              },
            },
          ],
        };
        if (lostSuspendResponse === "completed") throw Error("Native Suspend response timed out");
        return { actor: structuredClone(actor) };
      }
      throw Error(`Uncommissioned handoff effect: ${method}`);
    },
    {
      attach: controlledGrantedSource(f, source).attach,
      async freezeActor() {
        throw Error("Ordinary Pause must not freeze canonical Source");
      },
      resume: source.resume,
      requireIndependent: source.requireIndependent,
      async makeIndependent() {
        throw Error("Ordinary Pause must not transfer canonical Source");
      },
    },
  );
  try {
    await f.database
      .client`UPDATE factory.change_writer SET state='human',user_id=${f.userID} WHERE change_id=${f.changeID}`;
    await controller.startPersisted(f.changeID, f.userID);
    if (everReady)
      await f.database
        .client`UPDATE factory.runtime_attempt SET state='ready',ready_at=now() WHERE id=${f.attemptID}`;
    else
      await f.database.client`UPDATE factory.runtime_attempt SET state='failed',
        failure='Owned initial bootstrap did not finish' WHERE id=${f.attemptID}`;
    const store = createAgentTurnStore(f.database);
    const [approval] = await f.database.client<{ revision: string }[]>`
      SELECT requirement_revision_id AS revision FROM factory.requirement_approval WHERE ticket_id=${f.ticketID}`;
    if (!approval) throw Error("Owned approval missing");
    const requirementRevisionID = approval.revision;
    async function failedTurn(summary: string) {
      const { turn } = await store.admit(
        {
          kind: "change-start",
          commandId: crypto.randomUUID(),
          projectId: f.projectID,
          ticketId: f.ticketID,
          changeId: f.changeID,
          createdBy: f.userID,
          conversationId: null,
        },
        {
          mode: "build",
          modelId: "owned-source-handoff",
          skillRevisionIds: [],
          requiredSkillRevisionIds: [],
          conversationVersion: null,
          requirementRevisionId: requirementRevisionID,
        },
        (sql, turn) => claimAgentWriterIn(sql, f.changeID, turn.id, f.userID),
      );
      const claim = await store.claimPending(turn.id);
      if (!claim?.ownerToken) throw Error("Owned turn claim missing");
      expect(await store.failPending(turn.id, claim.ownerToken, summary)).toBe(true);
      return turn.id;
    }
    const original = await failedTurn("Configured engine never became ready");
    const sessionID = `ses_owned_${original.replaceAll("-", "")}`;
    await f.database.client`INSERT INTO factory.change_agent_turn_intent(
      turn_id,change_id,session_id,prompt_id,prompt_text,bootstrap,session_title,runtime_attempt_id)
      VALUES(${original},${f.changeID},${sessionID},${`msg_owned_${original.replaceAll("-", "")}`},
        'Owned startup',true,'Owned Source handoff',${f.attemptID})`;
    await f.database.client`INSERT INTO factory.change_agent_session(
      change_id,runtime_attempt_id,opencode_session_id,state,created_by,active_turn_id)
      VALUES(${f.changeID},${f.attemptID},${sessionID},'failed',${f.userID},${original})`;
    f.hub.childOperation = async () => {
      throw Error("Ordinary Pause must not request Child input or Source export");
    };
    f.hub.parentOperation = async () => {
      throw Error("Ordinary Pause must not request a Source drain");
    };
    f.hub.request = async () => {
      throw Error("Observation and Pause must not send Source or inference requests");
    };
    const retained = await source.lease(f.workspaceID);
    if (!retained?.actorUID) throw Error("Owned retained Source Actor is missing");
    expect(retained).toMatchObject({
      owner: "actor",
      writable: true,
      writerEpoch: 1,
      generation: 0,
      checkpoint: null,
      checkpointID: null,
    });
    const uid = nativeActor.parse(actor).metadata.uid;
    const request = (role: "parent" | "child", override: Record<string, string> = {}) =>
      new Request("https://factory.test/internal/runtime-connect", {
        headers: {
          "x-factory-runtime-attempt": f.attemptID,
          "x-factory-runtime-generation": "1",
          "x-factory-runtime-actor-uid": uid,
          "x-factory-connector-role": role,
          authorization: `Bearer ${runtimeConnectorTokens("owned-native-secret", f.attemptID, 1)[role]}`,
          ...override,
        },
      });
    return {
      f,
      source,
      controller,
      retained: { ...retained, actorUID: retained.actorUID },
      effects,
      request,
      original,
      loseSuspendResponse(state: "running" | "completed") {
        lostSuspendResponse = state;
      },
      async intendPause() {
        // Controlled crash after persisted native intent, before its dispatch.
        // No Source checkpoint/export participates in ordinary user Pause.
        await intendActorRPCIn(
          f.database.client,
          f.attemptID,
          "suspend",
          null,
          nativeActor.parse(actor),
        );
        await f.database
          .client`UPDATE factory.runtime_attempt SET state='pausing' WHERE id=${f.attemptID}`;
      },
      actor: () => nativeActor.parse(actor),
      async retainedExecution(call: SubstrateCall, changed = false) {
        const [saved] = await f.database.client<
          {
            intent: SubstrateConfiguration & {
              actorSelector?: Record<string, string>;
              sourceRestoreProtocol?: number;
            };
          }[]
        >`SELECT binding_intent AS intent FROM factory.runtime_attempt WHERE id=${f.attemptID}`;
        if (!saved) throw Error("Original binding missing");
        const { actorSelector, sourceRestoreProtocol, ...config } = saved.intent;
        expect(actorSelector).toEqual(f.config.workerSelector);
        expect(sourceRestoreProtocol).toBe(2);
        return createSubstrateExecution(
          f.database,
          f.hub,
          "owned-native-secret",
          { ...config, ...(changed ? { templateVersion: "99" } : {}) },
          createCodingRuntimeShutdown(f.database, f.hub),
          call,
          source,
        );
      },
      async dispose() {
        await source.close();
        await f.dispose();
      },
    };
  } catch (error) {
    await source.close();
    await f.dispose();
    throw error;
  }
}

test.each([true, false])(
  "Ticket native Pause continues its original undispatched intent on Parent reconnect without Source handoff, previously ready=%s",
  async (everReady) => {
    const t = await retainedTicketPause(everReady);
    try {
      const { f, controller, source } = t;
      await t.intendPause();
      const writerBefore = await f.database
        .client`SELECT * FROM factory.change_writer WHERE change_id=${f.changeID}`;
      const turnBefore = await createAgentTurnStore(f.database).get(t.original);
      expect(t.effects).toEqual(["CreateActor", "ResumeActor"]);
      expect(await controller.authorizeConnector(t.request("parent"))).toBe(true);
      expect(await controller.authorizeConnector(t.request("child"))).toBe(false);
      await expect(controller.startPersisted(f.changeID, f.userID)).rejects.toThrow();
      await expect(controller.resumeForApp(f.attemptID, f.userID)).rejects.toThrow();
      const [intent] = await f.database
        .client`SELECT payload->>'attemptedAt' AS attempted_at,result AS outcome FROM factory.operation
        WHERE kind='runtime.actor_rpc' AND scope_type='runtime_attempt'
          AND scope_id=${f.attemptID} AND payload->>'action'='suspend'`;
      expect(intent).toMatchObject({ attempted_at: null, outcome: null });
      f.hub.revoke(f.attemptID);
      const allowed = Promise.withResolvers<void>();
      const allow = f.hub.allow.bind(f.hub);
      f.hub.allow = (...args) => {
        allow(...args);
        allowed.resolve();
      };
      const activate = await controller.recover();
      activate();
      await handoffEvent(allowed.promise, "Parent admission");
      expect(f.hub.authorize(t.request("parent"), hashConnectorToken)).not.toBeNull();
      expect(
        f.hub.authorize(
          t.request("parent", { authorization: "Bearer not-this-Actor" }),
          hashConnectorToken,
        ),
      ).toBeNull();
      expect(t.effects).toEqual(["CreateActor", "ResumeActor"]);
      const settled = Promise.withResolvers<void>();
      const status = controller.status;
      controller.status = async (...args) => {
        try {
          await status(...args);
          if (args[1] === "source-ready") settled.resolve();
        } catch (error) {
          settled.reject(error);
          throw error;
        }
      };
      const parent = {
        data: { kind: "connector", role: "parent", attemptID: f.attemptID, generation: 1 },
        close() {},
        send(raw: string) {
          const message = JSON.parse(raw);
          if (message.type === "operation-request")
            queueMicrotask(() =>
              f.hub.message(
                parent,
                JSON.stringify({
                  type: "operation-response",
                  action: message.action,
                  operationId: message.operationId,
                }),
              ),
            );
          return 1;
        },
      } as unknown as ServerWebSocket<RuntimeSocketData>;
      f.hub.open(parent);
      f.hub.message(
        parent,
        JSON.stringify({
          type: "hello",
          role: "parent",
          channels: [{ name: "source", kind: "source" }],
        }),
      );
      await handoffEvent(settled.promise, "Source continuation");
      expect(t.effects).toEqual(["CreateActor", "ResumeActor", "SuspendActor"]);
      expect(await source.lease(f.workspaceID)).toEqual(t.retained);
      expect(
        await f.database.client`SELECT * FROM factory.change_writer WHERE change_id=${f.changeID}`,
      ).toEqual(writerBefore);
      expect(await createAgentTurnStore(f.database).get(t.original)).toEqual(turnBefore);
      expect((await controller.get(f.attemptID))?.state).toBe("paused");
      expect(t.actor().metadata.uid).toBe(t.retained?.actorUID);
    } finally {
      await t.dispose();
    }
  },
  60_000,
);

test.each([true, false])(
  "Ticket native Pause reconnect rejects wrong identity, intent, epochs and revoked authority without new native effects, previously ready=%s",
  async (everReady) => {
    const t = await retainedTicketPause(everReady);
    try {
      const { f, controller } = t;
      await t.intendPause();
      expect(await controller.authorizeConnector(t.request("parent"))).toBe(true);
      const wrongIdentity: Array<Record<string, string>> = [
        { "x-factory-runtime-actor-uid": crypto.randomUUID() },
        { "x-factory-runtime-generation": "2" },
        { "x-factory-runtime-attempt": crypto.randomUUID() },
      ];
      for (const override of wrongIdentity)
        expect(await controller.authorizeConnector(t.request("parent", override))).toBe(false);
      const retained = await t.source.lease(f.workspaceID);
      const changeCheckpoint = async () =>
        await f.database.client`
      UPDATE factory.substrate_source SET checkpoint_id=${crypto.randomUUID()} WHERE workspace_id=${f.workspaceID}`;
      const changeEpoch = async () =>
        await f.database.client`
      UPDATE factory.substrate_source SET writer_epoch=3 WHERE workspace_id=${f.workspaceID}`;
      await expect(changeCheckpoint()).rejects.toThrow("Source lease facts");
      await expect(changeEpoch()).rejects.toThrow("Source identity/epoch/generation changed");
      expect(await t.source.lease(f.workspaceID)).toEqual(retained);
      const version = f.template.metadata.version;
      f.template.metadata.version = "99";
      expect(await controller.authorizeConnector(t.request("parent"))).toBe(false);
      f.template.metadata.version = version;
      const changed = await t.retainedExecution(async () => {
        throw Error("Changed intent must not reach native API");
      }, true);
      expect(await changed.authorizeConnector(t.request("parent"))).toBe(false);
      expect(await controller.authorizeConnector(t.request("parent"))).toBe(true);
      await f.database.client`DELETE FROM factory.project_membership
      WHERE project_id=${f.projectID} AND user_id=${f.userID}`;
      expect(await controller.authorizeConnector(t.request("parent"))).toBe(false);
      expect(t.effects).toEqual(["CreateActor", "ResumeActor"]);
    } finally {
      await t.dispose();
    }
  },
  60_000,
);

test.each([
  ["active-turn", true],
  ["suspend-dispatched", true],
  ["active-turn", false],
  ["suspend-dispatched", false],
] as const)(
  "Ticket native Pause does not admit a Parent or continue when %s, previously ready=%s",
  async (scenario, everReady) => {
    const t = await retainedTicketPause(everReady);
    try {
      const { f, controller } = t;
      await t.intendPause();
      expect(await controller.authorizeConnector(t.request("parent"))).toBe(true);
      if (scenario === "active-turn") {
        const store = createAgentTurnStore(f.database);
        const previous = await store.get(t.original);
        if (!previous) throw Error("Owned failed turn missing");
        await store.admit(
          { ...previous.command, commandId: crypto.randomUUID() },
          previous.authority,
        );
        await expect(controller.pause(f.attemptID)).rejects.toThrow("Stop Coding before pausing");
      } else {
        await f.database.client`UPDATE factory.operation
          SET state='attempted',payload=payload || jsonb_build_object('attemptedAt',now()),updated_at=now()
          WHERE kind='runtime.actor_rpc' AND scope_type='runtime_attempt'
            AND scope_id=${f.attemptID} AND payload->>'action'='suspend'`;
        await expect(controller.pause(f.attemptID)).rejects.toThrow("RPC was not repeated");
      }
      f.hub.revoke(f.attemptID);
      expect(await controller.authorizeConnector(t.request("parent"))).toBe(false);
      // Call the existing adapter recovery synchronously, with its injected
      // fixture transport, to prove no Create/Resume/Suspend is dispatched.
      const recovered = await t.retainedExecution(async (method) => {
        if (method === "GetAtespace") return f.space;
        if (method === "GetActorTemplate") return f.template;
        if (method === "GetActor") return t.actor();
        throw Error(`Uncommissioned recovery effect: ${method}`);
      });
      await recovered.recover();
      expect(f.hub.authorize(t.request("parent"), hashConnectorToken)).toBeNull();
      expect(t.effects).toEqual(["CreateActor", "ResumeActor"]);
      expect(await t.source.lease(f.workspaceID)).toMatchObject({
        checkpointID: null,
        writerEpoch: 1,
        generation: 0,
        writable: true,
      });
    } finally {
      await t.dispose();
    }
  },
  60_000,
);

test.each([
  ["running", true],
  ["completed", true],
  ["running", false],
  ["completed", false],
] as const)(
  "lost native Suspend response retains Ticket Source and reconciles only observed completion: %s, previously ready=%s",
  async (observed, everReady) => {
    const t = await retainedTicketPause(everReady);
    try {
      const { f, controller, source } = t;
      const writerBefore = await f.database
        .client`SELECT * FROM factory.change_writer WHERE change_id=${f.changeID}`;
      const turnBefore = await createAgentTurnStore(f.database).get(t.original);
      t.loseSuspendResponse(observed);
      await expect(controller.pause(f.attemptID)).rejects.toThrow(
        "Native Suspend response timed out",
      );
      expect((await controller.get(f.attemptID))?.state).toBe("pausing");
      expect(await source.lease(f.workspaceID)).toEqual(t.retained);
      expect(t.effects).toEqual(["CreateActor", "ResumeActor", "SuspendActor"]);
      const [dispatch] = await f.database.client`
        SELECT payload->>'attemptedAt' AS attempted_at,result AS outcome FROM factory.operation
        WHERE kind='runtime.actor_rpc' AND scope_type='runtime_attempt'
          AND scope_id=${f.attemptID} AND payload->>'action'='suspend'`;
      expect(dispatch?.["attempted_at"]).not.toBeNull();
      expect(dispatch?.["outcome"]).toBeNull();
      expect(await controller.authorizeConnector(t.request("parent"))).toBe(false);
      expect(await controller.authorizeConnector(t.request("child"))).toBe(false);
      const recovered = await t.retainedExecution(async (method) => {
        if (method === "GetAtespace") return f.space;
        if (method === "GetActorTemplate") return f.template;
        if (method === "GetActor") return t.actor();
        throw Error(`Read-only native Pause recovery dispatched ${method}`);
      });
      await recovered.recover();
      if (observed === "running") {
        await expect(controller.pause(f.attemptID)).rejects.toThrow("RPC was not repeated");
        expect((await controller.get(f.attemptID))?.state).toBe("pausing");
      } else {
        expect((await controller.pause(f.attemptID))?.state).toBe("paused");
        const [confirmed] = await f.database.client`
          SELECT result AS outcome FROM factory.operation
          WHERE kind='runtime.actor_rpc' AND scope_type='runtime_attempt'
            AND scope_id=${f.attemptID} AND payload->>'action'='suspend'`;
        expect(confirmed?.["outcome"]).not.toBeNull();
      }
      expect(t.effects).toEqual(["CreateActor", "ResumeActor", "SuspendActor"]);
      expect(await source.lease(f.workspaceID)).toEqual(t.retained);
      expect(
        await f.database.client`SELECT * FROM factory.change_writer WHERE change_id=${f.changeID}`,
      ).toEqual(writerBefore);
      expect(await createAgentTurnStore(f.database).get(t.original)).toEqual(turnBefore);
    } finally {
      await t.dispose();
    }
  },
  60_000,
);

test("failed personal bootstrap reconnect admits its retained Source Parent only, and still honors access revocation", async () => {
  const f = await substrateFixture();
  f.config.deployment = "fresh-workspaces";
  let actor: NativeActor | null = null;
  const source = createSubstrateSources(f.database, f.hub);
  const granted = controlledGrantedSource(f, source);
  const controller = await f.controller(async (method) => {
    if (method === "GetAtespace") return f.space;
    if (method === "GetActorTemplate") return f.template;
    if (method === "GetActor") {
      if (!actor) throw new SubstrateRPCError("NotFound", "absent");
      return structuredClone(actor);
    }
    if (method === "CreateActor") {
      actor = await f.createdActor();
      return actor;
    }
    if (method === "ResumeActor" && actor) {
      actor.metadata.version = "2";
      actor.status = {
        state: "ACTOR_STATE_RUNNING",
        workerAssignment: { sandboxRuntime: f.config.runtime },
      };
      return { actor: structuredClone(actor) };
    }
    throw new Error(`Unexpected failed-bootstrap effect: ${method}`);
  }, granted);
  try {
    await controller.start(f.projectID, f.userID);
    const uid = nativeActor.parse(actor).metadata.uid;
    await f.database
      .client`UPDATE factory.runtime_attempt SET state='failed',failure='Original bootstrap failed' WHERE id=${f.attemptID}`;
    const request = (role: string) =>
      new Request("https://factory.test/internal/runtime-connect", {
        headers: {
          "x-factory-runtime-attempt": f.attemptID,
          "x-factory-runtime-generation": "1",
          "x-factory-runtime-actor-uid": uid,
          "x-factory-connector-role": role,
        },
      });
    expect(await controller.authorizeConnector(request("parent"))).toBe(true);
    expect(await controller.authorizeConnector(request("child"))).toBe(false);
    await controller.recover();
    expect((await controller.get(f.attemptID))?.state).toBe("failed");
    await f.database
      .client`UPDATE factory.project_membership SET role='product-contributor' WHERE project_id=${f.projectID} AND user_id=${f.userID}`;
    expect(await controller.authorizeConnector(request("parent"))).toBe(false);
  } finally {
    await source.close();
    await f.dispose();
  }
}, 60_000);

test("a previously ready personal Workspace retains writable Source but does not reconnect or replay an unconfirmed native Pause", async () => {
  const f = await substrateFixture();
  f.config.deployment = "fresh-workspaces";
  let actor: NativeActor | null = null;
  let resumes = 0;
  let suspends = 0;
  const source = createSubstrateSources(f.database, f.hub);
  const granted = controlledGrantedSource(f, source);
  const call: SubstrateCall = async (method) => {
    if (method === "GetAtespace") return f.space;
    if (method === "GetActorTemplate") return f.template;
    if (method === "GetActor") {
      if (!actor) throw new SubstrateRPCError("NotFound", "absent");
      return structuredClone(actor);
    }
    if (method === "CreateActor") {
      actor = await f.createdActor();
      return actor;
    }
    if (method === "ResumeActor" && actor) {
      resumes++;
      actor.metadata.version = "2";
      actor.status = {
        state: "ACTOR_STATE_RUNNING",
        workerAssignment: { sandboxRuntime: f.config.runtime },
      };
      return { actor: structuredClone(actor) };
    }
    if (method === "SuspendActor") {
      suspends++;
      throw Error("Native Suspend response timed out");
    }
    throw Error(`Read-only pause recovery dispatched ${method}`);
  };
  const controller = await f.controller(call, granted);
  try {
    await controller.start(f.projectID, f.userID);
    const uid = nativeActor.parse(actor).metadata.uid;
    const retained = await source.lease(f.workspaceID);
    await f.database
      .client`UPDATE factory.runtime_attempt SET state='ready',ready_at=now(),failure=NULL WHERE id=${f.attemptID}`;
    await expect(controller.pause(f.attemptID)).rejects.toThrow(
      "Native Suspend response timed out",
    );
    const request = (role: "parent" | "child") =>
      new Request("https://factory.test/internal/runtime-connect", {
        headers: {
          "x-factory-runtime-attempt": f.attemptID,
          "x-factory-runtime-generation": "1",
          "x-factory-runtime-actor-uid": uid,
          "x-factory-connector-role": role,
          authorization: `Bearer ${runtimeConnectorTokens("owned-native-secret", f.attemptID, 1)[role]}`,
        },
      });
    expect(await controller.authorizeConnector(request("parent"))).toBe(false);
    expect(await controller.authorizeConnector(request("child"))).toBe(false);
    f.hub.revoke(f.attemptID);
    expect(f.hub.authorize(request("parent"), hashConnectorToken)).toBeNull();
    const [saved] = await f.database.client<
      {
        intent: SubstrateConfiguration & {
          actorSelector: Record<string, string>;
          sourceRestoreProtocol: number;
        };
      }[]
    >`SELECT binding_intent AS intent FROM factory.runtime_attempt WHERE id=${f.attemptID}`;
    if (!saved) throw Error("Original personal binding is unavailable");
    const { actorSelector, sourceRestoreProtocol, ...configuration } = saved.intent;
    if (!f.config.workerSelector) throw Error("Original personal Actor selector is unavailable");
    expect(actorSelector).toEqual(f.config.workerSelector);
    expect(sourceRestoreProtocol).toBe(2);
    await createSubstrateExecution(
      f.database,
      f.hub,
      "owned-native-secret",
      configuration,
      createCodingRuntimeShutdown(f.database, f.hub),
      call,
      granted,
    ).recover();
    await expect(controller.pause(f.attemptID)).rejects.toThrow("RPC was not repeated");
    expect(f.hub.authorize(request("parent"), hashConnectorToken)).toBeNull();
    expect(await controller.authorizeConnector(request("parent"))).toBe(false);
    expect(await controller.authorizeConnector(request("child"))).toBe(false);
    expect((await controller.get(f.attemptID))?.state).toBe("pausing");
    expect(await source.lease(f.workspaceID)).toEqual(retained);
    expect({ resumes, suspends }).toEqual({ resumes: 1, suspends: 1 });
    await f.database
      .client`UPDATE factory.project_membership SET role='product-contributor' WHERE project_id=${f.projectID} AND user_id=${f.userID}`;
    expect(await controller.authorizeConnector(request("parent"))).toBe(false);
    expect({ resumes, suspends }).toEqual({ resumes: 1, suspends: 1 });
  } finally {
    await source.close();
    await f.dispose();
  }
}, 60_000);

test.each(["starting", "failed"])(
  "unavailable initial Source blocks Suspend; an original completed pause is reconciled without replay: %s",
  async (initialState) => {
    const f = await substrateFixture();
    f.config.deployment = "fresh-workspaces";
    let actor: NativeActor | null = null;
    let suspends = 0;
    let resumes = 0;
    const source = createSubstrateSources(f.database, f.hub, {
      put: async () => {
        throw new Error("Bootstrap Source cannot be exported without its Parent");
      },
      read: async () => {
        throw new Error("No Source generation may be invented");
      },
      remove: async () => {
        throw new Error("No retained Source may be removed");
      },
      open: async () => {
        throw new Error("No Source generation may be invented");
      },
    });
    const call: SubstrateCall = async (method) => {
      if (method === "GetAtespace") return f.space;
      if (method === "GetActorTemplate") return f.template;
      if (method === "GetActor") {
        if (!actor) throw new SubstrateRPCError("NotFound", "absent");
        return structuredClone(actor);
      }
      if (method === "CreateActor") {
        actor = await f.createdActor();
        return actor;
      }
      if (method === "ResumeActor" && actor) {
        resumes++;
        actor.metadata.version = "2";
        actor.status = {
          state: "ACTOR_STATE_RUNNING",
          workerAssignment: { sandboxRuntime: f.config.runtime },
        };
        return { actor: structuredClone(actor) };
      }
      if (method === "SuspendActor" && actor) {
        suspends++;
        throw new Error("Unavailable initial Source must not dispatch another native checkpoint");
      }
      throw new Error(`Unexpected bootstrap effect: ${method}`);
    };
    const controller = await f.controller(call, controlledGrantedSource(f, source));
    try {
      await controller.start(f.projectID, f.userID);
      const uid = nativeActor.parse(actor).metadata.uid;
      expect(await source.lease(f.workspaceID)).toMatchObject({
        actorUID: uid,
        owner: "actor",
        writable: true,
        generation: 0,
        writerEpoch: 1,
      });
      if (initialState === "failed")
        await f.database
          .client`UPDATE factory.runtime_attempt SET state='failed' WHERE id=${f.attemptID}`;
      await expect(controller.pause(f.attemptID)).rejects.toThrow(
        "No native checkpoint was dispatched",
      );
      expect(suspends).toBe(0);
      expect((await source.lease(f.workspaceID))?.writerEpoch).toBe(1);
      // Controlled native observation of an earlier completed dispatch, not a
      // fresh Suspend or permission to restart the uncertain original bootstrap.
      const dispatch = await intendActorRPCIn(
        f.database.client,
        f.attemptID,
        "suspend",
        null,
        nativeActor.parse(actor),
      );
      await dispatchActorRPCIn(f.database.client, f.attemptID, dispatch);
      const completed = nativeActor.parse(actor);
      const uuid = crypto.randomUUID();
      completed.metadata.version = "3";
      completed.status.state = "ACTOR_STATE_SUSPENDED";
      completed.status.lastAssignedGeneration = 1;
      completed.status.snapshots = [
        {
          uuid,
          generation: 1,
          owner: "SNAPSHOT_OWNER_ACTOR",
          fidelity: "SNAPSHOT_FIDELITY_ROOTFS",
          actorTemplateUid: f.config.templateUID,
          sandboxRuntime: f.config.runtime,
          durableSnapshot: {
            state: "SNAPSHOT_STORAGE_STATE_COMPLETED",
            object: {
              snapshotUri: `s3://owned/prefix/atespaces/${f.atespace}/actors/${uid}/snapshots/${uuid}`,
            },
          },
        },
      ];
      actor = completed;
      await f.database
        .client`UPDATE factory.runtime_attempt SET state='pausing' WHERE id=${f.attemptID}`;
      await expect(controller.start(f.projectID, f.userID)).rejects.toThrow(
        "Reconcile the startup outcome",
      );
      expect(resumes).toBe(1);
      const [beforePause] = await f.database
        .client`SELECT stop_intended_at FROM factory.runtime_attempt WHERE id=${f.attemptID}`;
      expect(beforePause?.["stop_intended_at"]).toBeNull();
      expect((await controller.pause(f.attemptID))?.state).toBe("paused");
      expect((await controller.get(f.attemptID))?.native).toMatchObject({
        actorUID: uid,
        sourceHandoff: "pending",
        portable: false,
        state: "ACTOR_STATE_SUSPENDED",
      });
      expect(suspends).toBe(0);
      expect(await source.lease(f.workspaceID)).toMatchObject({
        actorUID: uid,
        owner: "actor",
        writable: true,
        generation: 0,
        writerEpoch: 1,
        checkpoint: null,
      });
      expect([
        ...(await f.database.client`SELECT to_regclass('factory.workspace_source') AS source,
          to_regclass('factory.factorybox_worker') AS worker`),
      ]).toEqual([{ source: null, worker: null }]);
      expect((await controller.pause(f.attemptID))?.state).toBe("paused");
      expect(suspends).toBe(0);
      await controller.recover();
      expect(resumes).toBe(1);
      await expect(controller.start(f.projectID, f.userID)).rejects.toThrow(
        "Reconcile the startup outcome",
      );
      expect(resumes).toBe(1);
      const [savedBeforeCrash] = await f.database
        .client`SELECT checkpoint FROM factory.runtime_attempt WHERE id=${f.attemptID}`;
      const crashed = nativeActor.parse(actor);
      crashed.metadata.version = String(BigInt(crashed.metadata.version) + 1n);
      crashed.status.state = "ACTOR_STATE_CRASHED";
      actor = crashed;
      const observedCrash = await controller.get(f.attemptID);
      expect(observedCrash?.state).toBe("failed");
      expect(observedCrash?.native?.sourceHandoff).toBe("pending");
      expect(observedCrash?.failure).toContain("not a confirmed recovery point");
      expect(
        (
          await f.database
            .client`SELECT checkpoint FROM factory.runtime_attempt WHERE id=${f.attemptID}`
        )[0]?.["checkpoint"],
      ).toEqual(savedBeforeCrash?.["checkpoint"]);
      expect(suspends).toBe(0);
      expect(resumes).toBe(1);
      crashed.status.crash = {
        message: "killed for exceeding its memory limit",
        crashTime: new Date().toISOString(),
      };
      crashed.status.snapshots = [];
      actor = crashed;
      const observedMemoryFailure = await controller.get(f.attemptID);
      expect(observedMemoryFailure?.state).toBe("failed");
      expect(observedMemoryFailure?.failure).toContain("exceeded its memory limit");
      expect(observedMemoryFailure?.failure).not.toContain("pending snapshot");
      expect((await controller.get(f.attemptID))?.updatedAt).toBe(observedMemoryFailure?.updatedAt);
      const [retainedAfterMemoryFailure] = await f.database
        .client`SELECT checkpoint,observation#>>'{status,crash,message}' AS reason
        FROM factory.runtime_attempt WHERE id=${f.attemptID}`;
      expect(retainedAfterMemoryFailure?.["checkpoint"]).toEqual(savedBeforeCrash?.["checkpoint"]);
      expect(retainedAfterMemoryFailure?.["reason"]).toBe("killed for exceeding its memory limit");
      // Final Stop is not another Pause. Its retained intent blocks all later wakes.
      await expect(controller.stop(f.attemptID)).rejects.toThrow("independent Source");
      expect((await controller.get(f.attemptID))?.state).toBe("stopping");
      await expect(controller.pause(f.attemptID)).rejects.toThrow("stopping");
      await expect(controller.start(f.projectID, f.userID)).rejects.toThrow("retired");
      expect(suspends).toBe(0);
    } finally {
      await source.close();
      await f.dispose();
    }
  },
  60_000,
);

test.each(["previously-ready", "connected-parent", "frozen-source", "ticket"])(
  "destructive Stop after retained bootstrap cannot bypass Source or Coding fences: %s",
  async (scenario) => {
    const f = await substrateFixture("a".repeat(40), scenario === "ticket" ? "ticket" : "personal");
    f.config.deployment = "fresh-workspaces";
    let actor: NativeActor | null = null;
    let suspends = 0;
    const source = createSubstrateSources(f.database, f.hub);
    f.hub.sourceConnected = () => scenario === "connected-parent";
    let childDrained = false;
    f.hub.childOperation = async (attemptID, operation) => {
      expect(attemptID).toBe(f.attemptID);
      expect(operation["action"]).toBe("source-drain");
      const checkpointID = (await source.lease(f.workspaceID))?.checkpointID;
      if (!checkpointID) throw Error("Owned Stop Source checkpoint intent is unavailable");
      expect(operation["operationId"]).toBe(checkpointID);
      childDrained = true;
    };
    f.hub.parentOperation = async () => {
      expect(childDrained).toBe(true);
      throw new Error("Source drain remains unconfirmed");
    };
    const granted = controlledGrantedSource(f, source);
    const controller = await f.controller(async (method) => {
      if (method === "GetAtespace") return f.space;
      if (method === "GetActorTemplate") return f.template;
      if (method === "GetActor") {
        if (!actor) throw new SubstrateRPCError("NotFound", "absent");
        return structuredClone(actor);
      }
      if (method === "CreateActor") {
        actor = await f.createdActor();
        return actor;
      }
      if (method === "ResumeActor" && actor) {
        actor.metadata.version = "2";
        actor.status = {
          state: "ACTOR_STATE_RUNNING",
          workerAssignment: { sandboxRuntime: f.config.runtime },
        };
        return { actor: structuredClone(actor) };
      }
      if (method === "SuspendActor") {
        suspends++;
        throw new Error("Must not bypass Source settlement");
      }
      throw new Error(`Unexpected ${method}`);
    }, granted);
    try {
      if (scenario === "ticket")
        await f.database
          .client`UPDATE factory.change_writer SET state='human',epoch=2,user_id=${f.userID} WHERE change_id=${f.changeID}`;
      if (scenario === "ticket") await controller.startPersisted(f.changeID, f.userID);
      else await controller.start(f.projectID, f.userID);
      if (scenario === "previously-ready")
        await f.database
          .client`UPDATE factory.runtime_attempt SET ready_at=now() WHERE id=${f.attemptID}`;
      if (scenario === "frozen-source")
        await f.database
          .client`UPDATE factory.substrate_source SET writable=false,writer_epoch=2,checkpoint_id=${crypto.randomUUID()} WHERE workspace_id=${f.workspaceID}`;
      await expect(controller.stop(f.attemptID)).rejects.toThrow(
        scenario === "connected-parent"
          ? "Source drain remains unconfirmed"
          : "independent Source is unavailable",
      );
      expect(suspends).toBe(0);
      expect((await source.lease(f.workspaceID))?.owner).toBe("actor");
      expect([
        ...(await f.database
          .client`SELECT checkpoint FROM factory.runtime_attempt WHERE id=${f.attemptID}`),
      ]).toMatchObject([{ checkpoint: null }]);
    } finally {
      await source.close();
      await f.dispose();
    }
  },
  60_000,
);
