import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRuntimeController } from "../../apps/factory/src/runtime/controller";
import {
  substrateVerificationPrincipalIn,
  substrateVerificationSourceIn,
} from "../../apps/factory/src/runtime/substrate-verification-grant";
import type { SubstrateInstallationConfiguration } from "../../apps/factory/src/runtime/substrate-workspaces";
import { runtimeIdentity } from "../../packages/runtime-domain/src/identity";
import {
  nativeActor,
  type SubstrateCall,
  SubstrateRPCError,
} from "../../packages/runtime-kubernetes/src/substrate-control";
import { substrateFixture } from "../fixtures/substrate";

test("native Verification continues initial capacity rejection on its exact-job Actor, never canonical Source or legacy capacity", async () => {
  const f = await substrateFixture("a".repeat(40), "ticket");
  const directory = await mkdtemp(join(tmpdir(), "native-verification-"));
  const ca = join(directory, "ca.pem");
  await writeFile(ca, "-----BEGIN CERTIFICATE-----\nowned-test\n-----END CERTIFICATE-----\n");
  const registryCA =
    "-----BEGIN CERTIFICATE-----\nowned-extra-registry-ca\n-----END CERTIFICATE-----\n";
  const registryCAFile = join(directory, "registry-ca.pem");
  await writeFile(registryCAFile, registryCA);
  const previous = {
    api: process.env["FACTORY_FORGEJO_API_URL"],
    public: process.env["FACTORY_FORGEJO_PUBLIC_URL"],
    owner: process.env["FACTORY_FORGEJO_OWNER"],
    registryCA: process.env["FACTORY_REGISTRY_CA_FILE"],
  };
  process.env["FACTORY_REGISTRY_CA_FILE"] = registryCAFile;
  process.env["FACTORY_FORGEJO_API_URL"] = "http://forgejo.cluster.svc:3000/api/v1/";
  process.env["FACTORY_FORGEJO_PUBLIC_URL"] = "https://git.native.test";
  process.env["FACTORY_FORGEJO_OWNER"] = "owned";
  let verificationID = crypto.randomUUID();
  const attemptID = runtimeIdentity(verificationID, 1).attemptID;
  const configuration: SubstrateInstallationConfiguration = {
    deployment: "owned-test",
    database: f.config.database,
    connection: f.config.connection,
    provisioner: { ...f.config.connection, tokenFile: "/owner-token" },
    editorPrincipal: "user:system:serviceaccount:owned:factory-control",
    connectorURL: f.config.connectorURL,
    factoryCAFile: ca,
    workloadImage: `registry.test/native@sha256:${"a".repeat(64)}`,
    resources: { cpuMilli: 2000, memoryMiB: 4096 },
    profile: f.config.profile,
    runtime: f.config.runtime,
    workerSelector: {
      "factory.runtime/profile": f.config.profile,
      "factory.dev/deployment": "owned",
    },
    egressHosts: ["git.native.test"],
  };
  const objects = new Map<string, Record<string, unknown>>();
  const spaces = new Map([[`fa-${attemptID.replaceAll("-", "")}`, objects]]);
  let provisioningAttemptID = attemptID;
  const creates = new Map<string, number>();
  let lose = "CreateAtespace";
  let rejectInitialResume = true;
  let resumeCalls = 0;
  let resumes = 0;
  let deletes = 0;
  const call: SubstrateCall = async (method, input) => {
    const request = input as Record<string, Record<string, unknown>>;
    const kind = method.replace(/^(Get|Create)/, "");
    const name =
      request["atespace"]?.["name"] ??
      (request["atespace"]?.["metadata"] as { name?: string } | undefined)?.name ??
      request["actorTemplate"]?.["atespace"] ??
      (request["actorTemplate"]?.["metadata"] as { atespace?: string } | undefined)?.atespace ??
      request["actor"]?.["atespace"] ??
      (request["actor"]?.["metadata"] as { atespace?: string } | undefined)?.atespace;
    if (typeof name !== "string") throw new Error("Owned native namespace is missing");
    // Verification may never suspend, resume, inspect or delete Coding's Actor.
    expect(name).not.toBe(f.atespace);
    let activeObjects = spaces.get(name);
    if (!activeObjects) {
      activeObjects = new Map();
      spaces.set(name, activeObjects);
    }
    if (method.startsWith("Get")) {
      const value = activeObjects.get(kind);
      if (!value) throw new SubstrateRPCError("NotFound", "absent");
      return structuredClone(value);
    }
    if (method.startsWith("Create")) {
      creates.set(kind, (creates.get(kind) ?? 0) + 1);
      const [saved] = await f.database
        .client`SELECT atespace_attempted_at,policy_attempted_at,template_attempted_at FROM factory.substrate_verification WHERE verification_id=${verificationID} AND runtime_attempt_id=${provisioningAttemptID}`;
      if (["Atespace", "AtespaceAccessPolicy", "ActorTemplate"].includes(kind))
        expect(
          saved?.[
            kind === "Atespace"
              ? "atespace_attempted_at"
              : kind === "AtespaceAccessPolicy"
                ? "policy_attempted_at"
                : "template_attempted_at"
          ],
        ).not.toBeNull();
      else if (kind === "Actor") {
        const [binding] = await f.database
          .client`SELECT binding.create_attempted_at,attempt.workspace_id,attempt.change_id,
            attempt.verification_id,attempt.isolated_kind,verification.runtime_attempt_id,
            verification.state,attempt.revision=verification.commit_sha AS exact_commit
          FROM factory.substrate_binding binding
          JOIN factory.runtime_attempt attempt ON attempt.id=binding.runtime_attempt_id
          JOIN factory.verification verification ON verification.id=attempt.verification_id
          WHERE binding.runtime_attempt_id=${provisioningAttemptID}`;
        expect(binding?.["create_attempted_at"]).not.toBeNull();
        expect(binding).toMatchObject({
          workspace_id: null,
          change_id: null,
          verification_id: verificationID,
          isolated_kind: "verification",
          runtime_attempt_id: provisioningAttemptID,
          state: "runner-starting",
          exact_commit: true,
        });
      }
      const spec =
        kind === "AtespaceAccessPolicy"
          ? request["accessPolicy"]
          : kind === "ActorEgressPolicy"
            ? request["egressPolicy"]
            : request[`${kind[0]?.toLowerCase()}${kind.slice(1)}`];
      if (!spec) throw new Error(`Missing owned ${kind} declaration`);
      const [clock] = await f.database.client<{ at: string }[]>`
        SELECT clock_timestamp()::text AS at`;
      if (!clock) throw new Error("Owned native creation clock is unavailable");
      const value = {
        ...spec,
        metadata: {
          ...(spec["metadata"] as object),
          uid: crypto.randomUUID(),
          version: "1",
          createTime: new Date(clock.at).toISOString(),
        },
      };
      if (kind === "Actor") Object.assign(value, { status: { state: "ACTOR_STATE_SUSPENDED" } });
      activeObjects.set(kind, value);
      if (method === lose) {
        lose = "";
        throw new SubstrateRPCError("Unavailable", "owned lost native reply");
      }
      return structuredClone(value);
    }
    if (method === "ResumeActor") {
      resumeCalls++;
      if (rejectInitialResume) {
        rejectInitialResume = false;
        throw new SubstrateRPCError("ResourceExhausted", "no worker has room for the actor");
      }
      resumes++;
      const actor = nativeActor.parse(activeObjects.get("Actor"));
      actor.metadata.version = "2";
      actor.status = {
        state: "ACTOR_STATE_RUNNING",
        workerAssignment: { sandboxRuntime: f.config.runtime },
      };
      activeObjects.set("Actor", actor);
      return { actor };
    }
    if (method === "DeleteActor") {
      const actor = nativeActor.parse(activeObjects.get("Actor"));
      expect(request["options"]).toMatchObject({
        uid: actor.metadata.uid,
        version: actor.metadata.version,
      });
      deletes++;
      activeObjects.delete("Actor");
      return {};
    }
    throw new Error(`Unexpected owned native method ${method}`);
  };
  const owner: SubstrateCall = async (method, request) => {
    expect(method).toMatch(/^(Get|Create)Atespace(?:AccessPolicy)?$/);
    return call(method, request);
  };
  const editor: SubstrateCall = async (method, request) => {
    expect(method).not.toMatch(/^CreateAtespace/);
    return call(method, request);
  };
  const controller = (
    selected: SubstrateInstallationConfiguration,
    provisioner: SubstrateCall = owner,
  ) =>
    createRuntimeController(f.database, f.hub, "owned-native-secret", {
      configuration: selected,
      call: editor,
      provisionerCall: provisioner,
    });
  let runtime = controller(configuration);
  try {
    await f.database.client`UPDATE factory.change_writer
      SET state='human',user_id=${f.userID},epoch=epoch+1 WHERE change_id=${f.changeID}`;
    let codingActor: ReturnType<typeof f.actor> | undefined;
    await f
      .execution(async (method) => {
        if (method === "GetAtespace") return f.space;
        if (method === "GetActorTemplate") return f.template;
        if (method === "GetActorEgressPolicy")
          return {
            metadata: { ...f.space.metadata, name: "default", atespace: f.atespace },
            rules: [{ tlsPassthrough: { hostnames: ["factory.test"], ports: { numbers: [443] } } }],
          };
        if (method === "GetActor") {
          if (!codingActor) throw new SubstrateRPCError("NotFound", "Owned Coding Actor absent");
          return structuredClone(codingActor);
        }
        if (method === "CreateActor") {
          codingActor = f.actor();
          return structuredClone(codingActor);
        }
        if (method === "ResumeActor" && codingActor) {
          codingActor.metadata.version = "2";
          codingActor.status = {
            state: "ACTOR_STATE_RUNNING",
            workerAssignment: { sandboxRuntime: f.config.runtime },
          };
          return { actor: structuredClone(codingActor) };
        }
        throw Error(`Verification touched retained Coding through ${method}`);
      })
      .start(f.userID);
    if (!codingActor) throw Error("Owned Coding Actor missing");
    const codingUID = codingActor.metadata.uid;
    await f.database.client.begin(async (sql) => {
      await sql`UPDATE factory.runtime_attempt SET state='ready' WHERE id=${f.attemptID}`;
      await sql`UPDATE factory.change SET state='active' WHERE id=${f.changeID}`;
      await sql`INSERT INTO factory.substrate_source(workspace_id,actor_uid)
        VALUES(${f.workspaceID},${codingUID})`;
    });
    const codingState = async () => ({
      attempts: [
        ...(await f.database.client`SELECT * FROM factory.runtime_attempt WHERE id=${f.attemptID}`),
      ],
      bindings: [
        ...(await f.database
          .client`SELECT * FROM factory.substrate_binding WHERE runtime_attempt_id=${f.attemptID}`),
      ],
      sources: [
        ...(await f.database
          .client`SELECT * FROM factory.substrate_source WHERE workspace_id=${f.workspaceID}`),
      ],
      writers: [
        ...(await f.database
          .client`SELECT * FROM factory.change_writer WHERE change_id=${f.changeID}`),
      ],
    });
    const retainedCoding = await codingState();
    const submittedID = crypto.randomUUID();
    await f.database.client`INSERT INTO factory.change_commit_operation(
      id,change_id,runtime_attempt_id,sequence,branch_name,expected_parent_sha,
      commit_sha,observed_remote_sha,commit_message,idempotency_key,state,created_by,completed_at)
      SELECT ${submittedID},id,runtime_attempt_id,1,branch_name,base_sha,
        ${"d".repeat(40)},${"d".repeat(40)},'Owned submitted Verification candidate',
        ${`owned-verification:${submittedID}`},'succeeded',created_by,now()
      FROM factory.change WHERE id=${f.changeID}`;
    await f.database
      .client`UPDATE factory.project SET repository_url='http://forgejo.cluster.svc:3000/owned/native-verification.git' WHERE id=${f.projectID}`;
    await f.database
      .client`INSERT INTO factory.verification(id,change_id,commit_sha,pull_request_number,action_run_id,runner_name,runner_uuid,runner_token,runner_job_handle,created_by)
      VALUES(${verificationID},${f.changeID},${"d".repeat(40)},1,1,'owned-native-verification',${crypto.randomUUID()},'owned-private-runner-token','owned-exact-job',${f.userID})`;
    for (const query of [
      f.database
        .client`UPDATE factory.verification SET runner_job_handle='foreign-job' WHERE id=${verificationID}`,
      f.database
        .client`UPDATE factory.verification SET runner_job_handle=NULL WHERE id=${verificationID}`,
      f.database.client`UPDATE factory.verification SET action_run_id=2 WHERE id=${verificationID}`,
      f.database
        .client`UPDATE factory.verification SET commit_sha=${"e".repeat(40)} WHERE id=${verificationID}`,
    ])
      await expect(Promise.resolve(query)).rejects.toThrow("native job binding is immutable");
    const workspaces = await f.database.client`SELECT * FROM factory.development_workspace`;
    await expect(runtime.startVerification(verificationID, crypto.randomUUID())).rejects.toThrow();
    expect(creates.size).toBe(0);
    await expect(
      f.database.client.begin((sql) => substrateVerificationSourceIn(sql, attemptID)),
    ).rejects.toThrow("Verification Source grant required");
    for (const next of ["CreateAtespaceAccessPolicy", "CreateActorTemplate", "CreateActor", ""]) {
      await expect(runtime.startVerification(verificationID, f.userID)).rejects.toThrow(
        "owned lost native reply",
      );
      lose = next;
    }
    await expect(runtime.startVerification(verificationID, f.userID)).rejects.toThrow(
      "no worker has room for the actor",
    );
    const [originalResume] = await f.database.client`
      SELECT actor_uid::text,native_version,origin_key,origin_checkpoint,stop_id,
        intended_at::text,attempted_at::text,outcome
      FROM factory.substrate_actor_rpc WHERE runtime_attempt_id=${attemptID} AND action='resume'`;
    expect(originalResume).toMatchObject({
      native_version: "1",
      origin_key: "initial",
      origin_checkpoint: null,
      stop_id: null,
      outcome: null,
    });
    const capacityWait = [
      ...(await f.database.client<{ reason: string }[]>`
        SELECT reason FROM factory.runtime_compute_wait WHERE attempt_id=${attemptID}`),
    ];
    // The pinned native workflow rejected assignment before advancing the Actor.
    // A current exact-job commission continues that same idempotent native Resume,
    // not another Actor or an edited/cleared immutable dispatch fact.
    runtime = controller(configuration);
    const [started, coalesced] = await Promise.all([
      runtime.startVerification(verificationID, f.userID),
      runtime.startVerification(verificationID, f.userID),
    ]);
    expect(coalesced?.id).toBe(attemptID);
    expect(resumeCalls).toBe(2);
    expect(capacityWait).toEqual([{ reason: "compute-capacity" }]);
    expect([
      ...(await f.database.client<{ reason: string }[]>`
        SELECT reason FROM factory.runtime_compute_wait WHERE attempt_id=${attemptID}`),
    ]).toEqual([]);
    const [completedResume] = await f.database.client`
      SELECT actor_uid::text,native_version,origin_key,origin_checkpoint,stop_id,
        intended_at::text,attempted_at::text,outcome
      FROM factory.substrate_actor_rpc WHERE runtime_attempt_id=${attemptID} AND action='resume'`;
    expect(completedResume).toEqual({
      ...originalResume,
      outcome: {
        actorUID: originalResume?.["actor_uid"],
        state: "ACTOR_STATE_RUNNING",
        version: "2",
      },
    });
    expect(started).toMatchObject({
      id: attemptID,
      state: "starting",
      revision: "d".repeat(40),
      workspaceId: null,
      changeId: null,
    });
    expect(started?.native?.state).toBe("ACTOR_STATE_RUNNING");
    expect(started?.native?.portable).toBe(false);
    expect(
      await f.database.client.begin((sql) => substrateVerificationPrincipalIn(sql, attemptID)),
    ).toBe(f.userID);
    await expect(
      f.database.client.begin((sql) => substrateVerificationPrincipalIn(sql, f.attemptID)),
    ).rejects.toThrow("Verification principal is unavailable");
    expect(resumes).toBe(1);
    expect(await codingState()).toEqual(retainedCoding);
    let retainedOwnerCalls = 0;
    const scoped = controller(configuration, async () => {
      retainedOwnerCalls++;
      throw new SubstrateRPCError("Unauthenticated", "expired provisioner");
    });
    expect((await scoped.startVerification(verificationID, f.userID))?.id).toBe(attemptID);
    expect(retainedOwnerCalls).toBe(0);
    expect(resumes).toBe(1);
    expect(resumeCalls).toBe(2);
    const policy = objects.get("AtespaceAccessPolicy");
    if (!policy) throw new Error("Original Verification policy missing");
    objects.set("AtespaceAccessPolicy", { ...policy, bindings: [] });
    await expect(scoped.startVerification(verificationID, f.userID)).rejects.toThrow(
      "grant differs",
    );
    expect(retainedOwnerCalls).toBe(0);
    objects.set("AtespaceAccessPolicy", policy);
    const repository = "http://forgejo.cluster.svc:3000/owned/native-verification.git";
    const readSource = () =>
      f.database.client.begin((sql) => substrateVerificationSourceIn(sql, attemptID));
    expect(await readSource()).toBe(repository);
    // Background exact-job Verification keeps its commissioned Project member;
    // it must not need a personal Developer Workspace grant to clone Source.
    await f.database
      .client`UPDATE factory.project_membership SET role='product-contributor' WHERE project_id=${f.projectID} AND user_id=${f.userID}`;
    expect(await readSource()).toBe(repository);
    await f.database
      .client`UPDATE factory.project SET repository_url='http://forgejo.cluster.svc:3000/owned/other.git' WHERE id=${f.projectID}`;
    await expect(readSource()).rejects.toThrow("Verification Source grant required");
    await f.database
      .client`UPDATE factory.project SET repository_url=${repository} WHERE id=${f.projectID}`;
    await expect(
      f.database.client.begin((sql) => substrateVerificationSourceIn(sql, f.attemptID)),
    ).rejects.toThrow("Verification Source grant required");
    for (const kind of ["Atespace", "AtespaceAccessPolicy", "ActorTemplate", "Actor"])
      expect(creates.get(kind)).toBe(1);
    expect(await f.database.client`SELECT * FROM factory.development_workspace`).toEqual(
      workspaces,
    );
    expect([
      ...(await f.database.client`SELECT to_regclass('factory.workspace_source') AS source`),
    ]).toEqual([{ source: null }]);
    expect(await f.database.client`SELECT * FROM factory.substrate_source`).toHaveLength(1);
    expect(await codingState()).toEqual(retainedCoding);
    expect([
      ...(await f.database.client`SELECT to_regclass('factory.factorybox_worker') AS worker`),
    ]).toEqual([{ worker: null }]);
    const [environment] = await f.database.client`SELECT environment,version::int AS version
      FROM factory.runtime_environment_intent WHERE runtime_attempt_id=${attemptID}`;
    expect(environment).toEqual({ environment: "development", version: 0 });
    const template = objects.get("ActorTemplate") as { containers: { env: { value: string }[] }[] };
    const bootstrap = JSON.parse(template.containers[0]?.env[0]?.value ?? "null");
    const factoryCA = await Bun.file(configuration.factoryCAFile).text();
    expect(bootstrap.factoryCA).toBe(`${factoryCA.trimEnd()}\n${registryCA}`);
    expect(bootstrap.sourceHandoff).toBe(false);
    expect(bootstrap.assignment.revision).toBe("d".repeat(40));
    expect(bootstrap.assignment.channels.map((channel: { kind: string }) => channel.kind)).toEqual([
      "verification",
    ]);
    expect(bootstrap.assignment.processes[0].env.FACTORY_RUNNER_HANDLE).toBe("owned-exact-job");
    expect(bootstrap.assignment.processes[0].env.FACTORY_RUNNER_CONFIG).toContain(
      "url: https://git.native.test",
    );
    const [persisted] = await f.database
      .client`SELECT intent,template FROM factory.substrate_verification WHERE verification_id=${verificationID}`;
    expect(JSON.stringify(persisted)).not.toContain("owned-private-runner-token");
    expect(JSON.stringify(persisted)).not.toContain("parentToken");
    f.hub.ready = () => true;
    await runtime.status(attemptID, "ready");
    expect((await runtime.get(attemptID))?.state).toBe("ready");
    await expect(readSource()).rejects.toThrow("Verification Source grant required");
    const originalTemplate = structuredClone(objects.get("ActorTemplate"));
    const changed = objects.get("ActorTemplate");
    if (!changed) throw new Error("Owned template missing");
    changed["resources"] = { limits: { memoryBytes: "4096" } };
    await expect(runtime.startVerification(verificationID, f.userID)).rejects.toThrow(
      "template differs",
    );
    if (!originalTemplate) throw new Error("Original owned template missing");
    objects.set("ActorTemplate", originalTemplate);
    expect(creates.get("Actor")).toBe(1);
    runtime = controller({
      ...configuration,
      workloadImage: `registry.test/native@sha256:${"b".repeat(64)}`,
      resources: { cpuMilli: 3000, memoryMiB: 6144 },
    });
    expect((await runtime.startVerification(verificationID, f.userID))?.id).toBe(attemptID);
    expect(objects.get("ActorTemplate")).toMatchObject({
      resources: { limits: { cpuMillicores: "2000", memoryBytes: "4294967296" } },
    });
    expect(creates.get("Actor")).toBe(1);
    await expect(
      Promise.resolve(
        f.database
          .client`DELETE FROM factory.substrate_verification WHERE verification_id=${verificationID}`,
      ),
    ).rejects.toThrow("cannot be reused");
    const [originalProvision] = await f.database
      .client`SELECT * FROM factory.substrate_verification WHERE runtime_attempt_id=${attemptID}`;
    if (!originalProvision) throw new Error("Original native provisioning history is missing");
    expect((await runtime.stop(attemptID))?.state).toBe("stopped");
    await expect(
      f.database.client.begin((sql) => substrateVerificationPrincipalIn(sql, attemptID)),
    ).rejects.toThrow("Verification principal is unavailable");
    await expect(readSource()).rejects.toThrow("Verification Source grant required");
    expect(deletes).toBe(1);
    // Controlled receipt of the existing authenticated retry owner. Its human
    // authorization/queued-job/commit gates have their own integration journey;
    // this fixture exercises only native immutable successor provisioning.
    await f.database.client`UPDATE factory.verification SET state='pending',runtime_attempt_id=NULL,
      runner_uuid=${crypto.randomUUID()},runner_token='owned-successor-token' WHERE id=${verificationID}`;
    await expect(runtime.startVerification(verificationID, f.userID)).rejects.toThrow(
      "inputs differ",
    );
    expect(creates.get("Actor")).toBe(1);
    await f.database
      .client`INSERT INTO factory.execution_policy_command(command_id,scope,actor_id,input,result)
      VALUES(${crypto.randomUUID()},${`checks-bootstrap-retry:${f.changeID}`},${f.userID},
        ${JSON.stringify({ changeID: f.changeID, verificationID, runtimeAttemptID: attemptID })}::jsonb,
        ${JSON.stringify({ verificationID, runtimeAttemptID: attemptID, state: "failed" })}::jsonb)`;
    const successorID = runtimeIdentity(verificationID, 2).attemptID;
    provisioningAttemptID = successorID;
    lose = "CreateActorTemplate";
    await expect(runtime.startVerification(verificationID, f.userID)).rejects.toThrow(
      "owned lost native reply",
    );
    const successor = await runtime.startVerification(verificationID, f.userID);
    expect(successor).toMatchObject({
      id: successorID,
      state: "starting",
      generation: "2",
      revision: "d".repeat(40),
      workspaceId: null,
    });
    expect(creates.get("Actor")).toBe(2);
    expect(creates.get("Atespace")).toBe(2);
    expect(creates.get("ActorTemplate")).toBe(2);
    expect(resumes).toBe(2);
    expect(spaces.get(`fa-${successorID.replaceAll("-", "")}`)?.get("ActorTemplate")).toMatchObject(
      {
        containers: [{ image: `registry.test/native@sha256:${"b".repeat(64)}` }],
        resources: { limits: { cpuMillicores: "3000", memoryBytes: "6442450944" } },
      },
    );
    expect([
      ...(await f.database
        .client`SELECT * FROM factory.substrate_verification WHERE runtime_attempt_id=${attemptID}`),
    ]).toEqual([originalProvision]);
    expect(
      (
        await f.database.client<
          { generation: number }[]
        >`SELECT generation::int AS generation FROM factory.substrate_verification WHERE verification_id=${verificationID} ORDER BY generation`
      ).map((row) => row.generation),
    ).toEqual([1, 2]);
    expect((await runtime.get(attemptID))?.state).toBe("stopped");
    expect((await runtime.startVerification(verificationID, f.userID))?.id).toBe(successorID);
    expect(creates.get("Actor")).toBe(2);
    await expect(
      Promise.resolve(f.database
        .client`INSERT INTO factory.substrate_verification(verification_id,runtime_attempt_id,generation,intent)
      SELECT verification_id,${runtimeIdentity(verificationID, 3).attemptID},3,intent FROM factory.substrate_verification
      WHERE runtime_attempt_id=${successorID}`),
    ).rejects.toThrow("requires exact cleanup");
    expect(await f.database.client`SELECT * FROM factory.development_workspace`).toEqual(
      workspaces,
    );
    await f.database
      .client`UPDATE factory.verification SET state='cancelled',completed_at=now() WHERE id=${verificationID}`;
    await expect(runtime.startVerification(verificationID, f.userID)).rejects.toThrow(
      "Verification authority",
    );
    expect((await runtime.stop(successorID))?.state).toBe("stopped");
    expect(deletes).toBe(2);
    expect(await f.database.client`SELECT * FROM factory.development_workspace`).toEqual(
      workspaces,
    );
    const completedVerificationID = verificationID;
    const retainedGenerations = [
      ...(await f.database
        .client`SELECT * FROM factory.substrate_verification WHERE verification_id=${completedVerificationID} ORDER BY generation`),
    ];
    verificationID = crypto.randomUUID();
    provisioningAttemptID = runtimeIdentity(verificationID, 1).attemptID;
    await f.database
      .client`INSERT INTO factory.verification(id,change_id,commit_sha,pull_request_number,runner_name,action_run_id,runner_uuid,runner_token,runner_job_handle,created_by)
      VALUES(${verificationID},${f.changeID},${"e".repeat(40)},2,'owned-distinct-job',102,${crypto.randomUUID()},'owned-distinct-runner-token','owned-distinct-job',${f.userID})`;
    runtime = controller(configuration);
    expect((await runtime.startVerification(verificationID, f.userID))?.id).toBe(
      provisioningAttemptID,
    );
    expect((await runtime.get(provisioningAttemptID))?.generation).toBe("1");
    expect(creates.get("Actor")).toBe(3);
    expect([
      ...(await f.database
        .client`SELECT * FROM factory.substrate_verification WHERE verification_id=${completedVerificationID} ORDER BY generation`),
    ]).toEqual(retainedGenerations);
    expect((await runtime.stop(provisioningAttemptID))?.state).toBe("stopped");
    expect(await codingState()).toEqual(retainedCoding);
    expect(codingActor.status.state).toBe("ACTOR_STATE_RUNNING");
  } finally {
    f.hub.revoke(attemptID);
    f.hub.revoke(provisioningAttemptID);
    if (previous.api === undefined) delete process.env["FACTORY_FORGEJO_API_URL"];
    else process.env["FACTORY_FORGEJO_API_URL"] = previous.api;
    if (previous.public === undefined) delete process.env["FACTORY_FORGEJO_PUBLIC_URL"];
    else process.env["FACTORY_FORGEJO_PUBLIC_URL"] = previous.public;
    if (previous.owner === undefined) delete process.env["FACTORY_FORGEJO_OWNER"];
    else process.env["FACTORY_FORGEJO_OWNER"] = previous.owner;
    if (previous.registryCA === undefined) delete process.env["FACTORY_REGISTRY_CA_FILE"];
    else process.env["FACTORY_REGISTRY_CA_FILE"] = previous.registryCA;
    await f.dispose();
    await rm(directory, { recursive: true, force: true });
  }
}, 180_000);
