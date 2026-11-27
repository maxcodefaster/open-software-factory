import { expect, test } from "bun:test";
import { type NativeActor, SubstrateRPCError } from "#runtime-kubernetes/substrate-control";
import { substrateFixture } from "../fixtures/substrate";

test.each([
  "resume-before-visible",
  "resume-cancelled-resuming",
  "resume-running",
  "suspend-before-visible",
  "suspend-completed",
  "suspend-finalizing",
  "running-resume",
  "fresh-cycle",
] as const)(
  "native lifecycle facts preserve their original identity after %s",
  async (scenario) => {
    const f = await substrateFixture();
    let actor: NativeActor | undefined;
    let creates = 0,
      resumes = 0,
      suspends = 0;
    let loseResume = scenario.startsWith("resume-");
    let loseSuspend = scenario.startsWith("suspend-");
    const running = () => {
      if (!actor) throw Error("Owned Actor missing");
      actor.metadata.version = String(BigInt(actor.metadata.version) + 1n);
      actor.status = {
        ...actor.status,
        state: "ACTOR_STATE_RUNNING",
        workerAssignment: { sandboxRuntime: f.config.runtime },
      };
    };
    const suspended = (state = "ACTOR_STATE_SUSPENDED") => {
      if (!actor) throw Error("Owned Actor missing");
      const uuid = crypto.randomUUID(),
        generation = (actor.status.lastAssignedGeneration ?? 0) + 1;
      actor.metadata.version = String(BigInt(actor.metadata.version) + 1n);
      actor.status = {
        state,
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
                snapshotUri: `s3://owned/prefix/atespaces/${f.atespace}/actors/${actor.metadata.uid}/snapshots/${uuid}`,
              },
            },
          },
        ],
      };
    };
    const requireDispatch = async (action: "resume" | "suspend") => {
      const [dispatch] = await f.database.client`
        SELECT rpc.payload->>'actorUid' AS uid,(rpc.payload->>'attemptedAt') IS NOT NULL AS attempted,
          rpc.result AS outcome,attempt.state::text AS state
        FROM factory.operation rpc
        JOIN factory.runtime_attempt attempt ON attempt.id::text=rpc.scope_id
        WHERE rpc.kind='runtime.actor_rpc' AND rpc.scope_type='runtime_attempt'
          AND rpc.scope_id=${f.attemptID} AND rpc.payload->>'action'=${action}
          AND rpc.payload->>'originKey'=COALESCE(attempt.checkpoint->>'uuid','initial')`;
      expect(dispatch).toEqual({
        uid: actor?.metadata.uid,
        attempted: true,
        outcome: null,
        state: action === "resume" ? "starting" : "pausing",
      });
    };
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
      if (method === "ResumeActor") {
        await requireDispatch("resume");
        resumes++;
        if (loseResume && scenario === "resume-before-visible") {
          loseResume = false;
          throw Error("Owned lost Resume reply");
        }
        if (loseResume && scenario === "resume-cancelled-resuming") {
          loseResume = false;
          if (!actor) throw Error("Owned Actor missing");
          actor.metadata.version = String(BigInt(actor.metadata.version) + 1n);
          actor.status = {
            ...actor.status,
            state: "ACTOR_STATE_RESUMING",
            workerAssignment: { sandboxRuntime: f.config.runtime },
          };
          throw new SubstrateRPCError("Canceled", "Owned lost Resume after native cancellation");
        }
        running();
        if (loseResume) {
          loseResume = false;
          throw Error("Owned lost Resume reply");
        }
        return { actor: structuredClone(actor) };
      }
      if (method === "SuspendActor") {
        await requireDispatch("suspend");
        suspends++;
        if (actor?.status.state === "ACTOR_STATE_SUSPENDING") {
          // Official v1 continues the persisted capture; it does not mint a
          // second snapshot when re-entering this native workflow.
          actor.status.state = "ACTOR_STATE_SUSPENDED";
          actor.metadata.version = String(BigInt(actor.metadata.version) + 1n);
          return { actor: structuredClone(actor) };
        }
        if (loseSuspend && scenario === "suspend-before-visible") {
          loseSuspend = false;
          throw Error("Owned lost Suspend reply");
        }
        suspended(
          scenario === "suspend-finalizing" && loseSuspend
            ? "ACTOR_STATE_SUSPENDING"
            : "ACTOR_STATE_SUSPENDED",
        );
        if (loseSuspend) {
          loseSuspend = false;
          throw Error("Owned lost Suspend reply");
        }
        return { actor: structuredClone(actor) };
      }
      throw Error(`Uncommissioned owned native RPC ${method}`);
    });
    try {
      if (scenario.startsWith("resume-")) {
        await expect(runtime.start(f.projectID, f.userID)).rejects.toThrow("Owned lost Resume");
        if (scenario === "resume-cancelled-resuming") {
          // A cancelled native RPC can leave its original Actor assigned and
          // RESUMING. Continue that same official workflow, preserving the
          // first dispatch fact; this is not another Actor or Resume origin.
          expect((await runtime.start(f.projectID, f.userID))?.native?.state).toBe(
            "ACTOR_STATE_RUNNING",
          );
          await runtime.resumeForApp(f.attemptID, f.userID);
          expect(f.hub.ready(f.attemptID)).toBe(false);
          expect({ creates, resumes, suspends }).toEqual({ creates: 1, resumes: 2, suspends: 0 });
        }
        if (scenario === "resume-before-visible") {
          await expect(runtime.start(f.projectID, f.userID)).rejects.toThrow("not repeated");
          await expect(runtime.resumeForApp(f.attemptID, f.userID)).rejects.toThrow("not repeated");
          expect(resumes).toBe(1);
          running();
        }
        await runtime.start(f.projectID, f.userID);
        await runtime.resumeForApp(f.attemptID, f.userID);
        expect(resumes).toBe(scenario === "resume-cancelled-resuming" ? 2 : 1);
      } else {
        await runtime.start(f.projectID, f.userID);
        if (scenario === "running-resume") {
          await f.database.client`UPDATE factory.runtime_attempt SET state='ready',ready_at=now()
            WHERE id=${f.attemptID}`;
          await runtime.resumeForApp(f.attemptID, f.userID);
          await runtime.resumeForApp(f.attemptID, f.userID);
          expect(resumes).toBe(1);
          expect((await runtime.get(f.attemptID))?.state).toBe("ready");
        } else if (scenario === "fresh-cycle") {
          await runtime.pause(f.attemptID);
          await runtime.resumeForApp(f.attemptID, f.userID);
          await runtime.pause(f.attemptID);
          await runtime.resumeForApp(f.attemptID, f.userID);
          expect({ resumes, suspends }).toEqual({ resumes: 3, suspends: 2 });
        } else {
          await expect(runtime.pause(f.attemptID)).rejects.toThrow("Owned lost Suspend");
          if (scenario === "suspend-finalizing") {
            const snapshots = structuredClone(actor?.status.snapshots);
            await expect(runtime.resumeForApp(f.attemptID, f.userID)).rejects.toThrow(
              "not repeated",
            );
            await expect(runtime.start(f.projectID, f.userID)).rejects.toThrow("not repeated");
            expect(resumes).toBe(1);
            expect((await runtime.pause(f.attemptID))?.state).toBe("paused");
            expect(actor?.status.snapshots).toEqual(snapshots);
          } else if (scenario !== "suspend-completed") {
            await expect(runtime.pause(f.attemptID)).rejects.toThrow("not repeated");
            expect(suspends).toBe(1);
            await expect(runtime.resumeForApp(f.attemptID, f.userID)).rejects.toThrow(
              "not repeated",
            );
            await expect(runtime.start(f.projectID, f.userID)).rejects.toThrow("not repeated");
            expect(resumes).toBe(1);
            suspended();
          }
          expect((await runtime.pause(f.attemptID))?.state).toBe("paused");
          expect(suspends).toBe(scenario === "suspend-finalizing" ? 2 : 1);
          await runtime.resumeForApp(f.attemptID, f.userID);
          expect(resumes).toBe(2);
        }
      }
      expect(creates).toBe(1);
      expect(
        await f.database.client`SELECT id FROM factory.runtime_attempt
      WHERE id=${f.attemptID} AND atespace IS NOT NULL AND deleted_at IS NULL`,
      ).toHaveLength(1);
      const facts = await f.database.client<
        { action: string; attempted: boolean; state: string; origin: string; uid: string }[]
      >`SELECT payload->>'action' AS action,(payload->>'attemptedAt') IS NOT NULL AS attempted,
          result->>'state' AS state,payload->>'originKey' AS origin,payload->>'actorUid' AS uid
        FROM factory.operation
        WHERE kind='runtime.actor_rpc' AND scope_type='runtime_attempt' AND scope_id=${f.attemptID}`;
      expect(facts.filter((fact) => fact.action === "resume")).toHaveLength(
        resumes - (scenario === "resume-cancelled-resuming" ? 1 : 0),
      );
      expect(facts.filter((fact) => fact.action === "suspend")).toHaveLength(
        suspends - (scenario === "suspend-finalizing" ? 1 : 0),
      );
      expect(
        facts.every(
          (fact) =>
            fact.attempted &&
            fact.uid === actor?.metadata.uid &&
            fact.state ===
              (fact.action === "resume" ? "ACTOR_STATE_RUNNING" : "ACTOR_STATE_SUSPENDED"),
        ),
      ).toBe(true);
      if (scenario === "fresh-cycle") {
        expect(new Set(facts.map((fact) => fact.origin)).size).toBe(3);
      }
    } finally {
      await f.dispose();
    }
  },
  60_000,
);
