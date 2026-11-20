import { expect, test } from "bun:test";
import type { ServerWebSocket } from "bun";
import { createCodingRuntimeShutdown } from "../../apps/factory/src/agent/runtime-shutdown";
import { claimAgentWriterIn } from "../../apps/factory/src/access/change-writer";
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
import { objectDigest } from "../../apps/factory/src/storage/objects";
import { createSubstrateSources } from "../../apps/factory/src/workspace/substrate-source";
import {
  hashConnectorToken,
  runtimeConnectorTokens,
} from "../../packages/runtime-domain/src/identity";
import {
  type NativeActor,
  nativeActor,
  type SubstrateCall,
  SubstrateRPCError,
} from "../../packages/runtime-kubernetes/src/substrate-control";
import { substrateFixture } from "../fixtures/substrate";

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

async function frozenTicketPause(lostOperation: "checkpoint" | "chunk", everReady = true) {
  const f = await substrateFixture("a".repeat(40), "ticket");
  f.config.deployment = "fresh-workspaces";
  let actor: NativeActor | null = null;
  const effects: string[] = [];
  const stored = new Map<string, Uint8Array>();
  const bytes = new TextEncoder().encode("Owned complete Source protocol fixture");
  const bundle = {
    version: 1,
    bytes: bytes.length,
    sha256: objectDigest(bytes),
    chunks: [objectDigest(bytes)],
  };
  let lost = false;
  const checkpoints: Array<{ checkpointId: string; writerEpoch: number }> = [];
  const source = createSubstrateSources(f.database, f.hub, {
    async put(key, value) {
      stored.set(key, new Uint8Array(value));
    },
    async read(key) {
      const value = stored.get(key);
      if (!value) throw Error("Missing owned Source object");
      return value;
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
        actor = f.actor();
        const [created] = await f.database.client<{ at: string }[]>`
          SELECT (create_attempted_at + interval '1 millisecond')::text AS at
          FROM factory.substrate_binding
          WHERE runtime_attempt_id=${f.attemptID} AND create_attempted_at IS NOT NULL`;
        if (!created) throw Error("Owned native Create intent is missing");
        // Keep simulated native creation after its dispatch on the fixture DB's
        // clock, rather than depending on host/container wall-clock alignment.
        actor.metadata.createTime = new Date(created.at).toISOString();
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
          writerEpoch: 2,
          writable: false,
          generation: 1,
        });
        if (!lease?.checkpoint || !lease.checkpointID)
          throw Error("Source checkpoint must be confirmed before native Suspend");
        expect(lease.checkpoint.id).toBe(lease.checkpointID);
        const [dispatch] = await f.database.client`
        SELECT attempted_at IS NOT NULL AS attempted FROM factory.substrate_actor_rpc
        WHERE runtime_attempt_id=${f.attemptID} AND action='suspend'`;
        expect(dispatch?.["attempted"]).toBe(true);
        effects.push(method);
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
        return { actor: structuredClone(actor) };
      }
      throw Error(`Uncommissioned handoff effect: ${method}`);
    },
    {
      attach: source.attach,
      freezeActor: source.freezeActor,
      resume: source.resume,
      requireIndependent: source.requireIndependent,
      async paused() {
        // This controller seam proves confirmation before native dispatch. Actual
        // Linux materialization/service ownership has its separate Source tests.
        expect(nativeActor.parse(actor).status.state).toBe("ACTOR_STATE_SUSPENDED");
        effects.push("Source handoff");
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
    const connected = f.hub.sourceConnected.bind(f.hub);
    const parentOperation = f.hub.parentOperation.bind(f.hub);
    f.hub.sourceConnected = () => true;
    f.hub.parentOperation = async () => ({});
    f.hub.request = async (_attempt, channel, request, path) => {
      expect(channel).toBe("source");
      const identity = (await request.json()) as { checkpointId: string; writerEpoch: number };
      expect(identity.writerEpoch).toBe(2); // Not the separate Change writer epoch.
      checkpoints.push(identity);
      if (!lost && path.endsWith(`/${lostOperation}`)) {
        lost = true;
        throw Error("Runtime request timed out");
      }
      return path.endsWith("/checkpoint") ? Response.json(bundle) : new Response(bytes);
    };
    await expect(controller.pause(f.attemptID)).rejects.toThrow("Runtime request timed out");
    const frozen = await source.lease(f.workspaceID);
    if (!frozen?.actorUID || !frozen.checkpointID)
      throw Error("Owned frozen Source identity is missing");
    const frozenIdentity = {
      ...frozen,
      actorUID: frozen.actorUID,
      checkpointID: frozen.checkpointID,
    };
    expect(frozen).toMatchObject({
      owner: "actor",
      writable: false,
      writerEpoch: 2,
      generation: 0,
      checkpoint: null,
    });
    const retry = await failedTurn("Source owner is frozen; writing fence is unconfirmed");
    expect(
      (
        await f.database
          .client`SELECT state,epoch FROM factory.change_writer WHERE change_id=${f.changeID}`
      )[0],
    ).toMatchObject({ state: "agent-preparing", epoch: "3" });
    f.hub.sourceConnected = connected;
    f.hub.parentOperation = parentOperation;
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
      frozen: frozenIdentity,
      effects,
      checkpoints,
      request,
      retry,
      actor: () => nativeActor.parse(actor),
      async retainedExecution(call: SubstrateCall, changed = false) {
        const [saved] = await f.database.client<
          {
            intent: SubstrateConfiguration & { actorSelector?: Record<string, string> };
          }[]
        >`SELECT intent FROM factory.substrate_binding WHERE runtime_attempt_id=${f.attemptID}`;
        if (!saved) throw Error("Original binding missing");
        const { actorSelector, ...config } = saved.intent;
        expect(actorSelector).toEqual(f.config.workerSelector);
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

test.each([
  ["checkpoint", true],
  ["chunk", true],
  ["checkpoint", false],
  ["chunk", false],
] as const)(
  "lost Ticket Source %s response continues the same frozen handoff on original Parent reconnect, previously ready=%s",
  async (operation, everReady) => {
    const t = await frozenTicketPause(operation, everReady);
    try {
      const { f, controller, source } = t;
      expect(t.effects).toEqual(["CreateActor", "ResumeActor"]);
      expect(await controller.authorizeConnector(t.request("parent"))).toBe(true);
      expect(await controller.authorizeConnector(t.request("child"))).toBe(false);
      await expect(controller.startPersisted(f.changeID, f.userID)).rejects.toThrow();
      await expect(controller.resumeForApp(f.attemptID, f.userID)).rejects.toThrow();
      const [intent] = await f.database
        .client`SELECT attempted_at,outcome FROM factory.substrate_actor_rpc
        WHERE runtime_attempt_id=${f.attemptID} AND action='suspend'`;
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
      expect(t.effects).toEqual(["CreateActor", "ResumeActor", "SuspendActor", "Source handoff"]);
      expect(await source.lease(f.workspaceID)).toMatchObject({
        actorUID: t.frozen?.actorUID,
        writerEpoch: 2,
        generation: 1,
        checkpointID: t.frozen?.checkpointID,
      });
      expect(new Set(t.checkpoints.map((identity) => identity.checkpointId))).toEqual(
        new Set([t.frozen?.checkpointID]),
      );
      expect(
        (
          await f.database
            .client`SELECT state,epoch FROM factory.change_writer WHERE change_id=${f.changeID}`
        )[0],
      ).toMatchObject({ state: "agent-preparing", epoch: "3" });
      expect(t.actor().metadata.uid).toBe(t.frozen?.actorUID);
    } finally {
      await t.dispose();
    }
  },
  60_000,
);

test.each([true, false])(
  "Ticket handoff reconnect rejects wrong identity, intent, epochs and revoked authority without new native effects, previously ready=%s",
  async (everReady) => {
    const t = await frozenTicketPause("checkpoint", everReady);
    try {
      const { f, controller } = t;
      expect(await controller.authorizeConnector(t.request("parent"))).toBe(true);
      const wrongIdentity: Array<Record<string, string>> = [
        { "x-factory-runtime-actor-uid": crypto.randomUUID() },
        { "x-factory-runtime-generation": "2" },
        { "x-factory-runtime-attempt": crypto.randomUUID() },
      ];
      for (const override of wrongIdentity)
        expect(await controller.authorizeConnector(t.request("parent", override))).toBe(false);
      const frozen = await t.source.lease(f.workspaceID);
      const changeCheckpoint = async () =>
        await f.database.client`
      UPDATE factory.substrate_source SET checkpoint_id=${crypto.randomUUID()} WHERE workspace_id=${f.workspaceID}`;
      const changeEpoch = async () =>
        await f.database.client`
      UPDATE factory.substrate_source SET writer_epoch=3 WHERE workspace_id=${f.workspaceID}`;
      await expect(changeCheckpoint()).rejects.toThrow("Source lease facts");
      await expect(changeEpoch()).rejects.toThrow("Source lease facts");
      expect(await t.source.lease(f.workspaceID)).toEqual(frozen);
      const changeOrigin = async () =>
        await f.database.client`
      UPDATE factory.substrate_actor_rpc SET native_version='99'
      WHERE runtime_attempt_id=${f.attemptID} AND action='suspend'`;
      await expect(changeOrigin()).rejects.toThrow("immutable");
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
  "Ticket frozen handoff does not admit a Parent or continue when %s, previously ready=%s",
  async (scenario, everReady) => {
    const t = await frozenTicketPause("checkpoint", everReady);
    try {
      const { f, controller } = t;
      expect(await controller.authorizeConnector(t.request("parent"))).toBe(true);
      if (scenario === "active-turn") {
        const store = createAgentTurnStore(f.database);
        const previous = await store.get(t.retry);
        if (!previous) throw Error("Owned failed turn missing");
        await store.admit(
          { ...previous.command, commandId: crypto.randomUUID() },
          previous.authority,
        );
      } else {
        await f.database.client`UPDATE factory.substrate_actor_rpc SET attempted_at=now()
          WHERE runtime_attempt_id=${f.attemptID} AND action='suspend'`;
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
        checkpointID: t.frozen?.checkpointID,
        writerEpoch: 2,
        generation: 0,
        writable: false,
      });
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
  const controller = await f.controller(async (method) => {
    if (method === "GetAtespace") return f.space;
    if (method === "GetActorTemplate") return f.template;
    if (method === "GetActor") {
      if (!actor) throw new SubstrateRPCError("NotFound", "absent");
      return structuredClone(actor);
    }
    if (method === "CreateActor") {
      actor = f.actor();
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
  }, source);
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

test("a previously ready personal Workspace with its original frozen pause recovers only Source Parent authority, not Child execution", async () => {
  const f = await substrateFixture();
  f.config.deployment = "fresh-workspaces";
  let actor: NativeActor | null = null;
  let resumes = 0;
  const source = createSubstrateSources(f.database, f.hub);
  const controller = await f.controller(async (method) => {
    if (method === "GetAtespace") return f.space;
    if (method === "GetActorTemplate") return f.template;
    if (method === "GetActor") {
      if (!actor) throw new SubstrateRPCError("NotFound", "absent");
      return structuredClone(actor);
    }
    if (method === "CreateActor") {
      actor = f.actor();
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
    throw Error(`Read-only pause recovery dispatched ${method}`);
  }, source);
  try {
    await controller.start(f.projectID, f.userID);
    const uid = nativeActor.parse(actor).metadata.uid;
    const checkpointID = crypto.randomUUID();
    await f.database
      .client`UPDATE factory.runtime_attempt SET state='pausing',ready_at=now(),failure=NULL WHERE id=${f.attemptID}`;
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
    await f.database
      .client`UPDATE factory.substrate_source SET writable=false,writer_epoch=2,checkpoint_id=${checkpointID} WHERE workspace_id=${f.workspaceID}`;
    expect(await controller.authorizeConnector(request("parent"))).toBe(true);
    expect(await controller.authorizeConnector(request("child"))).toBe(false);
    f.hub.revoke(f.attemptID);
    expect(f.hub.authorize(request("parent"), hashConnectorToken)).toBeNull();
    const restored = Promise.withResolvers<void>();
    const allow = f.hub.allow.bind(f.hub);
    f.hub.allow = (...args) => {
      allow(...args);
      restored.resolve();
    };
    // Recovery activation deliberately follows listener readiness; observe its
    // real admission event rather than polling or starting another runtime.
    const activate = await controller.recover();
    activate();
    await restored.promise;
    expect(f.hub.authorize(request("parent"), hashConnectorToken)).not.toBeNull();
    expect(await controller.authorizeConnector(request("parent"))).toBe(true);
    expect(await controller.authorizeConnector(request("child"))).toBe(false);
    expect((await controller.get(f.attemptID))?.state).toBe("pausing");
    expect(await source.lease(f.workspaceID)).toMatchObject({
      owner: "actor",
      writable: false,
      writerEpoch: 2,
      checkpointID,
      generation: 0,
    });
    expect(resumes).toBe(1);
    await f.database
      .client`UPDATE factory.project_membership SET role='product-contributor' WHERE project_id=${f.projectID} AND user_id=${f.userID}`;
    expect(await controller.authorizeConnector(request("parent"))).toBe(false);
    expect(resumes).toBe(1);
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
        actor = f.actor();
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
    const controller = await f.controller(call, source);
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
      await expect(controller.stop(f.attemptID)).rejects.toThrow(
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
      expect((await controller.pause(f.attemptID))?.state).toBe("paused");
      await expect(controller.stop(f.attemptID)).rejects.toThrow("independent Source");
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
        .client`SELECT checkpoint FROM factory.substrate_binding WHERE runtime_attempt_id=${f.attemptID}`;
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
            .client`SELECT checkpoint FROM factory.substrate_binding WHERE runtime_attempt_id=${f.attemptID}`
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
        FROM factory.substrate_binding WHERE runtime_attempt_id=${f.attemptID}`;
      expect(retainedAfterMemoryFailure?.["checkpoint"]).toEqual(savedBeforeCrash?.["checkpoint"]);
      expect(retainedAfterMemoryFailure?.["reason"]).toBe("killed for exceeding its memory limit");
    } finally {
      await source.close();
      await f.dispose();
    }
  },
  60_000,
);

test.each(["previously-ready", "connected-parent", "frozen-source", "ticket"])(
  "retained-bootstrap pause cannot bypass normal Source or Coding fences: %s",
  async (scenario) => {
    const f = await substrateFixture("a".repeat(40), scenario === "ticket" ? "ticket" : "personal");
    f.config.deployment = "fresh-workspaces";
    let actor: NativeActor | null = null;
    let suspends = 0;
    const source = createSubstrateSources(f.database, f.hub);
    f.hub.sourceConnected = () => scenario === "connected-parent";
    f.hub.parentOperation = async () => {
      throw new Error("Source drain remains unconfirmed");
    };
    const controller = await f.controller(async (method) => {
      if (method === "GetAtespace") return f.space;
      if (method === "GetActorTemplate") return f.template;
      if (method === "GetActor") {
        if (!actor) throw new SubstrateRPCError("NotFound", "absent");
        return structuredClone(actor);
      }
      if (method === "CreateActor") {
        actor = f.actor();
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
    }, source);
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
        "Source drain remains unconfirmed",
      );
      expect(suspends).toBe(0);
      expect((await source.lease(f.workspaceID))?.owner).toBe("actor");
      expect([
        ...(await f.database
          .client`SELECT checkpoint FROM factory.substrate_binding WHERE runtime_attempt_id=${f.attemptID}`),
      ]).toMatchObject([{ checkpoint: null }]);
    } finally {
      await source.close();
      await f.dispose();
    }
  },
  60_000,
);
