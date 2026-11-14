import { expect, test } from "bun:test";
import {
  type NativeActor,
  SubstrateRPCError,
} from "../../packages/runtime-kubernetes/src/substrate-control";
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
  "native lifecycle dispatch is not replayed after %s",
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
        SELECT rpc.actor_uid::text AS uid,rpc.attempted_at IS NOT NULL AS attempted,rpc.outcome,
          attempt.state::text AS state
        FROM factory.substrate_actor_rpc rpc
        JOIN factory.substrate_binding binding USING(runtime_attempt_id)
        JOIN factory.runtime_attempt attempt ON attempt.id=rpc.runtime_attempt_id
        WHERE rpc.runtime_attempt_id=${f.attemptID} AND rpc.action=${action}
          AND rpc.origin_key=COALESCE(binding.checkpoint->>'uuid','initial')`;
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
        actor = f.actor();
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
          // RESUMING. That is neither readiness nor permission to replay it.
          expect((await runtime.start(f.projectID, f.userID))?.native?.state).toBe(
            "ACTOR_STATE_RESUMING",
          );
          await runtime.resumeForApp(f.attemptID, f.userID);
          await requireDispatch("resume");
          expect(f.hub.ready(f.attemptID)).toBe(false);
          expect({ creates, resumes, suspends }).toEqual({ creates: 1, resumes: 1, suspends: 0 });
          running();
        }
        if (scenario === "resume-before-visible") {
          await expect(
            Promise.resolve(f.database
              .client`UPDATE factory.substrate_actor_rpc SET attempted_at=NULL
              WHERE runtime_attempt_id=${f.attemptID}`),
          ).rejects.toThrow("immutable");
          await expect(runtime.start(f.projectID, f.userID)).rejects.toThrow("not repeated");
          await expect(runtime.resumeForApp(f.attemptID, f.userID)).rejects.toThrow("not repeated");
          expect(resumes).toBe(1);
          running();
        }
        await runtime.start(f.projectID, f.userID);
        await runtime.resumeForApp(f.attemptID, f.userID);
        expect(resumes).toBe(1);
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
          if (scenario !== "suspend-completed") {
            await expect(runtime.pause(f.attemptID)).rejects.toThrow("not repeated");
            expect(suspends).toBe(1);
            await expect(runtime.resumeForApp(f.attemptID, f.userID)).rejects.toThrow(
              "not repeated",
            );
            await expect(runtime.start(f.projectID, f.userID)).rejects.toThrow("not repeated");
            expect(resumes).toBe(1);
            if (scenario === "suspend-finalizing") {
              if (!actor) throw Error("Owned finalizing Actor missing");
              actor.status.state = "ACTOR_STATE_SUSPENDED";
              actor.metadata.version = String(BigInt(actor.metadata.version) + 1n);
            } else suspended();
          }
          expect((await runtime.pause(f.attemptID))?.state).toBe("paused");
          expect(suspends).toBe(1);
          await runtime.resumeForApp(f.attemptID, f.userID);
          expect(resumes).toBe(2);
        }
      }
      expect(creates).toBe(1);
      expect(
        await f.database.client`SELECT runtime_attempt_id FROM factory.substrate_binding
      WHERE runtime_attempt_id=${f.attemptID} AND deleted_at IS NULL`,
      ).toHaveLength(1);
      const facts = await f.database.client<
        { action: string; attempted: boolean; state: string; origin: string; uid: string }[]
      >`SELECT action,attempted_at IS NOT NULL AS attempted,outcome->>'state' AS state,
          origin_key AS origin,actor_uid::text AS uid
        FROM factory.substrate_actor_rpc WHERE runtime_attempt_id=${f.attemptID}`;
      expect(facts.filter((fact) => fact.action === "resume")).toHaveLength(resumes);
      expect(facts.filter((fact) => fact.action === "suspend")).toHaveLength(suspends);
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
        await expect(
          Promise.resolve(f.database.client`DELETE FROM factory.substrate_actor_rpc
          WHERE runtime_attempt_id=${f.attemptID}`),
        ).rejects.toThrow("cannot be discarded");
        await expect(
          Promise.resolve(f.database.client`UPDATE factory.substrate_actor_rpc SET attempted_at=NULL
          WHERE runtime_attempt_id=${f.attemptID}`),
        ).rejects.toThrow("immutable");
        await expect(
          Promise.resolve(f.database
            .client`UPDATE factory.substrate_actor_rpc SET outcome=NULL,outcome_recorded_at=NULL
          WHERE runtime_attempt_id=${f.attemptID}`),
        ).rejects.toThrow("immutable");
        await expect(
          Promise.resolve(f.database
            .client`UPDATE factory.substrate_actor_rpc SET actor_uid=${crypto.randomUUID()}
          WHERE runtime_attempt_id=${f.attemptID}`),
        ).rejects.toThrow("immutable");
      }
    } finally {
      await f.dispose();
    }
  },
  60_000,
);
