import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDeliveryPromotion } from "../../apps/factory/src/delivery/promotion";
import { createRuntimeController } from "../../apps/factory/src/runtime/controller";
import { removeRuntimeRepository } from "../../apps/factory/src/runtime/git-http";
import {
  substrateIsolatedSourceIn,
  substrateStagingOwner,
} from "../../apps/factory/src/runtime/substrate-isolated-grant";
import type { SubstrateInstallationConfiguration } from "../../apps/factory/src/runtime/substrate-workspaces";
import { runtimeIdentity } from "../../packages/runtime-domain/src/identity";
import {
  nativeActor,
  type SubstrateCall,
  SubstrateRPCError,
} from "../../packages/runtime-kubernetes/src/substrate-control";
import { substrateFixture } from "../fixtures/substrate";

async function isolatedFixture() {
  const f = await substrateFixture("a".repeat(40), "ticket");
  const directory = await mkdtemp(join(tmpdir(), "native-isolated-"));
  const repo = join(directory, "repository");
  const ca = join(directory, "ca.pem");
  await writeFile(ca, "-----BEGIN CERTIFICATE-----\nowned-test\n-----END CERTIFICATE-----\n");
  await Bun.$`git init -b main ${repo}`.quiet();
  await mkdir(join(repo, ".factory"));
  await writeFile(join(repo, "README"), "owned Staging source\n");
  await writeFile(
    join(repo, ".factory/system.json"),
    JSON.stringify({
      version: 1,
      primaryApp: "web",
      apps: [
        {
          id: "web",
          label: "Owned Web",
          command: ["node", "server.mjs"],
          port: 4300,
          healthPath: "/",
        },
      ],
    }),
  );
  await Bun.$`git -C ${repo} add .`.quiet();
  await Bun.$`git -C ${repo} -c user.name=Owned -c user.email=owned@example.invalid commit -m initial`.quiet();
  const revision = (await Bun.$`git -C ${repo} rev-parse HEAD`.text()).trim();
  await f.database
    .client`UPDATE factory.project SET repository_url=${`file://${repo}`} WHERE id=${f.projectID}`;
  const config: SubstrateInstallationConfiguration = {
    deployment: "owned-test",
    database: f.config.database,
    connection: f.config.connection,
    provisioner: { ...f.config.connection, tokenFile: "/owned-provisioner" },
    editorPrincipal: "user:system:serviceaccount:owned:factory-control",
    connectorURL: f.config.connectorURL,
    factoryCAFile: ca,
    workloadImage: `registry.test/native@sha256:${"a".repeat(64)}`,
    resources: { cpuMilli: 2000, memoryMiB: 4096 },
    profile: f.config.profile,
    runtime: f.config.runtime,
    workerSelector: {
      "factory.runtime/profile": f.config.profile,
      "factory.dev/deployment": "owned-isolated",
    },
    egressHosts: ["git.native.test"],
  };
  const spaces = new Map<string, Map<string, Record<string, unknown>>>();
  const creates = new Map<string, number>();
  let lose: string | undefined;
  let rejected: string | undefined;
  let resumes = 0;
  let deletes = 0;
  const call: SubstrateCall = async (method, input) => {
    const request = input as Record<string, Record<string, unknown>>;
    const kind = method.replace(/^(Get|Create|Delete)/, "");
    const space =
      request["atespace"]?.["name"] ??
      (request["atespace"]?.["metadata"] as { name?: string } | undefined)?.name ??
      request["actorTemplate"]?.["atespace"] ??
      (request["actorTemplate"]?.["metadata"] as { atespace?: string } | undefined)?.atespace ??
      request["actor"]?.["atespace"] ??
      (request["actor"]?.["metadata"] as { atespace?: string } | undefined)?.atespace;
    if (typeof space !== "string") throw new Error("Missing owned native resource scope");
    let objects = spaces.get(space);
    if (!objects) {
      objects = new Map();
      spaces.set(space, objects);
    }
    if (method.startsWith("Get")) {
      const value = objects.get(kind);
      if (!value) throw new SubstrateRPCError("NotFound", "original resource absent");
      return structuredClone(value);
    }
    if (method.startsWith("Create")) {
      creates.set(kind, (creates.get(kind) ?? 0) + 1);
      const suffix = space.slice("fa-".length);
      const attemptID = `${suffix.slice(0, 8)}-${suffix.slice(8, 12)}-${suffix.slice(12, 16)}-${suffix.slice(16, 20)}-${suffix.slice(20)}`;
      if (["Atespace", "AtespaceAccessPolicy", "ActorTemplate"].includes(kind)) {
        const [saved] = await f.database.client`
          SELECT atespace_attempted_at,policy_attempted_at,template_attempted_at FROM factory.substrate_isolated
          WHERE runtime_attempt_id=${attemptID}`;
        const key =
          kind === "Atespace"
            ? "atespace_attempted_at"
            : kind === "AtespaceAccessPolicy"
              ? "policy_attempted_at"
              : "template_attempted_at";
        expect(saved?.[key]).not.toBeNull();
      } else if (kind === "Actor") {
        const [saved] = await f.database.client`
          SELECT create_attempted_at FROM factory.substrate_binding WHERE runtime_attempt_id=${attemptID}`;
        expect(saved?.["create_attempted_at"]).not.toBeNull();
      }
      if (method === rejected)
        throw new SubstrateRPCError("PermissionDenied", "owned rejected Create");
      const spec =
        kind === "AtespaceAccessPolicy"
          ? request["accessPolicy"]
          : kind === "ActorEgressPolicy"
            ? request["egressPolicy"]
            : request[`${kind[0]?.toLowerCase()}${kind.slice(1)}`];
      if (!spec) throw new Error("Missing owned native resource");
      const value = {
        ...spec,
        metadata: {
          ...(spec["metadata"] as object),
          uid: crypto.randomUUID(),
          version: "1",
          createTime: new Date().toISOString(),
        },
      };
      if (kind === "Actor") Object.assign(value, { status: { state: "ACTOR_STATE_SUSPENDED" } });
      objects.set(kind, value);
      if (method === lose) {
        lose = undefined;
        throw new SubstrateRPCError("Unavailable", "owned lost native reply");
      }
      return structuredClone(value);
    }
    if (method === "ResumeActor") {
      resumes++;
      const actor = nativeActor.parse(objects.get("Actor"));
      actor.metadata.version = String(Number(actor.metadata.version) + 1);
      actor.status = {
        state: "ACTOR_STATE_RUNNING",
        workerAssignment: { sandboxRuntime: f.config.runtime },
      };
      objects.set("Actor", actor);
      return { actor };
    }
    if (method === "DeleteActor") {
      const actor = nativeActor.parse(objects.get("Actor"));
      expect(request["options"]).toEqual({
        uid: actor.metadata.uid,
        version: actor.metadata.version,
      });
      deletes++;
      objects.delete("Actor");
      return {};
    }
    throw new Error(`Unexpected owned native RPC ${method}`);
  };
  const editor: SubstrateCall = async (method, request) => {
    expect(method).not.toMatch(/^CreateAtespace/);
    return call(method, request);
  };
  const controller = (provisioner = call) =>
    createRuntimeController(f.database, f.hub, "owned-native-secret", {
      configuration: config,
      call: editor,
      provisionerCall: provisioner,
    });
  return {
    f,
    config,
    revision,
    repo,
    spaces,
    creates,
    controller,
    lose(method: string) {
      lose = method;
    },
    reject(method: string) {
      rejected = method;
    },
    counts: () => ({ resumes, deletes }),
    objects(attemptID: string) {
      const value = spaces.get(`fa-${attemptID.replaceAll("-", "")}`);
      if (!value) throw new Error("Missing owned Actor scope");
      return value;
    },
    async dispose() {
      const attempts = await f.database.client<{ id: string }[]>`
        SELECT runtime_attempt_id AS id FROM factory.substrate_isolated WHERE project_id=${f.projectID}`;
      for (const attempt of attempts) {
        f.hub.revoke(attempt.id);
        await removeRuntimeRepository(attempt.id);
      }
      await f.dispose();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

test("native initial Staging retains original creates, serves only its bootstrap Source and starts a new generation only after UID-confirmed Stop", async () => {
  const owned = await isolatedFixture();
  const { f } = owned;
  const runtime = owned.controller();
  const attemptID = runtimeIdentity(substrateStagingOwner(f.projectID), 1).attemptID;
  const workspaces = await f.database.client`SELECT * FROM factory.development_workspace`;
  try {
    await expect(runtime.ensureStaging(f.projectID, crypto.randomUUID())).rejects.toThrow();
    expect(owned.creates.size).toBe(0);
    owned.lose("CreateAtespace");
    await expect(runtime.ensureStaging(f.projectID, f.userID)).rejects.toThrow(
      "owned lost native reply",
    );
    owned.lose("CreateActor");
    await expect(runtime.ensureStaging(f.projectID, f.userID)).rejects.toThrow(
      "owned lost native reply",
    );
    const started = await runtime.ensureStaging(f.projectID, f.userID);
    expect(started).toMatchObject({
      id: attemptID,
      revision: owned.revision,
      state: "starting",
      runtimeKind: "staging",
      workspaceId: null,
      changeId: null,
    });
    expect(started?.native?.state).toBe("ACTOR_STATE_RUNNING");
    expect(owned.creates.get("Actor")).toBe(1);
    expect(owned.creates.get("Atespace")).toBe(1);
    expect(owned.counts().resumes).toBe(1);
    const [declaration] = await f.database
      .client`SELECT declaration FROM factory.staging_configuration WHERE runtime_attempt_id=${attemptID}`;
    expect(declaration?.["declaration"]).toMatchObject({
      channels: [{ name: "app", kind: "app", target: "http://127.0.0.1:4300" }],
      processes: [{ name: "app", command: ["node", "server.mjs"] }],
    });
    expect(JSON.stringify(declaration)).not.toContain("parentToken");
    const source = () =>
      f.database.client.begin((sql) => substrateIsolatedSourceIn(sql, attemptID));
    expect(await source()).toBe(`file://${owned.repo}`);
    await f.database
      .client`DELETE FROM factory.project_membership WHERE project_id=${f.projectID} AND user_id=${f.userID}`;
    await expect(source()).rejects.toThrow();
    await f.database
      .client`INSERT INTO factory.project_membership(project_id,user_id,role,updated_by)
      VALUES(${f.projectID},${f.userID},'developer',${f.userID})`;
    const [intent] = await f.database
      .client`SELECT intent FROM factory.substrate_isolated WHERE runtime_attempt_id=${attemptID}`;
    const objects = owned.objects(attemptID);
    const originalImage = owned.config.workloadImage;
    owned.config.workloadImage = `registry.test/native@sha256:${"b".repeat(64)}`;
    expect((await owned.controller().get(attemptID))?.native?.actorUID).toBe(
      nativeActor.parse(objects.get("Actor")).metadata.uid,
    );
    const originalTemplate = objects.get("ActorTemplate");
    if (!originalTemplate) throw new Error("Original native template is missing");
    expect((originalTemplate["containers"] as { image: string }[])[0]?.image).toBe(originalImage);
    expect((await runtime.ensureStaging(f.projectID, f.userID))?.id).toBe(attemptID);
    expect(owned.counts().resumes).toBe(1);
    await expect(
      Promise.resolve(
        f.database
          .client`UPDATE factory.substrate_isolated SET atespace_attempted_at=NULL WHERE runtime_attempt_id=${attemptID}`,
      ),
    ).rejects.toThrow("immutable");
    const stopped = await runtime.stop(attemptID);
    expect(stopped?.state).toBe("stopped");
    expect(owned.counts().deletes).toBe(1);
    const successorID = runtimeIdentity(substrateStagingOwner(f.projectID), 2).attemptID;
    expect((await owned.controller().ensureStaging(f.projectID, f.userID))?.id).toBe(successorID);
    expect(owned.creates.get("Actor")).toBe(2);
    expect(
      (
        await f.database
          .client`SELECT intent FROM factory.substrate_isolated WHERE runtime_attempt_id=${attemptID}`
      )[0],
    ).toEqual(intent);
    expect(await f.database.client`SELECT * FROM factory.development_workspace`).toEqual(
      workspaces,
    );
    expect([
      ...(await f.database.client`SELECT to_regclass('factory.workspace_source') AS source,
        to_regclass('factory.factorybox_worker') AS worker`),
    ]).toEqual([{ source: null, worker: null }]);
  } finally {
    await owned.dispose();
  }
}, 60_000);

test("native publication binds one exact Forgejo job, publishes through admitted HTTPS and receives no Project environment or Source writer", async () => {
  const owned = await isolatedFixture();
  const { f } = owned;
  const previous = {
    api: process.env["FACTORY_FORGEJO_API_URL"],
    public: process.env["FACTORY_FORGEJO_PUBLIC_URL"],
  };
  process.env["FACTORY_FORGEJO_API_URL"] = "http://forgejo.cluster.svc:3000/api/v1/";
  process.env["FACTORY_FORGEJO_PUBLIC_URL"] = "https://git.native.test";
  const publicationID = crypto.randomUUID();
  const releaseID = crypto.randomUUID();
  const attemptID = runtimeIdentity(publicationID, 1).attemptID;
  const revision = "d".repeat(40);
  const runnerUUID = crypto.randomUUID();
  try {
    await f.database
      .client`UPDATE factory.project SET repository_url='http://forgejo.cluster.svc:3000/owned/publication.git' WHERE id=${f.projectID}`;
    await f.database
      .client`INSERT INTO factory.project_release(id,project_id,command_id,version,commit_sha,notes,state,created_by)
      VALUES(${releaseID},${f.projectID},${crypto.randomUUID()},'1.2.3',${revision},'Owned controller fixture','running',${f.userID})`;
    await f.database
      .client`INSERT INTO factory.release_attempt(id,release_id,command_id,ordinal,state,run_id,dispatch_intended_at,runner_uuid,runner_token,job_handle)
      VALUES(${publicationID},${releaseID},${crypto.randomUUID()},1,'running',1,now(),${runnerUUID},'owned-private-publication-token','owned-original-publication-job')`;
    const runtime = owned.controller();
    await expect(runtime.startPublication(publicationID, crypto.randomUUID())).rejects.toThrow();
    expect(owned.creates.size).toBe(0);
    process.env["FACTORY_FORGEJO_PUBLIC_URL"] = "http://git.native.test";
    await expect(runtime.startPublication(publicationID, f.userID)).rejects.toThrow("TLS");
    expect(owned.creates.size).toBe(0);
    process.env["FACTORY_FORGEJO_PUBLIC_URL"] = "https://git.native.test";
    owned.lose("CreateActor");
    await expect(runtime.startPublication(publicationID, f.userID)).rejects.toThrow(
      "owned lost native reply",
    );
    const started = await runtime.startPublication(publicationID, f.userID);
    expect(started).toMatchObject({
      id: attemptID,
      revision,
      state: "starting",
      runtimeKind: "publication",
      workspaceId: null,
      changeId: null,
    });
    expect(owned.creates.get("Actor")).toBe(1);
    expect(owned.counts().resumes).toBe(1);
    const template = owned.objects(attemptID).get("ActorTemplate");
    if (!template) throw new Error("Original publication template is missing");
    const bootstrap = JSON.parse(
      (template["containers"] as { env: { name: string; value: string }[] }[])[0]?.env[0]?.value ??
        "null",
    );
    expect(bootstrap.sourceHandoff).toBe(false);
    expect(bootstrap.assignment.processes).toHaveLength(1);
    expect(bootstrap.assignment.processes[0].env.FACTORY_RUNNER_HANDLE).toBe(
      "owned-original-publication-job",
    );
    expect(bootstrap.assignment.processes[0].env.FACTORY_RELEASE_CREDENTIAL_URL).toBe(
      `https://factory.test/internal/releases/${publicationID}/credentials`,
    );
    expect(bootstrap.assignment.processes[0].env.FACTORY_RELEASE_REGISTRY_URL).toBe(
      "https://git.native.test",
    );
    expect(bootstrap.assignment.processes[0].env.FACTORY_RUNNER_CONFIG).toContain(runnerUUID);
    const [environment] = await f.database
      .client`SELECT environment,version::float8 AS version,secret_key AS "secretKey"
      FROM factory.runtime_environment_intent WHERE runtime_attempt_id=${attemptID}`;
    expect(environment).toEqual({ environment: "development", version: 0, secretKey: null });
    const [provision] = await f.database
      .client`SELECT intent FROM factory.substrate_isolated WHERE runtime_attempt_id=${attemptID}`;
    expect(JSON.stringify(provision)).not.toContain("owned-private-publication-token");
    expect(JSON.stringify(provision)).not.toContain("parentToken");
    expect(await f.database.client.begin((sql) => substrateIsolatedSourceIn(sql, attemptID))).toBe(
      "http://forgejo.cluster.svc:3000/owned/publication.git",
    );
    const expired = owned.controller(async () => {
      throw new SubstrateRPCError("Unauthenticated", "expired provisioner");
    });
    expect((await expired.startPublication(publicationID, f.userID))?.id).toBe(attemptID);
    expect(owned.counts().resumes).toBe(1);
    await f.database
      .client`UPDATE factory.release_attempt SET state='succeeded' WHERE id=${publicationID}`;
    await expect(
      f.database.client.begin((sql) => substrateIsolatedSourceIn(sql, attemptID)),
    ).rejects.toThrow();
    expect((await runtime.stop(attemptID))?.state).toBe("stopped");
    expect(owned.counts().deletes).toBe(1);
    expect([
      ...(await f.database.client`SELECT to_regclass('factory.workspace_source') AS source,
        to_regclass('factory.factorybox_worker') AS worker`),
    ]).toEqual([{ source: null, worker: null }]);
  } finally {
    if (previous.api === undefined) delete process.env["FACTORY_FORGEJO_API_URL"];
    else process.env["FACTORY_FORGEJO_API_URL"] = previous.api;
    if (previous.public === undefined) delete process.env["FACTORY_FORGEJO_PUBLIC_URL"];
    else process.env["FACTORY_FORGEJO_PUBLIC_URL"] = previous.public;
    await owned.dispose();
  }
}, 60_000);

test.each(["missing", "pending", "passed"] as const)(
  "native promotion rechecks independent review %s and retains the previous Preview until Connector readiness",
  async (reviewState) => {
    const owned = await isolatedFixture();
    const { f } = owned;
    const runtime = owned.controller();
    try {
      const original = await runtime.ensureStaging(f.projectID, f.userID);
      if (!original) throw new Error("Original owned Staging is missing");
      const promotionID = crypto.randomUUID();
      const verificationID = crypto.randomUUID();
      const approvalID = crypto.randomUUID();
      const reviewID = crypto.randomUUID();
      await f.database.client`UPDATE factory.change SET state='delivering' WHERE id=${f.changeID}`;
      // Controlled domain records exercise admission. They are not human decisions
      // or evidence that a live model/CI/reviewer completed the product journey.
      await f.database
        .client`INSERT INTO factory.verification(id,change_id,commit_sha,pull_request_number,runner_name,state,action_run_id,created_by,completed_at)
      VALUES(${verificationID},${f.changeID},${owned.revision},1,'owned-controller-verification','succeeded',1,${f.userID},now())`;
      if (reviewState !== "missing")
        await f.database
          .client`INSERT INTO factory.candidate_review(id,verification_id,change_id,commit_sha,base_sha,created_by,state,result,completed_at)
        VALUES(${reviewID},${verificationID},${f.changeID},${owned.revision},${"a".repeat(40)},${f.userID},${reviewState},
            ${reviewState === "passed" ? '{"verdict":"passed"}' : null}::jsonb,
            CASE WHEN ${reviewState === "passed"} THEN now() ELSE NULL END)`;
      await f.database
        .client`INSERT INTO factory.delivery_approval(id,change_id,verification_id,commit_sha,approved_by,candidate_review_id)
      VALUES(${approvalID},${f.changeID},${verificationID},${owned.revision},${f.userID},${reviewState === "missing" ? null : reviewID})`;
      await f.database
        .client`INSERT INTO factory.merge_operation(id,change_id,delivery_approval_id,pull_request_number,base_sha,commit_sha,idempotency_key,state,observed_default_sha,completed_at)
      VALUES(${crypto.randomUUID()},${f.changeID},${approvalID},1,${"a".repeat(40)},${owned.revision},${`owned-merge:${promotionID}`},'succeeded',${owned.revision},now())`;
      await f.database
        .client`INSERT INTO factory.promotion_operation(id,change_id,project_id,commit_sha,previous_runtime_attempt_id)
      VALUES(${promotionID},${f.changeID},${f.projectID},${owned.revision},${original.id})`;
      const before = owned.creates.get("Actor");
      if (reviewState !== "passed") {
        await expect(runtime.startStagingReplacement(promotionID, f.userID)).rejects.toThrow(
          "approved exact-commit",
        );
        expect(owned.creates.get("Actor")).toBe(before);
        expect(
          (
            await f.database
              .client`SELECT runtime_attempt_id FROM factory.staging_preview WHERE project_id=${f.projectID}`
          )[0]?.["runtime_attempt_id"],
        ).toBe(original.id);
        return;
      }
      const replacement = await runtime.startStagingReplacement(promotionID, f.userID);
      if (!replacement) throw new Error("Native replacement is missing");
      expect(replacement.id).toBe(runtimeIdentity(promotionID, 1).attemptID);
      expect(replacement.state).toBe("starting");
      let retiredBranches = 0;
      const promote = createDeliveryPromotion(
        f.database,
        runtime,
        { deleteRunner: async () => {} },
        async () => {
          retiredBranches++;
        },
      );
      const change = {
        id: f.changeID,
        projectID: f.projectID,
        ticketID: f.ticketID,
        userID: f.userID,
        runtimeAttemptID: null,
      };
      await promote(change, { owner: "owned", name: "staging" });
      expect(
        (
          await f.database
            .client`SELECT runtime_attempt_id FROM factory.staging_preview WHERE project_id=${f.projectID}`
        )[0]?.["runtime_attempt_id"],
      ).toBe(original.id);
      await runtime.status(replacement.id, "ready");
      expect((await runtime.get(replacement.id))?.state).toBe("starting");
      // Controlled Connector observations, not a native App qualification.
      f.hub.ready = () => true;
      f.hub.appChannels = () => ["app"];
      f.hub.processes = () => [{ name: "app", state: "running", output: "" }];
      await runtime.status(replacement.id, "ready");
      await promote(change, { owner: "owned", name: "staging" });
      expect(
        (
          await f.database
            .client`SELECT runtime_attempt_id FROM factory.staging_preview WHERE project_id=${f.projectID}`
        )[0]?.["runtime_attempt_id"],
      ).toBe(replacement.id);
      expect(
        (
          await f.database
            .client`SELECT state FROM factory.promotion_operation WHERE id=${promotionID}`
        )[0]?.["state"],
      ).toBe("succeeded");
      expect(
        (await f.database.client`SELECT state FROM factory.change WHERE id=${f.changeID}`)[0]?.[
          "state"
        ],
      ).toBe("delivered");
      expect((await runtime.get(original.id))?.state).toBe("stopped");
      expect(owned.counts().deletes).toBe(1);
      expect(retiredBranches).toBe(1);
      expect([
        ...(await f.database.client`SELECT to_regclass('factory.workspace_source') AS source,
          to_regclass('factory.factorybox_worker') AS worker`),
      ]).toEqual([{ source: null, worker: null }]);
    } finally {
      await owned.dispose();
    }
  },
  60_000,
);
