import { expect, test } from "bun:test";
import { runtimeIdentity } from "#runtime-domain/identity";
import { type NativeActor, SubstrateRPCError } from "#runtime-kubernetes/substrate-control";
import { claimAgentWriterIn } from "../../apps/factory/src/access/change-writer";
import { createChangeWriterController } from "../../apps/factory/src/access/writer-controller";
import { createChangeAgentStop } from "../../apps/factory/src/agent/stop";
import { createAgentTurnStore } from "../../apps/factory/src/agent/turn-store";
import { CommandError } from "../../apps/factory/src/command-error";
import {
  substrateActorSelector,
  substrateTemplateSHA256,
} from "../../apps/factory/src/runtime/substrate";
import {
  dispatchActorRPCIn,
  intendActorRPCIn,
} from "../../apps/factory/src/runtime/substrate-rpc-facts";
import { renderSubstrateTemplate } from "../../apps/factory/src/runtime/substrate-template";
import { admitInitialSourceSeedIn } from "../../apps/factory/src/workspace/source-api";
import { createWorkspaceSourceController } from "../../apps/factory/src/workspace/source-controller";
import {
  initialSourceRoleIn,
  type SourceRoleFence,
  templateInitialSourceRole,
} from "../../apps/factory/src/workspace/source-role-fence";
import { createSubstrateSources } from "../../apps/factory/src/workspace/substrate-source";
import {
  nativeProjectBootstrap,
  nativeProjectDefinition,
  nativeProjectTemplate,
} from "../fixtures/native-project";
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
  "late-busy-source",
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
    // Saved configuration is controlled here; Source materialization belongs
    // to its own lane. Keep the real lease, import and role-fencing methods.
    sources.startupConfiguration = async (workspaceID, actorTemplatePath) => {
      expect(workspaceID).toBe(f.workspaceID);
      expect(actorTemplatePath).toBe(nativeProjectTemplate.path);
      return { systemContract: null, actorTemplate: nativeProjectTemplate };
    };
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
          nativeProjectBootstrap({
            sourceHandoff: fault !== "missing-capability",
            assignment: {
              runtimeAttemptId: f.attemptID,
              generation: 1,
              repositoryIdentity: f.projectID,
              preserveWorkspace: true,
            },
            source: { workspaceId: f.workspaceID, projectId: f.projectID },
          }),
          nativeProjectDefinition,
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
          const source = await sources.lease(f.workspaceID);
          if (!source?.seed) throw Error("Owned independent Source seed missing");
          expect(source).toMatchObject({
            actorUID: null,
            owner: "service",
            writable: true,
            writerEpoch: 1,
            generation: 0,
            serviceBase: source.seed.id,
            seedConfirmedAt: null,
          });
          const checkpointID = crypto.randomUUID();
          const checkpoint = {
            id: checkpointID,
            workspaceID: f.workspaceID,
            actorUID: null,
            seedID: source.seed.id,
            writerEpoch: 2,
            generation: 1,
            bundle: { version: 1, bytes: 1, sha256: "a".repeat(64), chunks: ["a".repeat(64)] },
          };
          // Controlled complete initial export, before the real sources.resume
          // consumes it. Native materialization has its own acceptance lane.
          await f.database.client.begin(async (sql) => {
            await sql`UPDATE factory.substrate_source SET seed_confirmed_at=now()
              WHERE workspace_id=${f.workspaceID}`;
            await sql`UPDATE factory.substrate_source SET writable=false,writer_epoch=2,
              checkpoint_id=${checkpointID} WHERE workspace_id=${f.workspaceID}`;
            await sql`UPDATE factory.substrate_source SET generation=1,
              checkpoint=${JSON.stringify(checkpoint)}::jsonb WHERE workspace_id=${f.workspaceID}`;
          });
          return structuredClone(actor);
        }
        if (method === "ResumeActor" && actor) {
          resumes++;
          actor.metadata.version = String(BigInt(actor.metadata.version) + 1n);
          actor.status.workerAssignment = { sandboxRuntime: f.config.runtime };
          if (resumes === 1) {
            const actorUID = actor.metadata.uid;
            const source = await sources.lease(f.workspaceID);
            if (!source?.seed || !source.checkpoint)
              throw Error("Owned initial Source export missing");
            expect(source).toMatchObject({
              actorUID: null,
              owner: "service",
              writable: false,
              writerEpoch: 2,
              generation: 1,
              checkpointID: source.checkpoint.id,
            });
            expect(source.seedConfirmedAt).not.toBeNull();
            // Controlled Source2 import ACK, using the real storage constraints.
            await f.database.client.begin(async (sql) => {
              await sql`UPDATE factory.substrate_source SET owner='actor',actor_uid=${actorUID},
                writer_epoch=3,writable=true,checkpoint_id=NULL WHERE workspace_id=${f.workspaceID}`;
            });
            actor.status.state = "ACTOR_STATE_RESUMING";
            throw new SubstrateRPCError("Canceled", "Owned first bootstrap interrupted");
          }
          actor.status.state = "ACTOR_STATE_RUNNING";
          return { actor: structuredClone(actor) };
        }
        throw Error(`Uncommissioned native operation ${method}`);
      }, sources);
      await f.database.client.begin(async (sql) => {
        await sql`SELECT pg_advisory_xact_lock(hashtext(${`runtime:${f.workspaceID}`}))`;
        await admitInitialSourceSeedIn(sql, {
          workspaceID: f.workspaceID,
          projectID: f.projectID,
          repositoryURL: "https://example.invalid/fixture.git",
          revision: "a".repeat(40),
          branch: f.branch,
        });
      });
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
      if (!actor) throw Error("Original native bootstrap Actor is missing");
      const initialSource = await sources.lease(f.workspaceID);
      if (!initialSource?.seed) throw Error("Owned committed Source seed missing");
      expect(initialSource).toMatchObject({
        owner: "actor",
        writerEpoch: 3,
        generation: 1,
        writable: true,
        checkpointID: null,
        checkpoint: {
          actorUID: null,
          seedID: initialSource.seed.id,
          writerEpoch: 2,
          generation: 1,
        },
        serviceBase: initialSource.seed.id,
      });
      expect(initialSource.seedConfirmedAt).not.toBeNull();
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
        SELECT resources->'template'->'value' AS template FROM factory.substrate_provision WHERE owner_id=${f.workspaceID} AND kind='workspace' AND generation=1`;
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
        case "human-history": {
          const decisionID = crypto.randomUUID();
          await f.database.client`INSERT INTO factory.audit_event(
          id,kind,scope_type,scope_id,dedupe_key,actor_id,payload)
          VALUES(${decisionID},'access.change_editing_decision','change',${f.changeID},
            ${`access.change_editing_decision:${decisionID}`},${f.userID},
            ${JSON.stringify({
              changeId: f.changeID,
              kind: "takeover",
              fromEpoch: 1,
              toEpoch: 2,
              targetUserId: f.userID,
              requestId: null,
            })}::jsonb)`;
          break;
        }
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
        expect(initialSource?.actorUID).toBe(actor.metadata.uid);
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
      expect(initialSource?.actorUID).toBe(actor.metadata.uid);
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
      let sourceLock: ReturnType<typeof f.database.coordination> | undefined;
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
          case "late-busy-source":
            sourceLock = f.database.coordination();
            await sourceLock`SELECT pg_advisory_lock(hashtext(${`source:${f.workspaceID}`}))`;
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
            writer_epoch=writer_epoch+1,checkpoint_id=${id} WHERE workspace_id=${f.workspaceID}`;
            await f.database.client`UPDATE factory.substrate_source SET generation=generation+1,
            checkpoint=${JSON.stringify({
              id,
              workspaceID: f.workspaceID,
              actorUID: actor?.metadata.uid,
              writerEpoch: initialSource.writerEpoch + 1,
              generation: initialSource.generation + 1,
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
        if (sourceLock) {
          await sourceLock`SELECT pg_advisory_unlock(hashtext(${`source:${f.workspaceID}`}))`;
          await sourceLock.end({ timeout: 1 });
        }
      }
    } finally {
      await sourceController.close();
      await f.dispose();
    }
  },
  60_000,
);

test.each([
  [1, true, true],
  [2, true, true],
  [1, false, true],
  [1, true, false],
] as const)(
  "initial Source role requires an exact receipt: generation %s, seed %s, protocol2 %s",
  async (generation, seeded, protocol2) => {
    const f = await substrateFixture("a".repeat(40), "ticket");
    const sources = createSubstrateSources(f.database, f.hub);
    try {
      if (seeded)
        await f.database.client.begin(async (sql) => {
          await sql`SELECT pg_advisory_xact_lock(hashtext(${`runtime:${f.workspaceID}`}))`;
          await admitInitialSourceSeedIn(sql, {
            workspaceID: f.workspaceID,
            projectID: f.projectID,
            repositoryURL: "https://example.invalid/fixture.git",
            revision: "a".repeat(40),
            branch: f.branch,
          });
          await sql`UPDATE factory.substrate_source SET seed_confirmed_at=now()
            WHERE workspace_id=${f.workspaceID}`;
        });
      const turns = createAgentTurnStore(f.database);
      const [approval] = await f.database.client<{ revision: string }[]>`
        SELECT requirement_revision_id AS revision FROM factory.requirement_approval
        WHERE ticket_id=${f.ticketID}`;
      if (!approval) throw Error("Owned initial role approval missing");
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
          requirementRevisionId: approval.revision,
          conversationVersion: null,
        },
        (sql, record) => claimAgentWriterIn(sql, f.changeID, record.id, f.userID),
      );
      const owned = await turns.claimPending(turn.id);
      const ownerToken = owned?.ownerToken;
      if (!ownerToken) throw Error("Owned initial role lease missing");
      await f.database.client`INSERT INTO factory.change_agent_turn_intent(
        turn_id,change_id,session_id,prompt_id,prompt_text,bootstrap,session_title)
        VALUES(${turn.id},${f.changeID},'ses_owned_receipt','msg_owned_receipt','Owned receipt',true,'Owned receipt')`;
      for (let current = 1; current <= generation; current++) {
        const attemptID = runtimeIdentity(f.workspaceID, current).attemptID;
        const atespace = `fa-${attemptID.replaceAll("-", "")}`;
        const space = {
          metadata: { ...f.space.metadata, name: atespace, uid: crypto.randomUUID() },
        };
        const workloadImage = `registry.test/native@sha256:${"a".repeat(64)}`;
        const template = {
          ...renderSubstrateTemplate(
            atespace,
            { workloadImage, workerSelector: {} },
            nativeProjectBootstrap({
              sourceHandoff: true,
              assignment: {
                runtimeAttemptId: attemptID,
                generation: current,
                repositoryIdentity: f.projectID,
                preserveWorkspace: true,
              },
              source: { workspaceId: f.workspaceID, projectId: f.projectID },
            }),
            nativeProjectDefinition,
          ),
          metadata: { ...f.template.metadata, atespace, uid: crypto.randomUUID() },
        };
        const templateSHA256 = substrateTemplateSHA256(template);
        const actor = f.actor();
        actor.metadata.name = `runtime-${attemptID.replaceAll("-", "")}`;
        actor.metadata.atespace = atespace;
        // Retained native/receipt facts only; this does not dispatch an Actor.
        await f.database.client.begin(async (sql) => {
          await sql`INSERT INTO factory.substrate_provision(owner_id,kind,generation,intent,resources)
            VALUES(${f.workspaceID},'workspace',${current},
            ${JSON.stringify({
              configuration: { deployment: "fresh-workspaces" },
              revision: "a".repeat(40),
              repositoryURL: "https://example.invalid/fixture.git",
              branch: f.branch,
              templateSHA256,
            })}::text::jsonb,
            jsonb_build_object(
              'atespace',jsonb_build_object('attemptedAt',to_jsonb(now()),'value',${JSON.stringify(space)}::text::jsonb),
              'policy',jsonb_build_object('attemptedAt',to_jsonb(now()),'value','{}'::jsonb),
              'template',jsonb_build_object('attemptedAt',to_jsonb(now()),'value',${JSON.stringify({ metadata: template.metadata })}::text::jsonb)))`;
          await sql`INSERT INTO factory.runtime_attempt(id,project_id,workspace_id,change_id,generation,
            revision,state,parent_connector_token_hash,create_intended_at,created_by,
            atespace,actor_name,binding_intent,actor_uid,create_attempted_at,observation)
            VALUES(${attemptID},${f.projectID},${f.workspaceID},${f.changeID},${current},${"a".repeat(40)},
            'create-intended','owned-parent',now(),${f.userID},
            ${atespace},${actor.metadata.name},
            ${JSON.stringify({
              ...f.config,
              deployment: "fresh-workspaces",
              generation: current,
              atespaceUID: space.metadata.uid,
              templateUID: template.metadata.uid,
              templateSHA256,
              ...(protocol2 ? { sourceRestoreProtocol: 2 } : {}),
            })}::jsonb,${actor.metadata.uid},now(),${JSON.stringify(actor)}::jsonb)`;
          if (current < generation) {
            await sql`UPDATE factory.runtime_attempt SET state='stopped',stop_intended_at=now(),
              delete_intended_at=now(),deleted_at=now() WHERE id=${attemptID}`;
            return;
          }
          if (seeded) {
            const seed = (await sources.lease(f.workspaceID, sql))?.seed;
            if (!seed) throw Error("Owned receipt seed missing");
            const id = crypto.randomUUID();
            await sql`UPDATE factory.substrate_source SET writable=false,writer_epoch=2,
              checkpoint_id=${id} WHERE workspace_id=${f.workspaceID}`;
            await sql`UPDATE factory.substrate_source SET generation=1,checkpoint=${JSON.stringify({
              id,
              workspaceID: f.workspaceID,
              actorUID: null,
              seedID: seed.id,
              writerEpoch: 2,
              generation: 1,
              bundle: { version: 1, bytes: 1, sha256: "a".repeat(64), chunks: ["a".repeat(64)] },
            })}::jsonb WHERE workspace_id=${f.workspaceID}`;
            await sql`UPDATE factory.substrate_source SET owner='actor',actor_uid=${actor.metadata.uid},
              writer_epoch=3,writable=true,checkpoint_id=NULL WHERE workspace_id=${f.workspaceID}`;
          } else {
            // Negative control: seedless epoch-1 grants cannot use the exemption.
            await sql`INSERT INTO factory.substrate_source(workspace_id,actor_uid)
              VALUES(${f.workspaceID},${actor.metadata.uid})`;
          }
          const resume = await intendActorRPCIn(sql, attemptID, "resume", null, actor);
          await dispatchActorRPCIn(sql, attemptID, resume);
          actor.status.state = "ACTOR_STATE_RESUMING";
          await sql`UPDATE factory.runtime_attempt SET observation=${JSON.stringify(actor)}::jsonb,
            state='starting' WHERE id=${attemptID}`;
          await sql`UPDATE factory.change SET state='starting',runtime_attempt_id=${attemptID}
            WHERE id=${f.changeID}`;
          await sql`UPDATE factory.change_writer SET fence_attempt_id=${attemptID},fence_required=false
            WHERE change_id=${f.changeID}`;
          const [writer] = await sql<{ epoch: string }[]>`SELECT epoch::text AS epoch
            FROM factory.change_writer WHERE change_id=${f.changeID}`;
          if (!writer) throw Error("Owned initial role writer missing");
          expect(
            await initialSourceRoleIn(sql, f.workspaceID, attemptID, writer.epoch, {
              mode: "initial-bootstrap",
              sql,
              turnID: turn.id,
              ownerToken,
            }),
          ).toBe(seeded && protocol2);
        });
        const identity = {
          attemptID,
          generation: current,
          workspaceID: f.workspaceID,
          projectID: f.projectID,
          workloadImage,
        };
        expect(templateInitialSourceRole(template, identity)).toBe(true);
        expect(templateInitialSourceRole(template, { ...identity, generation: current + 1 })).toBe(
          false,
        );
      }
    } finally {
      await sources.close();
      await f.dispose();
    }
  },
  60_000,
);
