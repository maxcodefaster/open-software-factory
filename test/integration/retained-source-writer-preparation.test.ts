import { expect, test } from "bun:test";
import { hashConnectorToken, runtimeConnectorTokens } from "#runtime-domain/identity";
import { claimAgentWriterIn } from "../../apps/factory/src/access/change-writer";
import { createChangeWriterController } from "../../apps/factory/src/access/writer-controller";
import { createReviewAdmission } from "../../apps/factory/src/agent/review-admission";
import { createChangeAgentStop } from "../../apps/factory/src/agent/stop";
import { createAgentTurnStore } from "../../apps/factory/src/agent/turn-store";
import {
  dispatchActorRPCIn,
  intendActorRPCIn,
  observeActorRPCIn,
} from "../../apps/factory/src/runtime/substrate-rpc-facts";
import { admitInitialSourceSeedIn } from "../../apps/factory/src/workspace/source-api";
import { createWorkspaceSourceController } from "../../apps/factory/src/workspace/source-controller";
import { createSubstrateSources } from "../../apps/factory/src/workspace/substrate-source";
import { substrateFixture } from "../fixtures/substrate";

test.each([
  "repair",
  "repair-memory-snapshot",
  "repair-after-review",
  "repair-after-review-wrong-session",
  "delayed-source",
  "review",
  "revoked-member",
  "stale-requirements",
  "expired-lease",
  "Stop",
  "runtime-stop",
  "uncertain-turn",
  "uncertain-native-operation",
  "wrong-actor",
  "wrong-session",
  "bound-input",
  "bootstrap-input",
  "uncommissioned-kind",
  "frozen-source",
  "late-revoked-member",
  "late-expired-lease",
  "late-Stop",
  "negative-ack",
  "malformed-ack",
  "expiry-after-ack",
  "epoch-after-ack",
  "dispatch-wrong-session",
  "dispatch-wrong-attempt",
] as const)(
  "paused retained Source writer preparation: %s",
  async (scenario) => {
    const f = await substrateFixture("a".repeat(40), "ticket");
    const sources = createSubstrateSources(f.database, f.hub);
    const sourceController = createWorkspaceSourceController(f.database, f.hub, sources);
    const actor = f.actor();
    const effects: string[] = [];
    let connected = false;
    let expectedEpoch = 0;
    let connection: Promise<void> | undefined;
    let connectionFailure: unknown;
    let revoke: (() => Promise<void>) | undefined;
    f.hub.sourceConnected = () => {
      if (connectionFailure) throw connectionFailure;
      return connected;
    };
    f.hub.parentConnected = () => connected;
    f.hub.ready = () => connected;
    f.hub.request = async (attemptID, channel, request, path) => {
      expect(attemptID).toBe(f.attemptID);
      expect(channel).toBe("source");
      expect(path).toBe(`/v1/workspaces/${f.workspaceID}/fence`);
      if (!connected) return new Response(null, { status: 503 });
      expect(await request.json()).toEqual({ writerEpoch: expectedEpoch, writable: false });
      effects.push("source-fence");
      if (scenario === "negative-ack") return Response.json({ confirmed: false });
      if (scenario === "malformed-ack") return Response.json({});
      return Response.json({ confirmed: true });
    };
    try {
      f.config.deployment = "fresh-workspaces";
      const runtime = await f.controller(async (method) => {
        if (method === "GetAtespace") return f.space;
        if (method === "GetActorTemplate") return f.template;
        if (method === "GetActor") return structuredClone(actor);
        if (method === "ResumeActor") {
          effects.push(method);
          actor.metadata.version = "6";
          actor.status.state = "ACTOR_STATE_RESUMING";
          actor.status.workerAssignment = { sandboxRuntime: f.config.runtime };
          const connect = async () => {
            // A cold Parent needs both locks before Resume can finish. A bounded
            // lock timeout turns the startup deadlock into an immediate test error.
            await f.database.client.begin(async (sql) => {
              await sql`SET LOCAL lock_timeout='500ms'`;
              await sql`SELECT 1 FROM factory.change_writer WHERE change_id=${f.changeID} FOR UPDATE`;
              await sql`SELECT pg_advisory_xact_lock(hashtext(${`source:${f.workspaceID}`}))`;
            });
            const restore = await sources.restoreEndpoint(
              new Request(`https://factory.test/internal/substrate-source/${f.attemptID}`, {
                headers: {
                  authorization: `Bearer ${tokens.parent}`,
                  "X-Factory-Runtime-Actor-UID": actor.metadata.uid,
                  "X-Factory-Runtime-Generation": "1",
                  "X-Factory-Source-Protocol": "2",
                },
              }),
              f.attemptID,
            );
            expect(restore.status).toBe(200);
            expect(await restore.json()).toMatchObject({
              retained: true,
              actorUID: actor.metadata.uid,
              writerEpoch: 3,
              changeWriterEpoch: expectedEpoch,
              readOnly: true,
              checkpoint: null,
            });
            effects.push("cold-restore");
            const connector = (actorUID = actor.metadata.uid, generation = "1") =>
              new Request("https://factory.test/internal/runtime-connect", {
                headers: {
                  authorization: `Bearer ${tokens.parent}`,
                  "x-factory-runtime-attempt": f.attemptID,
                  "x-factory-runtime-actor-uid": actorUID,
                  "x-factory-runtime-generation": generation,
                  "x-factory-connector-role": "parent",
                },
              });
            expect(await runtime.authorizeConnector(connector())).toBe(true);
            expect(await runtime.authorizeConnector(connector(crypto.randomUUID()))).toBe(false);
            expect(await runtime.authorizeConnector(connector(actor.metadata.uid, "2"))).toBe(
              false,
            );
            await revoke?.();
            connected = true;
          };
          if (scenario === "delayed-source")
            connection = Bun.sleep(10)
              .then(connect)
              .catch((cause) => {
                connectionFailure = cause;
              });
          else await connect();
          actor.status.state = "ACTOR_STATE_RUNNING";
          return { actor: structuredClone(actor) };
        }
        throw Error(`Uncommissioned retained Actor effect: ${method}`);
      }, sources);
      actor.workerSelector = { matchLabels: f.config.workerSelector ?? {} };
      const tokens = runtimeConnectorTokens("owned-native-secret", f.attemptID, 1);
      await f.database.client.begin(async (sql) => {
        await admitInitialSourceSeedIn(sql, {
          workspaceID: f.workspaceID,
          projectID: f.projectID,
          repositoryURL: "https://example.invalid/fixture.git",
          revision: "a".repeat(40),
          branch: f.branch,
        });
        await sql`INSERT INTO factory.runtime_attempt(id,project_id,workspace_id,change_id,generation,
        revision,state,parent_connector_token_hash,create_intended_at,created_by,
        atespace,actor_name,binding_intent,actor_uid,create_attempted_at,observation)
        VALUES(${f.attemptID},${f.projectID},${f.workspaceID},${f.changeID},1,${"a".repeat(40)},
          'create-intended',${hashConnectorToken(tokens.parent)},now(),${f.userID},
          ${f.atespace},${actor.metadata.name},
          ${JSON.stringify({
            ...f.config,
            actorSelector: f.config.workerSelector,
            sourceRestoreProtocol: 2,
            egressHosts: [],
            environment: { version: 0, secretKey: null },
            declaredApps: ["app"],
          })}::jsonb,
          ${actor.metadata.uid},${actor.metadata.createTime},${JSON.stringify(actor)}::jsonb)`;
        const source = await sources.lease(f.workspaceID, sql);
        if (!source?.seed) throw Error("Owned initial Source seed missing");
        const id = crypto.randomUUID();
        await sql`UPDATE factory.substrate_source SET seed_confirmed_at=now()
        WHERE workspace_id=${f.workspaceID}`;
        await sql`UPDATE factory.substrate_source SET writable=false,writer_epoch=2,checkpoint_id=${id}
        WHERE workspace_id=${f.workspaceID}`;
        await sql`UPDATE factory.substrate_source SET generation=1,checkpoint=${JSON.stringify({
          id,
          workspaceID: f.workspaceID,
          actorUID: null,
          seedID: source.seed.id,
          writerEpoch: 2,
          generation: 1,
          bundle: { version: 1, bytes: 1, sha256: "a".repeat(64), chunks: ["a".repeat(64)] },
        })}::jsonb WHERE workspace_id=${f.workspaceID}`;
        await sql`UPDATE factory.substrate_source SET owner='actor',actor_uid=${actor.metadata.uid},
        writable=true,writer_epoch=3,checkpoint_id=NULL WHERE workspace_id=${f.workspaceID}`;
        const resume = await intendActorRPCIn(sql, f.attemptID, "resume", null, actor);
        await dispatchActorRPCIn(sql, f.attemptID, resume);
        actor.metadata.version = "3";
        actor.status = {
          state: "ACTOR_STATE_RUNNING",
          workerAssignment: { sandboxRuntime: f.config.runtime },
        };
        await sql`UPDATE factory.runtime_attempt SET observation=${JSON.stringify(actor)}::jsonb
        WHERE id=${f.attemptID}`;
        await observeActorRPCIn(sql, f.attemptID, resume, actor);
        const pause = await intendActorRPCIn(sql, f.attemptID, "suspend", null, actor);
        await dispatchActorRPCIn(sql, f.attemptID, pause);
        const uuid = crypto.randomUUID();
        const checkpoint = {
          uuid,
          actorUID: actor.metadata.uid,
          generation: 1,
          owner: "SNAPSHOT_OWNER_ACTOR",
          fidelity:
            scenario === "repair-memory-snapshot"
              ? "SNAPSHOT_FIDELITY_MEMORY"
              : "SNAPSHOT_FIDELITY_ROOTFS",
          actorTemplateUid: f.config.templateUID,
          sandboxRuntime: f.config.runtime,
          durableSnapshot: {
            state: "SNAPSHOT_STORAGE_STATE_COMPLETED",
            object: {
              snapshotUri: `s3://owned/prefix/atespaces/${f.atespace}/actors/${actor.metadata.uid}/snapshots/${uuid}`,
            },
          },
        };
        actor.metadata.version = "5";
        actor.status = {
          state: "ACTOR_STATE_SUSPENDED",
          lastAssignedGeneration: 1,
          snapshots: [checkpoint],
        };
        await sql`UPDATE factory.runtime_attempt SET observation=${JSON.stringify(actor)}::jsonb,
        checkpoint=${JSON.stringify(checkpoint)}::jsonb WHERE id=${f.attemptID}`;
        await observeActorRPCIn(sql, f.attemptID, pause, actor, checkpoint);
        await sql`UPDATE factory.runtime_attempt SET state='paused',ready_at=now() WHERE id=${f.attemptID}`;
        await sql`UPDATE factory.change SET runtime_attempt_id=${f.attemptID} WHERE id=${f.changeID}`;
      });
      const turns = createAgentTurnStore(f.database);
      const [approval] = await f.database.client<{ revision: string }[]>`
      SELECT requirement_revision_id AS revision FROM factory.requirement_approval WHERE ticket_id=${f.ticketID}`;
      if (!approval) throw Error("Owned requirements approval missing");
      const admit = async (kind: "change-start" | "change-repair") => {
        const { turn } = await turns.admit(
          {
            ...(kind === "change-repair" ? { kind, text: "Owned commissioned repair" } : { kind }),
            commandId: crypto.randomUUID(),
            projectId: f.projectID,
            ticketId: f.ticketID,
            changeId: f.changeID,
            createdBy: f.userID,
            conversationId: null,
          },
          {
            mode: "build",
            modelId: "owned-paused-repair",
            skillRevisionIds: [],
            requiredSkillRevisionIds: [],
            conversationVersion: null,
            requirementRevisionId: approval.revision,
          },
          (sql, turn) => claimAgentWriterIn(sql, f.changeID, turn.id, f.userID),
        );
        const owned = await turns.claimPending(turn.id);
        if (!owned?.ownerToken) throw Error("Owned turn lease missing");
        return { ...owned, ownerToken: owned.ownerToken };
      };
      const original = await admit("change-start");
      const sessionID = `ses_owned_${original.id.replaceAll("-", "")}`;
      await f.database
        .client`UPDATE factory.change_writer SET state='agent' WHERE change_id=${f.changeID}`;
      await f.database.client`INSERT INTO factory.change_agent_turn_intent(
      turn_id,change_id,session_id,prompt_id,prompt_text,bootstrap,session_title,runtime_attempt_id)
      VALUES(${original.id},${f.changeID},${sessionID},${`msg_owned_${original.id.replaceAll("-", "")}`},
        'Owned completed Coding',true,'Owned Coding',${f.attemptID})`;
      await f.database.client`INSERT INTO factory.change_agent_session(
      change_id,runtime_attempt_id,opencode_session_id,state,created_by,active_turn_id,native_session_confirmed_at)
      VALUES(${f.changeID},${f.attemptID},${sessionID},'committed',${f.userID},${original.id},now())`;
      expect(await turns.beginDispatch(original.id, original.ownerToken)).not.toBeNull();
      expect(
        await turns.settle(original.id, original.ownerToken, "completed", "Owned submission"),
      ).toBe(true);
      let repair: Awaited<ReturnType<typeof admit>>;
      let reviewSessionID: string | undefined;
      if (scenario === "review" || scenario.startsWith("repair-after-review")) {
        const commit = "d".repeat(40);
        const verificationID = crypto.randomUUID();
        const reviewID = crypto.randomUUID();
        await f.database.client`INSERT INTO factory.change_commit_operation(
        id,change_id,runtime_attempt_id,sequence,branch_name,expected_parent_sha,commit_sha,
        observed_remote_sha,commit_message,idempotency_key,state,created_by,completed_at)
        VALUES(${original.id},${f.changeID},${f.attemptID},1,${f.branch},${"a".repeat(40)},${commit},
          ${commit},'Owned review candidate',${crypto.randomUUID()},'succeeded',${f.userID},now())`;
        await f.database
          .client`INSERT INTO factory.verification(id,change_id,commit_sha,pull_request_number,
        action_run_id,created_by,state,summary,completed_at)
        VALUES(${verificationID},${f.changeID},${commit},1,1,${f.userID},'succeeded','Owned CI',now())`;
        await f.database
          .client`INSERT INTO factory.candidate_review(id,verification_id,change_id,commit_sha,base_sha,created_by)
        VALUES(${reviewID},${verificationID},${f.changeID},${commit},${"a".repeat(40)},${f.userID})`;
        const { turn } = await createReviewAdmission(f.database)(f.changeID, reviewID, f.userID);
        const owned = await turns.claimPending(turn.id);
        if (!owned?.ownerToken) throw Error("Owned review lease missing");
        repair = { ...owned, ownerToken: owned.ownerToken };
        if (scenario.startsWith("repair-after-review")) {
          // Review owns a different latest Session. A repair must return to the
          // retained, confirmed implementation Session, never replay Review.
          const [intent] = await f.database.client<{ sessionID: string }[]>`
            SELECT session_id AS "sessionID" FROM factory.change_agent_turn_intent WHERE turn_id=${turn.id}`;
          if (!intent) throw Error("Owned historical review input missing");
          reviewSessionID = intent.sessionID;
          await f.database
            .client`UPDATE factory.change_writer SET state='agent' WHERE change_id=${f.changeID}`;
          await f.database
            .client`UPDATE factory.change_agent_turn_intent SET runtime_attempt_id=${f.attemptID}
            WHERE turn_id=${turn.id}`;
          await f.database.client`UPDATE factory.change_agent_session SET active_turn_id=${turn.id},
            opencode_session_id=${intent.sessionID},implementation_session_id=${sessionID},
            implementation_session_confirmed_at=native_session_confirmed_at WHERE change_id=${f.changeID}`;
          expect(await turns.beginDispatch(repair.id, repair.ownerToken)).not.toBeNull();
          expect(
            await turns.settle(
              repair.id,
              repair.ownerToken,
              "completed",
              "Owned independent review ended",
            ),
          ).toBe(true);
          await f.database
            .client`UPDATE factory.candidate_review SET state='incomplete',completed_at=now()
            WHERE id=${reviewID}`;
          repair = await admit("change-repair");
        }
      } else
        repair = await admit(scenario === "uncommissioned-kind" ? "change-start" : "change-repair");
      if (scenario !== "review")
        await f.database.client`INSERT INTO factory.change_agent_turn_intent(
      turn_id,change_id,session_id,prompt_id,prompt_text,bootstrap,session_title)
      VALUES(${repair.id},${f.changeID},${
        scenario === "wrong-session"
          ? "ses_wrong"
          : scenario === "repair-after-review-wrong-session"
            ? (reviewSessionID ?? "ses_missing_review")
            : sessionID
      },
        ${`msg_owned_${repair.id.replaceAll("-", "")}`},
        'Owned commissioned repair',${scenario === "bootstrap-input"},'Owned repair')`;
      const expire = () =>
        f.database.client`UPDATE factory.agent_turn
      SET owner_expires_at=clock_timestamp()-interval '1 millisecond' WHERE id=${repair.id}`.then(
          () => {},
        );
      const revokeMember = () =>
        f.database.client`DELETE FROM factory.project_membership
      WHERE project_id=${f.projectID} AND user_id=${f.userID}`.then(() => {});
      const stop = () =>
        createChangeAgentStop(f.database, f.hub)
          .persist(f.changeID)
          .then(() => {});
      if (scenario === "expired-lease") await expire();
      if (scenario === "revoked-member") await revokeMember();
      if (scenario === "Stop") await stop();
      if (scenario === "late-expired-lease") revoke = expire;
      if (scenario === "late-revoked-member") revoke = revokeMember;
      if (scenario === "late-Stop") revoke = stop;
      if (scenario === "stale-requirements")
        await f.database.client`INSERT INTO factory.requirement_revision(
        id,ticket_id,ordinal,canonical_content,content_digest,created_by)
        SELECT ${crypto.randomUUID()},ticket_id,2,canonical_content,content_digest,created_by
        FROM factory.requirement_revision WHERE id=${approval.revision}`;
      if (scenario === "runtime-stop")
        await f.database
          .client`UPDATE factory.runtime_attempt SET state='stopping',stop_intended_at=now()
        WHERE id=${f.attemptID}`;
      if (scenario === "uncertain-turn") {
        expect(await turns.beginDispatch(repair.id, repair.ownerToken)).not.toBeNull();
        expect(
          await turns.settle(repair.id, repair.ownerToken, "uncertain", "Owned lost input reply"),
        ).toBe(true);
      }
      if (scenario === "uncertain-native-operation") actor.status.state = "ACTOR_STATE_SUSPENDING";
      if (scenario === "wrong-actor") actor.metadata.uid = crypto.randomUUID();
      if (scenario === "bound-input")
        await f.database
          .client`UPDATE factory.change_agent_turn_intent SET runtime_attempt_id=${f.attemptID}
        WHERE turn_id=${repair.id}`;
      if (scenario === "frozen-source")
        await f.database.client`UPDATE factory.substrate_source SET writable=false,writer_epoch=4,
        checkpoint_id=${crypto.randomUUID()} WHERE workspace_id=${f.workspaceID}`;
      const writers = createChangeWriterController({
        database: f.database,
        runtime,
        async fenceSource(changeID, epoch, writable, commission) {
          await sourceController.fenceChange(changeID, epoch, writable, commission);
          if (scenario === "expiry-after-ack" && commission?.mode === "initial-bootstrap")
            await commission.sql`UPDATE factory.agent_turn
            SET owner_expires_at=clock_timestamp()-interval '1 millisecond' WHERE id=${repair.id}`;
          if (scenario === "epoch-after-ack" && commission?.mode === "initial-bootstrap")
            await commission.sql`UPDATE factory.change_writer SET epoch=epoch+1
            WHERE change_id=${changeID}`;
        },
        agentUsername: "owned-paused-repair",
        async protect(_changeID, writers) {
          effects.push(writers.length ? "writer-grant" : "branch-fence");
        },
        async stopAgent() {
          throw Error("Completed Coding must not be replayed or stopped");
        },
      });
      const before = await sources.lease(f.workspaceID);
      const [writer] = await f.database.client<{ epoch: number }[]>`
        SELECT epoch::float8 AS epoch FROM factory.change_writer WHERE change_id=${f.changeID}`;
      if (!writer) throw Error("Owned preparing writer missing");
      expectedEpoch = writer.epoch;
      expect(before).toMatchObject({
        owner: "actor",
        writerEpoch: scenario === "frozen-source" ? 4 : 3,
        writable: scenario !== "frozen-source",
      });
      expect(f.hub.sourceConnected(f.attemptID)).toBe(false);
      let prepared = false;
      let failure: unknown;
      try {
        prepared = await writers.prepareAgent(f.changeID, repair.id, repair.ownerToken);
      } catch (cause) {
        failure = cause;
      }
      if (
        ![
          "repair",
          "repair-memory-snapshot",
          "repair-after-review",
          "delayed-source",
          "review",
          "dispatch-wrong-session",
          "dispatch-wrong-attempt",
        ].includes(scenario)
      ) {
        expect(prepared).toBe(false);
        expect(
          failure || !(await turns.validateExecution(repair.id, repair.ownerToken)),
        ).toBeTruthy();
        expect(effects).not.toContain("writer-grant");
        expect(effects.filter((effect) => effect === "ResumeActor")).toHaveLength(
          scenario.startsWith("late-") ||
            ["negative-ack", "malformed-ack", "expiry-after-ack", "epoch-after-ack"].includes(
              scenario,
            )
            ? 1
            : 0,
        );
        expect(await sources.lease(f.workspaceID)).toEqual(before);
        expect((await turns.get(original.id))?.state).toBe("completed");
        return;
      }
      if (failure) throw failure;
      expect(prepared).toBe(true);
      expect(effects).toEqual([
        "ResumeActor",
        "cold-restore",
        "source-fence",
        "branch-fence",
        "writer-grant",
      ]);
      expect(await sources.lease(f.workspaceID)).toEqual(before);
      // The real Agent controller binds this NEW pending intent only after writer
      // preparation. Final Source confirmation still precedes every native input.
      const [input] = await f.database.client<{ sessionID: string }[]>`
      SELECT session_id AS "sessionID" FROM factory.change_agent_turn_intent WHERE turn_id=${repair.id}`;
      if (!input) throw Error("Owned pending input missing");
      await f.database
        .client`UPDATE factory.runtime_attempt SET state='ready' WHERE id=${f.attemptID}`;
      await f.database
        .client`UPDATE factory.change_agent_turn_intent SET runtime_attempt_id=${f.attemptID}
      WHERE turn_id=${repair.id}`;
      await f.database.client`UPDATE factory.change_agent_session SET active_turn_id=${repair.id},
      opencode_session_id=${input.sessionID},state='starting' WHERE change_id=${f.changeID}`;
      const confirmation = writers.confirmSource(
        f.changeID,
        repair.id,
        repair.ownerToken,
        scenario === "dispatch-wrong-attempt" ? crypto.randomUUID() : f.attemptID,
        scenario === "dispatch-wrong-session" ? "ses_wrong" : input.sessionID,
      );
      if (scenario.startsWith("dispatch-wrong-"))
        await expect(confirmation).rejects.toThrow("dispatch identity");
      else {
        await confirmation;
        expect(effects.filter((effect) => effect === "source-fence")).toHaveLength(2);
      }
      expect((await turns.get(repair.id))?.state).toBe("pending");
      expect((await turns.get(original.id))?.state).toBe("completed");
      expect(await sources.lease(f.workspaceID)).toEqual(before);
    } finally {
      await connection;
      await sourceController.close();
      await f.dispose();
    }
  },
  60_000,
);
