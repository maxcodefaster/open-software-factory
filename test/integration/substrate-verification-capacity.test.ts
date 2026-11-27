import { expect, test } from "bun:test";
import { runtimeIdentity } from "#runtime-domain/identity";
import { nativeActor, SubstrateRPCError } from "#runtime-kubernetes/substrate-control";
import { nativeProjectTemplate } from "../fixtures/native-project";
import { nativeRuntimeFixture } from "../fixtures/native-runtime";

test("initial Verification continuation keeps exact-job, native identity and revocation fences", async () => {
  const f = await nativeRuntimeFixture("ticket");
  const previousAPI = process.env["FACTORY_FORGEJO_API_URL"];
  const previousPublic = process.env["FACTORY_FORGEJO_PUBLIC_URL"];
  const previousOwner = process.env["FACTORY_FORGEJO_OWNER"];
  process.env["FACTORY_FORGEJO_PUBLIC_URL"] = "https://git.native.test";
  process.env["FACTORY_FORGEJO_OWNER"] = "owned";
  const configuration = { ...f.configuration, egressHosts: ["git.native.test"] };
  const submitted = new Set<string>();
  let forge: ReturnType<typeof Bun.serve> | undefined;
  let submissionSequence = 0;
  async function submit(sequence: number, commit: string) {
    const id = crypto.randomUUID();
    // Controlled submitted-candidate metadata only, not a live implementation
    // or a claimed external Git outcome.
    await f.database.client`INSERT INTO factory.change_commit_operation(
      id,change_id,runtime_attempt_id,sequence,branch_name,expected_parent_sha,commit_sha,observed_remote_sha,
      commit_message,idempotency_key,state,created_by,completed_at,source)
      SELECT ${id},id,${f.attemptID},${sequence},branch_name,base_sha,${commit},${commit},
        'Owned exact candidate',${`owned-capacity:${id}`},'succeeded',created_by,now(),'agent'
      FROM factory.change WHERE id=${f.changeID}`;
    submitted.add(commit);
  }
  try {
    const files = new Map<string, { content: string; sha: string }>();
    for (const path of [".factory/system.json", nativeProjectTemplate.path])
      files.set(path, {
        content: await Bun.file(`${f.repository}/${path}`).text(),
        sha: (
          await Bun.$`git -C ${f.repository} rev-parse ${`${f.revision}:${path}`}`.text()
        ).trim(),
      });
    // Controlled exact-candidate contents only. This test exercises native
    // capacity/identity fences, not a live Forge or Git submission.
    forge = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
        const url = new URL(request.url);
        const prefix = "/api/v1/repos/owned/verification/contents/";
        if (
          request.method !== "GET" ||
          !url.pathname.startsWith(prefix) ||
          !submitted.has(url.searchParams.get("ref") ?? "")
        )
          return new Response(null, { status: 403 });
        const file = files.get(url.pathname.slice(prefix.length));
        if (!file) return new Response(null, { status: 404 });
        return Response.json({
          content: Buffer.from(file.content).toString("base64"),
          encoding: "base64",
          sha: file.sha,
        });
      },
    });
    process.env["FACTORY_FORGEJO_API_URL"] = `${forge.url.origin}/api/v1/`;
    const runtime = f.controller(configuration);
    await f.database.client`UPDATE factory.project
      SET repository_url=${`${forge.url.origin}/owned/verification.git`} WHERE id=${f.projectID}`;
    await f.database.client.begin(async (sql) => {
      await sql`INSERT INTO factory.runtime_attempt(
        id,project_id,change_id,workspace_id,generation,revision,state,
        parent_connector_token_hash,create_intended_at,created_by,
        atespace,actor_name,binding_intent)
        VALUES(${f.attemptID},${f.projectID},${f.changeID},${f.workspaceID},1,${f.revision},
          'create-intended',${"b".repeat(64)},now(),${f.userID},
          ${`fa-${f.attemptID.replaceAll("-", "")}`},${`runtime-${f.attemptID.replaceAll("-", "")}`},'{}')`;
      await sql`UPDATE factory.runtime_attempt SET state='stopped',stop_intended_at=now()
        WHERE id=${f.attemptID}`;
    });
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
        id,change_id,commit_sha,pull_request_number,action_run_id,
        runner_uuid,runner_token,runner_job_handle,created_by)
        VALUES(${verificationID},${f.changeID},${candidate},1,1,
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
      const wait = async () => [
        ...(await f.database.client<{ reason: string }[]>`
          SELECT payload->>'reason' AS reason FROM factory.operation
          WHERE kind='runtime.compute_wait' AND scope_type='runtime_attempt'
            AND scope_id=${attemptID}`),
      ];
      const facts = () =>
        f.database.client`
          SELECT payload->>'actorUid' AS actor_uid,
            payload->>'nativeVersion' AS native_version,
            payload->>'originKey' AS origin_key,
            NULLIF(payload->'originCheckpoint','null'::jsonb) AS origin_checkpoint,
            payload->>'stopId' AS stop_id,
            created_at::text AS intended_at,
            payload->>'attemptedAt' AS attempted_at,
            result AS outcome
          FROM factory.operation
          WHERE kind='runtime.actor_rpc' AND scope_type='runtime_attempt'
            AND scope_id=${attemptID} AND payload->>'action'='resume'`;
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
          .client`UPDATE factory.runtime_attempt SET state='stopping',stop_intended_at=now() WHERE id=${attemptID}`;
      if (fault === "deleting")
        await f.database.client`UPDATE factory.runtime_attempt SET delete_intended_at=now()
          WHERE id=${attemptID}`;
      if (fault === "cancelled")
        await f.database.client`UPDATE factory.verification SET state='cancelled',completed_at=now()
          WHERE id=${verificationID}`;
      if (fault === "late-cancel") cancelLate = true;
      if (fault === "revoked")
        await f.database.client`DELETE FROM factory.project_membership
          WHERE project_id=${f.projectID} AND user_id=${f.userID}`;
      if (fault === "newer-commit") await submit(++submissionSequence, "e".repeat(40));
      if (fault === "other-hold")
        await f.database.client`UPDATE factory.operation
          SET payload=jsonb_build_object('reason','accounting-incomplete'),updated_at=now()
          WHERE kind='runtime.compute_wait' AND scope_type='runtime_attempt'
            AND scope_id=${attemptID}`;
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
      expect([...(await f.database.client`SELECT * FROM factory.substrate_source`)], fault).toEqual(
        [],
      );
      if (fault === "revoked")
        await f.database
          .client`INSERT INTO factory.project_membership(project_id,user_id,role,updated_by)
          VALUES(${f.projectID},${f.userID},'developer',${f.userID})`;
      await f.database.client`UPDATE factory.verification SET state='cancelled',completed_at=now()
        WHERE id=${verificationID} AND state IN ('pending','runner-starting')`;
      console.info(`Controlled native Verification capacity fence: ${fault}`);
    }
  } finally {
    if (previousAPI === undefined) delete process.env["FACTORY_FORGEJO_API_URL"];
    else process.env["FACTORY_FORGEJO_API_URL"] = previousAPI;
    if (previousOwner === undefined) delete process.env["FACTORY_FORGEJO_OWNER"];
    else process.env["FACTORY_FORGEJO_OWNER"] = previousOwner;
    await f.dispose();
    await forge?.stop(true);
    if (previousPublic === undefined) delete process.env["FACTORY_FORGEJO_PUBLIC_URL"];
    else process.env["FACTORY_FORGEJO_PUBLIC_URL"] = previousPublic;
  }
}, 600_000);
