import { expect, test } from "bun:test";
import { runtimeIdentity } from "../../packages/runtime-domain/src/identity";
import {
  nativeActor,
  SubstrateRPCError,
} from "../../packages/runtime-kubernetes/src/substrate-control";
import { nativeRuntimeFixture } from "../fixtures/native-runtime";

test("initial Verification continuation keeps exact-job, native identity and revocation fences", async () => {
  const f = await nativeRuntimeFixture("ticket");
  const previousPublic = process.env["FACTORY_FORGEJO_PUBLIC_URL"];
  process.env["FACTORY_FORGEJO_PUBLIC_URL"] = "https://git.native.test";
  const configuration = { ...f.configuration, egressHosts: ["git.native.test"] };
  const runtime = f.controller(configuration);
  let submissionSequence = 0;
  async function submit(sequence: number, commit: string) {
    const id = crypto.randomUUID();
    // Controlled submitted-candidate metadata only, not a live implementation
    // or a claimed external Git outcome.
    await f.database.client`INSERT INTO factory.change_commit_operation(
      id,change_id,sequence,branch_name,expected_parent_sha,commit_sha,observed_remote_sha,
      commit_message,idempotency_key,state,created_by,completed_at,source,
      repository_path,repository_blob_sha,repository_content,content_digest)
      SELECT ${id},id,${sequence},branch_name,base_sha,${commit},${commit},
        'Owned exact candidate',${`owned-capacity:${id}`},'succeeded',created_by,now(),
        'repository-document','README.md',${"a".repeat(40)},'',${"b".repeat(64)}
      FROM factory.change WHERE id=${f.changeID}`;
  }
  try {
    await f.database.client`UPDATE factory.project
      SET repository_url='http://127.0.0.1:1/owned/verification.git' WHERE id=${f.projectID}`;
    for (const fault of [
      "unchanged",
      "unknown-reply",
      "other-hold",
      "lost-after-progress",
      "uid",
      "version",
      "worker",
      "generation",
      "snapshot",
      "source-tag",
      "ready",
      "failed",
      "stop-intent",
      "deleting",
      "cancelled",
      "late-cancel",
      "revoked",
      "newer-commit",
    ] as const) {
      const candidate = (++submissionSequence).toString(16).padStart(40, "0");
      await submit(submissionSequence, candidate);
      const verificationID = crypto.randomUUID();
      const attemptID = runtimeIdentity(verificationID, 1).attemptID;
      const atespace = `fa-${attemptID.replaceAll("-", "")}`;
      await f.database.client`INSERT INTO factory.verification(
        id,change_id,commit_sha,pull_request_number,action_run_id,runner_name,
        runner_uuid,runner_token,runner_job_handle,created_by)
        VALUES(${verificationID},${f.changeID},${candidate},1,1,'owned-capacity-check',
          ${crypto.randomUUID()},'owned-private-runner-token',${`owned-job-${verificationID}`},${f.userID})`;
      let reject = true;
      let cancelLate = false;
      let loseAfterProgress = false;
      f.beforeCall(async (method) => {
        if (method === "ResumeActor" && reject) {
          reject = false;
          if (fault === "unknown-reply") throw new Error("Owned unknown Resume reply");
          throw new SubstrateRPCError("ResourceExhausted", "no worker has room for the actor");
        }
        if (method === "ResumeActor" && loseAfterProgress) {
          loseAfterProgress = false;
          const objects = f.resources.get(atespace);
          if (!objects) throw Error("Owned Verification resources missing");
          const actor = nativeActor.parse(objects.get("Actor"));
          actor.metadata.version = "2";
          actor.status = {
            state: "ACTOR_STATE_RUNNING",
            workerAssignment: { sandboxRuntime: f.config.runtime },
          };
          objects.set("Actor", actor);
          throw new SubstrateRPCError("Unavailable", "Owned lost progressed Resume reply");
        }
        if (method === "GetActorEgressPolicy" && cancelLate) {
          cancelLate = false;
          await f.database.client`UPDATE factory.verification
            SET state='cancelled',completed_at=now() WHERE id=${verificationID}`;
        }
      });
      await expect(runtime.startVerification(verificationID, f.userID)).rejects.toThrow(
        fault === "unknown-reply" ? "Owned unknown Resume reply" : "no worker has room",
      );
      const objects = f.resources.get(atespace);
      if (!objects) throw Error("Owned Verification resources missing");
      const originalActor = nativeActor.parse(objects.get("Actor"));
      const resumes = () =>
        f.calls.filter((call) => call.scope === atespace && call.method === "ResumeActor").length;
      const creates = () =>
        f.calls.filter((call) => call.scope === atespace && call.method === "CreateActor").length;
      const wait = () =>
        f.database
          .client`SELECT reason FROM factory.runtime_compute_wait WHERE attempt_id=${attemptID}`;
      const facts = () =>
        f.database
          .client`SELECT actor_uid::text,native_version,origin_key,origin_checkpoint,stop_id,
          intended_at::text,attempted_at::text,outcome FROM factory.substrate_actor_rpc
          WHERE runtime_attempt_id=${attemptID} AND action='resume'`;
      const originalFacts = await facts();
      expect(resumes(), fault).toBe(1);
      expect(await wait(), fault).toEqual(
        fault === "unknown-reply" ? [] : [{ reason: "compute-capacity" }],
      );
      const actor = structuredClone(originalActor);
      if (fault === "uid") actor.metadata.uid = crypto.randomUUID();
      if (fault === "version") actor.metadata.version = "2";
      if (fault === "worker") actor.status.workerAssignment = { sandboxRuntime: f.config.runtime };
      if (fault === "generation") actor.status.lastAssignedGeneration = 1;
      if (fault === "snapshot") actor.status.snapshots = [{ uuid: crypto.randomUUID() }];
      if (fault === "source-tag") actor.sourceTag = { name: "foreign-initial-image" };
      objects.set("Actor", actor);
      if (fault === "ready")
        await f.database.client`UPDATE factory.runtime_attempt
          SET state='ready',ready_at=now() WHERE id=${attemptID}`;
      if (fault === "failed")
        await f.database
          .client`UPDATE factory.runtime_attempt SET state='failed' WHERE id=${attemptID}`;
      if (fault === "stop-intent")
        await f.database
          .client`UPDATE factory.runtime_attempt SET stop_intended_at=now() WHERE id=${attemptID}`;
      if (fault === "deleting")
        await f.database.client`UPDATE factory.substrate_binding SET delete_intended_at=now()
          WHERE runtime_attempt_id=${attemptID}`;
      if (fault === "cancelled")
        await f.database.client`UPDATE factory.verification SET state='cancelled',completed_at=now()
          WHERE id=${verificationID}`;
      if (fault === "late-cancel") cancelLate = true;
      if (fault === "revoked")
        await f.database.client`DELETE FROM factory.project_membership
          WHERE project_id=${f.projectID} AND user_id=${f.userID}`;
      if (fault === "newer-commit") await submit(++submissionSequence, "e".repeat(40));
      if (fault === "other-hold")
        await f.database
          .client`UPDATE factory.runtime_compute_wait SET reason='accounting-incomplete'
          WHERE attempt_id=${attemptID}`;
      if (fault === "lost-after-progress") {
        loseAfterProgress = true;
        await expect(runtime.startVerification(verificationID, f.userID)).rejects.toThrow(
          "Owned lost progressed Resume reply",
        );
        expect(await wait()).toEqual([{ reason: "compute-capacity" }]);
        expect((await runtime.get(attemptID))?.native?.state).toBe("ACTOR_STATE_RUNNING");
        expect(await wait()).toEqual([]);
        expect(resumes()).toBe(2);
      } else if (["unchanged", "unknown-reply", "other-hold"].includes(fault)) {
        expect((await runtime.startVerification(verificationID, f.userID))?.id).toBe(attemptID);
        expect(resumes(), fault).toBe(2);
        expect(await wait(), fault).toEqual(
          fault === "other-hold" ? [{ reason: "accounting-incomplete" }] : [],
        );
      } else {
        await expect(runtime.startVerification(verificationID, f.userID)).rejects.toThrow();
        expect(resumes(), fault).toBe(1);
        expect(await facts(), fault).toEqual(originalFacts);
      }
      expect(creates(), fault).toBe(1);
      expect(await f.database.client`SELECT * FROM factory.substrate_source`, fault).toEqual([]);
      if (fault === "revoked")
        await f.database
          .client`INSERT INTO factory.project_membership(project_id,user_id,role,updated_by)
          VALUES(${f.projectID},${f.userID},'developer',${f.userID})`;
      await f.database.client`UPDATE factory.verification SET state='cancelled',completed_at=now()
        WHERE id=${verificationID} AND state IN ('pending','runner-starting')`;
      console.info(`Controlled native Verification capacity fence: ${fault}`);
    }
  } finally {
    await f.dispose();
    if (previousPublic === undefined) delete process.env["FACTORY_FORGEJO_PUBLIC_URL"];
    else process.env["FACTORY_FORGEJO_PUBLIC_URL"] = previousPublic;
  }
}, 600_000);
