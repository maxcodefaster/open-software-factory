import { expect, test } from "bun:test";
import { claimAgentWriterIn } from "../../apps/factory/src/access/change-writer";
import { createChangeWriterController } from "../../apps/factory/src/access/writer-controller";
import { createChangeAgentStop } from "../../apps/factory/src/agent/stop";
import { createAgentTurnStore } from "../../apps/factory/src/agent/turn-store";
import { CommandError } from "../../apps/factory/src/command-error";
import {
  substrateActorSelector,
  substrateTemplateSHA256,
} from "../../apps/factory/src/runtime/substrate";
import { renderSubstrateTemplate } from "../../apps/factory/src/runtime/substrate-template";
import { createWorkspaceSourceController } from "../../apps/factory/src/workspace/source-controller";
import type { SourceRoleFence } from "../../apps/factory/src/workspace/source-role-fence";
import { createSubstrateSources } from "../../apps/factory/src/workspace/substrate-source";
import {
  type NativeActor,
  SubstrateRPCError,
} from "../../packages/runtime-kubernetes/src/substrate-control";
import { substrateFixture } from "../fixtures/substrate";

test.each([
  "valid",
  "shared-query-transaction",
  "missing-capability",
  "missing-reader",
  "native-template-replaced",
  "native-template-changed",
  "native-template-unavailable",
  "bound-history",
  "older-bound-history",
  "missing-input-history",
  "existing-session",
  "human-history",
  "previous-readiness",
  "startup-failure",
  "runtime-stop",
  "frozen-source",
  "expired-lease",
  "revoked-user",
  "changed-requirements",
  "reused-input",
  "parent-only",
  "connected-source-503",
  "connected-source-negative",
  "connected-source-malformed",
  "late-valid",
  "late-offline",
  "late-parent-only",
  "late-source-only",
  "late-negative",
  "late-malformed",
  "late-busy-runtime",
  "late-wrong-attempt",
  "late-wrong-session",
  "late-preserved-offline-source",
  "late-frozen-source",
  "late-expired-lease",
  "late-expiry-after-ack",
  "late-revoked-user",
  "late-changed-requirements",
  "late-stop",
  "late-not-configured",
] as const)(
  "initial Source bootstrap writer preparation: %s",
  async (fault) => {
    const f = await substrateFixture("a".repeat(40), "ticket");
    const sources = createSubstrateSources(f.database, f.hub);
    let runtime: Awaited<ReturnType<typeof f.controller>> | undefined;
    let capabilityReads = 0;
    const sourceController = createWorkspaceSourceController(
      f.database,
      f.hub,
      sources,
      fault === "missing-reader"
        ? undefined
        : {
            async supportsInitialRole(attemptID, sql) {
              capabilityReads++;
              return runtime ? runtime.supportsInitialSourceRole(attemptID, sql) : false;
            },
          },
    );
    let actor: NativeActor | undefined;
    let creates = 0;
    let resumes = 0;
    try {
      f.config.deployment = "fresh-workspaces";
      const metadata = f.template.metadata;
      const nativeTemplate = Object.assign(
        f.template,
        renderSubstrateTemplate(
          f.atespace,
          {
            workloadImage: `registry.test/native@sha256:${"a".repeat(64)}`,
            workerSelector: {
              ...substrateActorSelector("owned-native-secret", f.attemptID),
              "factory.runtime/profile": f.config.profile,
              "factory.dev/deployment": "owned",
            },
          },
          {
            sourceHandoff: fault !== "missing-capability",
            assignment: {
              runtimeAttemptId: f.attemptID,
              generation: 1,
              repositoryIdentity: f.projectID,
              workspaceFolder: "/home/rootless/persist/project",
              connectorStateDir: "/home/rootless/persist/connector",
              preserveWorkspace: true,
            },
            source: { workspaceId: f.workspaceID, projectId: f.projectID },
          },
        ),
        { metadata },
      );
      f.config.templateSHA256 = substrateTemplateSHA256(f.template);
      runtime = await f.controller(async (method) => {
        if (method === "GetAtespace") return f.space;
        if (method === "GetActorTemplate") {
          if (fault === "native-template-unavailable" && capabilityReads)
            throw new SubstrateRPCError("Unavailable", "Owned native template read unavailable");
          return f.template;
        }
        if (method === "GetActor") {
          if (!actor) throw new SubstrateRPCError("NotFound", "Owned Actor absent");
          return structuredClone(actor);
        }
        if (method === "CreateActor") {
          creates++;
          actor = await f.createdActor();
          return structuredClone(actor);
        }
        if (method === "ResumeActor" && actor) {
          resumes++;
          actor.metadata.version = String(BigInt(actor.metadata.version) + 1n);
          actor.status.workerAssignment = { sandboxRuntime: f.config.runtime };
          if (resumes === 1) {
            actor.status.state = "ACTOR_STATE_RESUMING";
            throw new SubstrateRPCError("Canceled", "Owned first bootstrap interrupted");
          }
          actor.status.state = "ACTOR_STATE_RUNNING";
          return { actor: structuredClone(actor) };
        }
        throw Error(`Uncommissioned native operation ${method}`);
      }, sources);
      const writers = createChangeWriterController({
        database: f.database,
        runtime,
        async fenceSource(
          changeID: string,
          epoch: string,
          writable: boolean,
          commission?: SourceRoleFence,
        ) {
          await sourceController.fenceChange(changeID, epoch, writable, commission);
          if (fault === "late-expiry-after-ack" && commission?.mode === "dispatch")
            // Controlled clock expiry after the real protocol acknowledgement.
            // Use the already-owned transaction, never a competing row lock.
            await commission.sql`UPDATE factory.agent_turn
            SET owner_expires_at=clock_timestamp()-interval '1 millisecond'
            WHERE id=${commission.turnID}`;
        },
        agentUsername: "owned-bootstrap",
        async protect() {},
        async stopAgent() {
          throw Error("No earlier native input was ever dispatched");
        },
      });
      const turns = createAgentTurnStore(f.database);
      const [approval] = await f.database.client<{ revision: string }[]>`
      SELECT requirement_revision_id AS revision FROM factory.requirement_approval
      WHERE ticket_id=${f.ticketID}`;
      if (!approval) throw Error("Owned manual approval missing");
      const admit = async (bootstrap = true, commissioned = true, persistInput = true) => {
        const { turn } = await turns.admit(
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
            modelId: "owned-bootstrap",
            skillRevisionIds: [],
            requiredSkillRevisionIds: [],
            conversationVersion: null,
            requirementRevisionId: approval.revision,
          },
          commissioned
            ? (sql, record) => claimAgentWriterIn(sql, f.changeID, record.id, f.userID)
            : undefined,
        );
        if (persistInput)
          await f.database.client`INSERT INTO factory.change_agent_turn_intent(
        turn_id,change_id,session_id,prompt_id,prompt_text,bootstrap,session_title)
        VALUES(${turn.id},${f.changeID},${`ses_owned_${turn.id.replaceAll("-", "")}`},
          ${`msg_owned_${turn.id.replaceAll("-", "")}`},'Owned first startup',${bootstrap},'Owned startup')`;
        const owned = await turns.claimPending(turn.id);
        if (!owned?.ownerToken) throw Error("Owned commissioned lease missing");
        return { ...owned, ownerToken: owned.ownerToken };
      };
      const original = await admit();
      expect(await writers.prepareAgent(f.changeID, original.id, original.ownerToken)).toBe(true);
      await expect(runtime.startPersisted(f.changeID, f.userID)).rejects.toThrow(
        "Owned first bootstrap interrupted",
      );
      expect((await runtime.get(f.attemptID))?.native?.state).toBe("ACTOR_STATE_RESUMING");
      const initialSource = await sources.lease(f.workspaceID);
      expect(initialSource).toMatchObject({
        owner: "actor",
        writerEpoch: 1,
        generation: 0,
        writable: true,
        checkpointID: null,
        checkpoint: null,
      });
      if (fault === "bound-history")
        // Controlled historical dispatch fact. A bound intent can never be
        // cleared by production, even when its native Session was not confirmed.
        await f.database.client`UPDATE factory.change_agent_turn_intent
        SET runtime_attempt_id=${f.attemptID} WHERE turn_id=${original.id}`;
      const stop = createChangeAgentStop(f.database, f.hub);
      await stop.persist(f.changeID);
      expect(await stop.confirm(f.changeID)).toBe(true);
      expect(await turns.get(original.id)).toMatchObject({ state: "stopped", ownerToken: null });
      if (fault === "bound-history") {
        await expect(admit()).rejects.toThrow("previous Agent writer");
        expect({ creates, resumes }).toEqual({ creates: 1, resumes: 1 });
        return;
      }
      if (fault === "older-bound-history" || fault === "missing-input-history") {
        const older = await admit(true, false, fault !== "missing-input-history");
        if (fault === "older-bound-history")
          await f.database.client`UPDATE factory.change_agent_turn_intent
            SET runtime_attempt_id=${f.attemptID} WHERE turn_id=${older.id}`;
        expect(
          await turns.failPending(older.id, older.ownerToken, "Owned incomplete input history"),
        ).toBe(true);
      }
      const next = await admit(fault !== "reused-input");
      const [preparing] = await f.database.client`
      SELECT state,fence_required FROM factory.change_writer WHERE change_id=${f.changeID}`;
      expect(preparing).toMatchObject({ state: "agent-preparing", fence_required: false });
      const [provision] = await f.database.client<{ template: object }[]>`
        SELECT template FROM factory.substrate_workspace WHERE workspace_id=${f.workspaceID} AND generation=1`;
      expect(Object.keys(provision?.template ?? {})).toEqual(["metadata"]);

      switch (fault) {
        case "native-template-replaced":
          nativeTemplate.metadata.uid = crypto.randomUUID();
          break;
        case "native-template-changed": {
          const container = nativeTemplate.containers[0];
          if (!container) throw Error("Owned native workload missing");
          container.image = `registry.test/other@sha256:${"b".repeat(64)}`;
          break;
        }
        case "existing-session":
          await f.database.client`INSERT INTO factory.change_agent_session(
          change_id,runtime_attempt_id,opencode_session_id,state,created_by,active_turn_id)
          VALUES(${f.changeID},${f.attemptID},${`ses_owned_${original.id.replaceAll("-", "")}`},
            'stopped',${f.userID},${original.id})`;
          break;
        case "human-history":
          await f.database.client`INSERT INTO factory.change_editing_decision(
          command_id,change_id,actor_id,target_id,writer_epoch,kind)
          VALUES(${crypto.randomUUID()},${f.changeID},${f.userID},${f.userID},1,'takeover')`;
          break;
        case "previous-readiness":
          await f.database
            .client`UPDATE factory.runtime_attempt SET ready_at=now() WHERE id=${f.attemptID}`;
          break;
        case "startup-failure":
          await f.database
            .client`UPDATE factory.runtime_attempt SET failure='Owned recorded startup failure' WHERE id=${f.attemptID}`;
          break;
        case "runtime-stop":
          await f.database
            .client`UPDATE factory.runtime_attempt SET state='stopping',stop_intended_at=now() WHERE id=${f.attemptID}`;
          break;
        case "frozen-source":
          await f.database.client`UPDATE factory.substrate_source SET writable=false,
          writer_epoch=writer_epoch+1,checkpoint_id=${crypto.randomUUID()} WHERE workspace_id=${f.workspaceID}`;
          break;
        case "expired-lease":
          await f.database
            .client`UPDATE factory.agent_turn SET owner_expires_at=clock_timestamp()-interval '1 millisecond'
          WHERE id=${next.id}`;
          break;
        case "revoked-user":
          await f.database
            .client`DELETE FROM factory.project_membership WHERE project_id=${f.projectID} AND user_id=${f.userID}`;
          break;
        case "changed-requirements":
          await f.database.client`INSERT INTO factory.requirement_revision(
          id,ticket_id,ordinal,canonical_content,content_digest,created_by)
          SELECT ${crypto.randomUUID()},ticket_id,ordinal+1,canonical_content,content_digest,created_by
          FROM factory.requirement_revision WHERE id=${approval.revision}`;
          break;
        case "parent-only":
          f.hub.parentConnected = () => true;
          break;
        case "connected-source-503":
        case "connected-source-negative":
        case "connected-source-malformed":
          f.hub.parentConnected = () => true;
          f.hub.sourceConnected = () => true;
          f.hub.request = async () =>
            fault === "connected-source-503"
              ? new Response(null, { status: 503 })
              : fault === "connected-source-negative"
                ? Response.json({ confirmed: false })
                : new Response("not JSON");
          break;
      }
      if (fault !== "valid" && fault !== "shared-query-transaction" && !fault.startsWith("late-")) {
        const prepared = await writers
          .prepareAgent(f.changeID, next.id, next.ownerToken)
          .catch((cause) => {
            const nativeFailure =
              ((fault === "native-template-replaced" || fault === "native-template-changed") &&
                cause instanceof Error &&
                cause.message === "Native Atespace/template/profile binding changed") ||
              (fault === "native-template-unavailable" &&
                cause instanceof SubstrateRPCError &&
                cause.code === "Unavailable");
            if (
              !nativeFailure &&
              !(cause instanceof CommandError) &&
              !(fault === "connected-source-malformed" && cause instanceof SyntaxError)
            )
              throw cause;
            return false;
          });
        expect(prepared).toBe(false);
        expect({ creates, resumes }).toEqual({ creates: 1, resumes: 1 });
        expect(actor?.metadata.uid).toBe(initialSource?.actorUID);
        return;
      }
      // Only the strictly initial read-only role may await its first Parent.
      // Native continuation still owns the original Actor and dispatch identity.
      const originalClient = f.database.client;
      if (fault === "shared-query-transaction")
        f.database.client = new Proxy(originalClient, {
          apply() {
            throw Error("Source capability lookup left its already-owned query transaction");
          },
        });
      try {
        expect(await writers.prepareAgent(f.changeID, next.id, next.ownerToken)).toBe(true);
      } finally {
        f.database.client = originalClient;
      }
      expect(capabilityReads).toBe(1);
      await runtime.startPersisted(f.changeID, f.userID);
      expect({ creates, resumes }).toEqual({ creates: 1, resumes: 2 });
      expect(actor?.metadata.uid).toBe(initialSource?.actorUID);
      expect(await sources.lease(f.workspaceID)).toEqual(initialSource);
      expect(
        await f.database.client`SELECT change_id FROM factory.change_agent_session
      WHERE change_id=${f.changeID}`,
      ).toHaveLength(0);
      const intents = await f.database.client`SELECT runtime_attempt_id
      FROM factory.change_agent_turn_intent WHERE change_id=${f.changeID}`;
      expect(intents).toHaveLength(2);
      for (const intent of intents) expect(intent["runtime_attempt_id"]).toBeNull();
      if (!fault.startsWith("late-")) return;

      // Controlled native-ready and Session-binding facts at the production
      // confirmation seam. No native engine, hook or model acceptance is claimed.
      const sessionID = `ses_owned_${next.id.replaceAll("-", "")}`;
      await f.database.client.begin(async (sql) => {
        await sql`UPDATE factory.runtime_attempt SET state='ready',ready_at=now() WHERE id=${f.attemptID}`;
        await sql`UPDATE factory.change_agent_turn_intent SET runtime_attempt_id=${f.attemptID}
        WHERE turn_id=${next.id}`;
        await sql`INSERT INTO factory.change_agent_session(
        change_id,runtime_attempt_id,opencode_session_id,state,created_by,active_turn_id)
        VALUES(${f.changeID},${f.attemptID},${sessionID},'starting',${f.userID},${next.id})`;
      });
      const [writer] = await f.database.client<{ epoch: number }[]>`
      SELECT epoch::float8 AS epoch FROM factory.change_writer WHERE change_id=${f.changeID}`;
      if (!writer) throw Error("Current owned writer missing");
      let roleEpoch = writer.epoch - 1;
      let roleReadOnly = true;
      let requests = 0;
      f.hub.parentConnected = () => true;
      f.hub.sourceConnected = () => true;
      f.hub.ready = () => true;
      f.hub.request = async (attempt, channel, request, path) => {
        expect(attempt).toBe(f.attemptID);
        expect(channel).toBe("source");
        expect(path).toBe(`/v1/workspaces/${f.workspaceID}/fence`);
        const body = await request.json();
        expect(body).toEqual({ writerEpoch: writer.epoch, writable: false });
        requests++;
        if (fault === "late-negative") return Response.json({ confirmed: false });
        if (fault === "late-malformed") return new Response("not JSON");
        roleEpoch = body.writerEpoch;
        roleReadOnly = !body.writable;
        return Response.json({ confirmed: true });
      };
      let runtimeLock: ReturnType<typeof f.database.coordination> | undefined;
      try {
        switch (fault) {
          case "late-offline":
            f.hub.parentConnected = () => false;
            f.hub.sourceConnected = () => false;
            break;
          case "late-parent-only":
            f.hub.sourceConnected = () => false;
            break;
          case "late-source-only":
            f.hub.ready = () => false;
            break;
          case "late-busy-runtime":
            runtimeLock = f.database.coordination();
            await runtimeLock`SELECT pg_advisory_lock(hashtext(${`runtime:${f.workspaceID}`}))`;
            break;
          case "late-preserved-offline-source":
            // postgres.js queries are lazy thenables. Start it explicitly
            // before passing a native Promise to Bun's rejection matcher.
            await expect(
              Promise.resolve(
                f.database
                  .client`DELETE FROM factory.substrate_source WHERE workspace_id=${f.workspaceID}`,
              ),
            ).rejects.toThrow("Source ownership and checkpoints cannot be discarded");
            f.hub.sourceConnected = () => false;
            break;
          case "late-frozen-source": {
            const id = crypto.randomUUID();
            await f.database.client`UPDATE factory.substrate_source SET writable=false,
            writer_epoch=2,checkpoint_id=${id} WHERE workspace_id=${f.workspaceID}`;
            await f.database.client`UPDATE factory.substrate_source SET generation=1,
            checkpoint=${JSON.stringify({
              id,
              workspaceID: f.workspaceID,
              actorUID: actor?.metadata.uid,
              writerEpoch: 2,
              generation: 1,
              bundle: { version: 1, bytes: 1, sha256: "a".repeat(64), chunks: ["a".repeat(64)] },
            })}::text::jsonb WHERE workspace_id=${f.workspaceID}`;
            break;
          }
          case "late-expired-lease":
            await f.database.client`UPDATE factory.agent_turn
            SET owner_expires_at=clock_timestamp()-interval '1 millisecond' WHERE id=${next.id}`;
            break;
          case "late-revoked-user":
            await f.database.client`DELETE FROM factory.project_membership
            WHERE project_id=${f.projectID} AND user_id=${f.userID}`;
            break;
          case "late-changed-requirements":
            await f.database.client`INSERT INTO factory.requirement_revision(
            id,ticket_id,ordinal,canonical_content,content_digest,created_by)
            SELECT ${crypto.randomUUID()},ticket_id,ordinal+1,canonical_content,content_digest,created_by
            FROM factory.requirement_revision WHERE id=${approval.revision}`;
            break;
          case "late-stop":
            await stop.persist(f.changeID);
            break;
        }
        const expectedSource = await sources.lease(f.workspaceID);
        const confirming =
          fault === "late-not-configured"
            ? createChangeWriterController({
                database: f.database,
                runtime,
                agentUsername: "owned-bootstrap",
                async protect() {},
                async stopAgent() {},
              })
            : writers;
        const confirmation = confirming.confirmSource(
          f.changeID,
          next.id,
          next.ownerToken,
          fault === "late-wrong-attempt" ? crypto.randomUUID() : f.attemptID,
          fault === "late-wrong-session" ? "ses_other_owned" : sessionID,
        );
        if (fault === "late-valid") {
          await confirmation;
          expect(requests).toBe(1);
          expect(roleEpoch).toBe(writer.epoch);
          await expect(
            f.database.client.begin((sql) =>
              sources.fence(
                crypto.randomUUID(),
                f.attemptID,
                String(writer.epoch),
                false,
                sql,
                true,
              ),
            ),
          ).rejects.toThrow("Current Source role is unavailable");
        } else {
          await expect(confirmation).rejects.toThrow();
          expect(requests).toBe(
            ["late-negative", "late-malformed", "late-expiry-after-ack"].includes(fault) ? 1 : 0,
          );
          expect(roleEpoch).toBe(
            fault === "late-expiry-after-ack" ? writer.epoch : writer.epoch - 1,
          );
        }
        expect(roleReadOnly).toBe(true);
        expect(await sources.lease(f.workspaceID)).toEqual(expectedSource);
        expect({ creates, resumes }).toEqual({ creates: 1, resumes: 2 });
        expect((await turns.get(next.id))?.state).toBe(
          fault === "late-stop" ? "stopped" : "pending",
        );
        expect(
          await f.database.client`SELECT id FROM factory.change_commit_operation
        WHERE change_id=${f.changeID}`,
        ).toHaveLength(0);
      } finally {
        if (runtimeLock) {
          await runtimeLock`SELECT pg_advisory_unlock(hashtext(${`runtime:${f.workspaceID}`}))`;
          await runtimeLock.end({ timeout: 1 });
        }
      }
    } finally {
      await sourceController.close();
      await f.dispose();
    }
  },
  60_000,
);
