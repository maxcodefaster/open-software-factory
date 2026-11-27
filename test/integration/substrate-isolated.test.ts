import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  hashConnectorToken,
  runtimeConnectorTokens,
  runtimeIdentity,
} from "#runtime-domain/identity";
import {
  type NativeActor,
  nativeActor,
  nativeSnapshot,
  type SubstrateCall,
  SubstrateRPCError,
} from "#runtime-kubernetes/substrate-control";
import { parseSystemContract } from "#system-contract/system-contract";
import { createDeliveryPromotion } from "../../apps/factory/src/delivery/promotion";
import { retryPromotion } from "../../apps/factory/src/delivery/promotion-retry";
import { createRuntimeController } from "../../apps/factory/src/runtime/controller";
import {
  readRepositoryFileAtRevision,
  removeRuntimeRepository,
} from "../../apps/factory/src/runtime/git-http";
import {
  substrateIsolatedPrincipalIn,
  substrateIsolatedSourceIn,
  substrateStagingOwner,
} from "../../apps/factory/src/runtime/substrate-isolated-grant";
import type { SubstrateInstallationConfiguration } from "../../apps/factory/src/runtime/substrate-workspaces";
import { nativeProjectTemplate } from "../fixtures/native-project";
import { substrateFixture } from "../fixtures/substrate";

async function isolatedFixture() {
  const f = await substrateFixture("a".repeat(40), "ticket");
  const directory = await mkdtemp(join(tmpdir(), "native-isolated-"));
  const repo = join(directory, "repository");
  const ca = join(directory, "ca.pem");
  await writeFile(ca, "-----BEGIN CERTIFICATE-----\nowned-test\n-----END CERTIFICATE-----\n");
  await Bun.$`git init -b main ${repo}`.quiet();
  await mkdir(join(repo, ".factory"));
  await writeFile(join(repo, nativeProjectTemplate.path), nativeProjectTemplate.content);
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
  const readProject = async (requestedRevision: string) => {
    expect(requestedRevision).toBe(revision);
    const repository = `file://${repo}`;
    const content = await readRepositoryFileAtRevision(
      repository,
      requestedRevision,
      nativeProjectTemplate.path,
    );
    return {
      systemContract: parseSystemContract(
        await readRepositoryFileAtRevision(repository, requestedRevision, ".factory/system.json"),
      ),
      actorTemplate: {
        path: nativeProjectTemplate.path,
        content,
        sha256: createHash("sha256").update(content).digest("hex"),
      },
    };
  };
  // Controlled Forge contents only: both files come from this exact committed
  // tree. No remote Forge, Source host or native execution is commissioned here.
  const forge = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      expect(request.method).toBe("GET");
      const prefix = `/api/v1/repos/${process.env["FACTORY_FORGEJO_OWNER"]}/publication/contents/`;
      expect(url.pathname.startsWith(prefix)).toBe(true);
      const path = url.pathname.slice(prefix.length);
      expect([".factory/system.json", nativeProjectTemplate.path]).toContain(path);
      const project = await readProject(url.searchParams.get("ref") ?? "");
      const content =
        path === nativeProjectTemplate.path
          ? project.actorTemplate.content
          : JSON.stringify(project.systemContract);
      return Response.json({
        content: Buffer.from(content).toString("base64"),
        encoding: "base64",
        sha: (await Bun.$`git -C ${repo} rev-parse ${`${revision}:${path}`}`.text()).trim(),
      });
    },
  });
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
  const calls: string[] = [];
  let lose: string | undefined;
  let rejected: string | undefined;
  let resumes = 0;
  let deletes = 0;
  let resumeFailure: Error | undefined;
  let beforeResumeFailure: ((actor: NativeActor) => void | Promise<void>) | undefined;
  let pauseResume: { entered: () => void; released: Promise<void> } | undefined;
  const call: SubstrateCall = async (method, input) => {
    calls.push(method);
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
      if (method === lose) {
        lose = undefined;
        throw new SubstrateRPCError("Unavailable", "owned lost native observation");
      }
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
          SELECT resources#>>'{atespace,attemptedAt}' AS atespace_attempted_at,
            resources#>>'{policy,attemptedAt}' AS policy_attempted_at,
            resources#>>'{template,attemptedAt}' AS template_attempted_at
          FROM factory.substrate_provision
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
          SELECT attempt.create_attempted_at,attempt.workspace_id,attempt.change_id,attempt.verification_id,
            attempt.isolated_kind::text=isolated.kind AS exact_kind,
            CASE WHEN isolated.kind='publication' THEN EXISTS(
              SELECT 1 FROM factory.operation WHERE id=isolated.owner_id AND kind='releases.attempt'
                AND payload->>'runtimeAttemptId'=attempt.id::text)
            WHEN attempt.binding_intent->>'promotionID' IS NOT NULL THEN EXISTS(
              SELECT 1 FROM factory.operation
              WHERE id=(attempt.binding_intent->>'promotionID')::uuid AND kind='delivery.promotion'
                AND payload->>'replacementRuntimeAttemptId'=attempt.id::text
                AND state='starting')
            ELSE EXISTS(SELECT 1 FROM factory.operation
              WHERE kind='delivery.staging_preview' AND scope_type='project'
                AND scope_id=attempt.project_id::text
                AND payload->>'runtimeAttemptId'=attempt.id::text) END AS linked,
            CASE WHEN isolated.kind='staging' THEN (
              SELECT payload->'declaration'=isolated.intent->'declaration' FROM factory.operation
              WHERE kind='runtime.staging_configuration' AND scope_type='runtime_attempt'
                AND scope_id=attempt.id::text
                AND idempotency_key='runtime.staging_configuration:'||attempt.id::text) ELSE true END AS exact_declaration
          FROM factory.runtime_attempt attempt
          JOIN factory.substrate_provision isolated ON isolated.runtime_attempt_id=attempt.id
            AND isolated.kind IN ('staging','publication')
          WHERE attempt.id=${attemptID} AND attempt.atespace IS NOT NULL`;
        expect(saved?.["create_attempted_at"]).not.toBeNull();
        expect(saved).toMatchObject({
          workspace_id: null,
          change_id: null,
          verification_id: null,
          exact_kind: true,
          linked: true,
          exact_declaration: true,
        });
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
      objects.set(kind, value);
      if (method === lose) {
        lose = undefined;
        throw new SubstrateRPCError("Unavailable", "owned lost native reply");
      }
      return structuredClone(value);
    }
    if (method === "ResumeActor") {
      resumes++;
      if (resumeFailure) {
        const actor = nativeActor.parse(objects.get("Actor"));
        await beforeResumeFailure?.(actor);
        objects.set("Actor", actor);
        throw resumeFailure;
      }
      const actor = nativeActor.parse(objects.get("Actor"));
      actor.metadata.version = String(Number(actor.metadata.version) + 1);
      if (pauseResume) {
        actor.status = {
          state: "ACTOR_STATE_RESUMING",
          workerAssignment: { sandboxRuntime: f.config.runtime },
        };
        objects.set("Actor", actor);
        pauseResume.entered();
        await pauseResume.released;
        pauseResume = undefined;
      }
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
    forgeURL: forge.url.origin,
    spaces,
    creates,
    calls,
    controller,
    lose(method: string) {
      lose = method;
    },
    reject(method: string) {
      rejected = method;
    },
    failResume(error: Error, beforeThrow?: (actor: NativeActor) => void | Promise<void>) {
      resumeFailure = error;
      beforeResumeFailure = beforeThrow;
    },
    allowResume() {
      resumeFailure = undefined;
      beforeResumeFailure = undefined;
    },
    counts: () => ({ resumes, deletes }),
    holdResume() {
      let entered!: () => void;
      let release!: () => void;
      const reached = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const released = new Promise<void>((resolve) => {
        release = resolve;
      });
      pauseResume = { entered, released };
      return { reached, release };
    },
    objects(attemptID: string) {
      const value = spaces.get(`fa-${attemptID.replaceAll("-", "")}`);
      if (!value) throw new Error("Missing owned Actor scope");
      return value;
    },
    async dispose() {
      await forge.stop(true);
      const attempts = await f.database.client<{ id: string }[]>`
        SELECT runtime_attempt_id AS id FROM factory.substrate_provision WHERE project_id=${f.projectID} AND kind IN ('staging','publication')`;
      for (const attempt of attempts) {
        f.hub.revoke(attempt.id);
        await removeRuntimeRepository(attempt.id);
      }
      await f.dispose();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

test("native Staging initial Resume capacity refusal projects failure without replay or replacing its Actor", async () => {
  const owned = await isolatedFixture();
  const { f } = owned;
  const runtime = owned.controller();
  const attemptID = runtimeIdentity(substrateStagingOwner(f.projectID), 1).attemptID;
  const refusal = new SubstrateRPCError("ResourceExhausted", "owned worker capacity exhausted");
  owned.failResume(refusal);
  try {
    await expect(runtime.ensureStaging(f.projectID, f.userID)).rejects.toBe(refusal);
    expect(await runtime.get(attemptID)).toMatchObject({
      id: attemptID,
      state: "failed",
      failure: expect.stringContaining("capacity"),
    });
    const actor = nativeActor.parse(owned.objects(attemptID).get("Actor"));
    expect(actor.status).toEqual({ state: "ACTOR_STATE_SUSPENDED" });
    expect(actor.metadata.version).toBe("1");
    const intent = await f.database
      .client`SELECT * FROM factory.substrate_provision WHERE runtime_attempt_id=${attemptID}`;
    const facts = await f.database.client`
      SELECT * FROM factory.operation
      WHERE kind='runtime.actor_rpc' AND scope_type='runtime_attempt' AND scope_id=${attemptID}`;
    expect(facts).toHaveLength(1);
    expect(facts[0]).toMatchObject({
      scope_id: attemptID,
      state: "attempted",
      result: null,
      payload: {
        action: "resume",
        originKey: "initial",
        actorUid: actor.metadata.uid,
        nativeVersion: "1",
        originCheckpoint: null,
        stopId: null,
      },
    });
    expect(facts[0]?.["payload"]?.["attemptedAt"]).toBeTruthy();
    expect(await runtime.ensureStaging(f.projectID, f.userID)).toMatchObject({
      id: attemptID,
      state: "failed",
    });
    expect(
      await f.database
        .client`SELECT * FROM factory.substrate_provision WHERE runtime_attempt_id=${attemptID}`,
    ).toEqual(intent);
    expect(
      await f.database.client`
        SELECT * FROM factory.operation
        WHERE kind='runtime.actor_rpc' AND scope_type='runtime_attempt' AND scope_id=${attemptID}`,
    ).toEqual(facts);
    expect(
      await f.database.client`
        SELECT * FROM factory.operation WHERE kind='runtime.compute_wait'`,
    ).toHaveLength(0);
    expect(owned.creates.get("Actor")).toBe(1);
    expect(owned.counts()).toEqual({ resumes: 1, deletes: 0 });
    // Failed is not cleanup: only a confirmed Stop permits the explicit Retry
    // to commission a new immutable generation through the existing owner.
    expect((await runtime.stop(attemptID))?.state).toBe("stopped");
    owned.allowResume();
    const successor = await runtime.ensureStaging(f.projectID, f.userID);
    expect(successor).toMatchObject({
      id: runtimeIdentity(substrateStagingOwner(f.projectID), 2).attemptID,
      state: "starting",
    });
    expect(successor?.native?.actorUID).not.toBe(actor.metadata.uid);
    expect(owned.counts()).toEqual({ resumes: 2, deletes: 1 });
    expect(
      await f.database
        .client`SELECT * FROM factory.substrate_provision WHERE runtime_attempt_id=${attemptID}`,
    ).toEqual(intent);
    expect(
      await f.database.client`
        SELECT * FROM factory.operation
        WHERE kind='runtime.actor_rpc' AND scope_type='runtime_attempt' AND scope_id=${attemptID}`,
    ).toEqual(facts);
  } finally {
    await owned.dispose();
  }
}, 60_000);

test.each([
  "transport",
  "unavailable",
  "capacity message without status",
  "lost independent observation",
  "foreign Actor",
  "advanced version",
  "newer retained observation",
  "worker assignment",
  "assigned node",
  "assigned generation",
  "snapshot",
  "Source tag",
  "revoked Project authority",
  "Stop intent",
  "ready",
] as const)(
  "native Staging does not infer a confirmed capacity refusal from %s",
  async (scenario) => {
    const owned = await isolatedFixture();
    const { f } = owned;
    const runtime = owned.controller();
    const attemptID = runtimeIdentity(substrateStagingOwner(f.projectID), 1).attemptID;
    const failure =
      scenario === "transport"
        ? new Error("owned lost Resume reply")
        : scenario === "unavailable"
          ? new SubstrateRPCError("Unavailable", "owned lost Resume reply")
          : scenario === "capacity message without status"
            ? new Error("ResourceExhausted: owned worker capacity exhausted")
            : new SubstrateRPCError("ResourceExhausted", "owned worker capacity exhausted");
    owned.failResume(failure, async (actor) => {
      if (scenario === "lost independent observation") owned.lose("GetActor");
      if (scenario === "foreign Actor") actor.metadata.uid = crypto.randomUUID();
      if (scenario === "advanced version") actor.metadata.version = "2";
      if (scenario === "newer retained observation") {
        const observed = structuredClone(actor);
        observed.metadata.version = "2";
        observed.status = {
          state: "ACTOR_STATE_RESUMING",
          workerAssignment: { sandboxRuntime: f.config.runtime },
        };
        await f.database
          .client`UPDATE factory.runtime_attempt SET observation=${JSON.stringify(observed)}::jsonb WHERE id=${attemptID}`;
      }
      if (scenario === "worker assignment")
        actor.status.workerAssignment = { sandboxRuntime: f.config.runtime };
      if (scenario === "assigned node") actor.status.assignedNode = "owned-node";
      if (scenario === "assigned generation") actor.status.lastAssignedGeneration = 1;
      if (scenario === "snapshot") actor.status.snapshots = [{ uuid: crypto.randomUUID() }];
      if (scenario === "Source tag") actor.sourceTag = { snapshot: crypto.randomUUID() };
      if (scenario === "revoked Project authority")
        await f.database
          .client`DELETE FROM factory.project_membership WHERE project_id=${f.projectID} AND user_id=${f.userID}`;
      if (scenario === "Stop intent")
        await f.database
          .client`UPDATE factory.runtime_attempt SET state='stopping',stop_intended_at=now() WHERE id=${attemptID}`;
      if (scenario === "ready")
        await f.database
          .client`UPDATE factory.runtime_attempt SET state='ready',ready_at=now() WHERE id=${attemptID}`;
    });
    try {
      await expect(runtime.ensureStaging(f.projectID, f.userID)).rejects.toBe(failure);
      const state =
        scenario === "Stop intent" ? "stopping" : scenario === "ready" ? "ready" : "starting";
      const [attempt] = await f.database
        .client`SELECT state,failure FROM factory.runtime_attempt WHERE id=${attemptID}`;
      expect(attempt).toEqual({ state, failure: null });
      const facts = await f.database.client`
        SELECT * FROM factory.operation
        WHERE kind='runtime.actor_rpc' AND scope_type='runtime_attempt' AND scope_id=${attemptID}`;
      expect(facts).toHaveLength(1);
      expect(facts[0]?.["result"]).toBeNull();
      expect(facts[0]?.["payload"]?.["attemptedAt"]).toBeTruthy();
      // Re-reading the saved Staging owner cannot replay an uncertain Resume.
      if (
        ![
          "foreign Actor",
          "newer retained observation",
          "Source tag",
          "revoked Project authority",
          "Stop intent",
        ].includes(scenario)
      ) {
        expect(await runtime.ensureStaging(f.projectID, f.userID)).toMatchObject({
          id: attemptID,
          state,
          failure: null,
        });
        expect(
          await f.database.client`
            SELECT * FROM factory.operation
            WHERE kind='runtime.actor_rpc' AND scope_type='runtime_attempt' AND scope_id=${attemptID}`,
        ).toEqual(facts);
      }
      expect(
        await f.database.client`
          SELECT * FROM factory.operation WHERE kind='runtime.compute_wait'`,
      ).toHaveLength(0);
      expect(owned.creates.get("Actor")).toBe(1);
      expect(owned.counts()).toEqual({ resumes: 1, deletes: 0 });
    } finally {
      await owned.dispose();
    }
  },
  60_000,
);

test("native cold Parent handshake is admitted while its original Resume waits for the control wakeup", async () => {
  const owned = await isolatedFixture();
  const { f } = owned;
  const runtime = owned.controller();
  const held = owned.holdResume();
  const attemptID = runtimeIdentity(substrateStagingOwner(f.projectID), 1).attemptID;
  const started = runtime.ensureStaging(f.projectID, f.userID);
  let authorization: Promise<boolean> | undefined;
  try {
    await held.reached;
    const actor = nativeActor.parse(owned.objects(attemptID).get("Actor"));
    const tokens = runtimeConnectorTokens("owned-native-secret", attemptID, 1);
    const request = new Request("https://factory.test/internal/runtime-connect", {
      headers: {
        authorization: `Bearer ${tokens.parent}`,
        "x-factory-runtime-attempt": attemptID,
        "x-factory-runtime-generation": "1",
        "x-factory-connector-role": "parent",
        "x-factory-runtime-actor-uid": actor.metadata.uid,
      },
    });
    expect(f.hub.authorize(request, hashConnectorToken)).not.toBeNull();
    authorization = runtime.authorizeConnector(request);
    const outcome = await Promise.race([
      authorization,
      Bun.sleep(300).then(() => "blocked-by-resume" as const),
    ]);
    expect(outcome).toBe(true);
  } finally {
    held.release();
    await started;
    await authorization;
    await owned.dispose();
  }
});

test.each([
  "foreign Actor UID",
  "revoked Project authority",
  "new Stop intent",
  "checkpoint without original Resume dispatch",
  "foreign checkpoint without matching Resume",
] as const)(
  "native cold Parent handshake rejects %s without waiting for its held Resume or replaying RPCs",
  async (scenario) => {
    const owned = await isolatedFixture();
    const { f } = owned;
    const runtime = owned.controller();
    const held = owned.holdResume();
    const attemptID = runtimeIdentity(substrateStagingOwner(f.projectID), 1).attemptID;
    const started = runtime.ensureStaging(f.projectID, f.userID);
    let originalActor: ReturnType<typeof nativeActor.parse> | undefined;
    let authorization: Promise<boolean> | undefined;
    let restoreCheckpoint = false;
    const authorize = (request: Request) => {
      authorization = runtime.authorizeConnector(request);
      return Promise.race([authorization, Bun.sleep(300).then(() => "blocked-by-resume" as const)]);
    };
    const binding = () =>
      f.database
        .client`SELECT atespace,actor_name,binding_intent AS intent,actor_uid,create_attempted_at,create_rejected,delete_intended_at,deleted_at,observation,checkpoint FROM factory.runtime_attempt WHERE id=${attemptID}`;
    const facts = () =>
      f.database.client`SELECT * FROM factory.operation
        WHERE kind='runtime.actor_rpc' AND scope_type='runtime_attempt' AND scope_id=${attemptID}
        ORDER BY payload->>'action',payload->>'originKey'`;
    const source = () =>
      f.database.client.begin((sql) => substrateIsolatedSourceIn(sql, attemptID));
    const mutations = () => owned.calls.filter((method) => !method.startsWith("Get"));
    try {
      await held.reached;
      originalActor = nativeActor.parse(owned.objects(attemptID).get("Actor"));
      expect(originalActor.status.state).toBe("ACTOR_STATE_RESUMING");
      expect(originalActor.metadata.version).toBe("2");
      const tokens = runtimeConnectorTokens("owned-native-secret", attemptID, 1);
      const request = new Request("https://factory.test/internal/runtime-connect", {
        headers: {
          authorization: `Bearer ${tokens.parent}`,
          "x-factory-runtime-attempt": attemptID,
          "x-factory-runtime-generation": "1",
          "x-factory-connector-role": "parent",
          "x-factory-runtime-actor-uid": originalActor.metadata.uid,
        },
      });
      // Establish the exact admitted Source and successful control handshake
      // first. Only the adversarial fact below changes; no grant is fabricated.
      expect(await source()).toBe(`file://${owned.repo}`);
      expect(
        await f.database.client.begin((sql) => substrateIsolatedPrincipalIn(sql, attemptID)),
      ).toBe(f.userID);
      expect(f.hub.authorize(request, hashConnectorToken)).not.toBeNull();
      expect(await authorize(request)).toBe(true);
      const originalBinding = await binding();
      expect(originalBinding).toHaveLength(1);
      const expectedBinding = [...originalBinding];
      expect(originalBinding[0]).toMatchObject({
        actor_uid: originalActor.metadata.uid,
        checkpoint: null,
        observation: originalActor,
      });
      const originalFacts = await facts();
      expect(originalFacts).toHaveLength(1);
      expect(originalFacts[0]).toMatchObject({
        scope_id: attemptID,
        state: "attempted",
        result: null,
        completed_at: null,
        payload: {
          runtimeAttemptId: attemptID,
          action: "resume",
          originKey: "initial",
          actorUid: originalActor.metadata.uid,
          nativeVersion: "1",
          originCheckpoint: null,
          stopId: null,
        },
      });
      expect(originalFacts[0]?.["payload"]?.["attemptedAt"]).toBeTruthy();
      const originalCreates = new Map(owned.creates);
      const originalMutations = mutations();
      expect(owned.creates.get("Actor")).toBe(1);
      expect(owned.counts()).toEqual({ resumes: 1, deletes: 0 });
      const actor = structuredClone(originalActor);
      if (scenario === "foreign Actor UID") {
        const unbound = new Request(request);
        unbound.headers.set("x-factory-runtime-actor-uid", crypto.randomUUID());
        expect(f.hub.authorize(unbound, hashConnectorToken)).toBeNull();
        expect(await authorize(unbound)).toBe(false);
        // A valid original token/header cannot admit a replacement observed
        // under the original immutable Actor name either.
        actor.metadata.uid = crypto.randomUUID();
        owned.objects(attemptID).set("Actor", actor);
      } else if (scenario === "revoked Project authority") {
        await f.database.client`DELETE FROM factory.project_membership
          WHERE project_id=${f.projectID} AND user_id=${f.userID}`;
        await expect(source()).rejects.toThrow("Project not found");
      } else if (scenario === "new Stop intent") {
        await f.database.client`UPDATE factory.runtime_attempt
          SET state='stopping',stop_intended_at=now(),updated_at=now()
          WHERE id=${attemptID} AND stop_intended_at IS NULL`;
        await expect(source()).rejects.toThrow("Current native isolated Source grant");
      } else {
        const uuid = crypto.randomUUID();
        const checkpoint = nativeSnapshot.parse({
          uuid,
          generation: 1,
          owner: "SNAPSHOT_OWNER_ACTOR",
          fidelity: "SNAPSHOT_FIDELITY_ROOTFS",
          actorTemplateUid: originalBinding[0]?.["intent"].templateUID,
          sandboxRuntime: f.config.runtime,
          durableSnapshot: {
            state: "SNAPSHOT_STORAGE_STATE_COMPLETED",
            object: {
              snapshotUri: `s3://owned/atespaces/${actor.metadata.atespace}/actors/${actor.metadata.uid}/snapshots/${uuid}`,
            },
          },
        });
        actor.metadata.version = String(BigInt(actor.metadata.version) + 1n);
        actor.status.lastAssignedGeneration = checkpoint.generation;
        actor.status.snapshots = [checkpoint];
        owned.objects(attemptID).set("Actor", actor);
        if (scenario === "checkpoint without original Resume dispatch") {
          // Keep the immutable initial dispatch intact. A newly observed
          // checkpoint does not authorize a Resume that Factory never recorded.
          await f.database.client`UPDATE factory.runtime_attempt
            SET checkpoint=${JSON.stringify(checkpoint)}::jsonb
            WHERE id=${attemptID}`;
          restoreCheckpoint = true;
          expectedBinding[0] = { ...originalBinding[0], checkpoint };
          expect(await source()).toBe(`file://${owned.repo}`);
        }
        // Plausible native checkpoint metadata cannot supply the missing
        // original dispatch or replace the retained initial Resume origin.
        expect(
          await f.database.client`SELECT payload->>'originKey' AS origin_key FROM factory.operation
            WHERE kind='runtime.actor_rpc' AND scope_type='runtime_attempt' AND scope_id=${attemptID}
              AND payload->>'action'='resume'
              AND payload->>'originKey'=${checkpoint.uuid}`,
        ).toHaveLength(0);
      }
      const attemptBefore = await f.database
        .client`SELECT * FROM factory.runtime_attempt WHERE id=${attemptID}`;
      const nativeBefore = structuredClone(owned.objects(attemptID));
      expect(f.hub.authorize(request, hashConnectorToken)).not.toBeNull();
      expect(await authorize(request)).toBe(false);
      expect([...(await binding())]).toEqual(expectedBinding);
      expect(await facts()).toEqual(originalFacts);
      expect(
        await f.database.client`SELECT * FROM factory.runtime_attempt WHERE id=${attemptID}`,
      ).toEqual(attemptBefore);
      expect(owned.objects(attemptID)).toEqual(nativeBefore);
      expect(owned.creates).toEqual(originalCreates);
      expect(mutations()).toEqual(originalMutations);
      expect(owned.counts()).toEqual({ resumes: 1, deletes: 0 });
      if (scenario === "new Stop intent") {
        expect(attemptBefore[0]?.["state"]).toBe("stopping");
        expect(attemptBefore[0]?.["stop_intended_at"]).not.toBeNull();
      }
    } finally {
      if (originalActor) owned.objects(attemptID).set("Actor", originalActor);
      try {
        if (restoreCheckpoint)
          await f.database.client`UPDATE factory.runtime_attempt
            SET checkpoint=NULL WHERE id=${attemptID}`;
      } finally {
        held.release();
        try {
          await Promise.all([started, authorization]);
        } finally {
          await owned.dispose();
        }
      }
    }
  },
  60_000,
);

test("native initial Staging retains original creates, serves only its bootstrap Source and starts a new generation only after UID-confirmed Stop", async () => {
  const owned = await isolatedFixture();
  const previous = process.env["FACTORY_REGISTRY_CA_FILE"];
  const { f } = owned;
  const runtime = owned.controller();
  const attemptID = runtimeIdentity(substrateStagingOwner(f.projectID), 1).attemptID;
  const workspaces = await f.database.client`SELECT * FROM factory.development_workspace`;
  try {
    const registryCA =
      "-----BEGIN CERTIFICATE-----\nowned-extra-registry-ca\n-----END CERTIFICATE-----\n";
    const registryCAFile = join(owned.repo, "../registry-ca.pem");
    await writeFile(registryCAFile, registryCA);
    process.env["FACTORY_REGISTRY_CA_FILE"] = registryCAFile;
    await expect(runtime.ensureStaging(f.projectID, crypto.randomUUID())).rejects.toThrow();
    expect(owned.creates.size).toBe(0);
    owned.lose("CreateAtespace");
    await expect(runtime.ensureStaging(f.projectID, f.userID)).rejects.toThrow(
      "owned lost native reply",
    );
    // Later working-tree edits cannot replace the exact committed native input.
    await writeFile(join(owned.repo, nativeProjectTemplate.path), "{uncommitted invalid template");
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
    expect(
      await f.database.client.begin((sql) => substrateIsolatedPrincipalIn(sql, attemptID)),
    ).toBe(f.userID);
    await expect(
      f.database.client.begin((sql) => substrateIsolatedPrincipalIn(sql, f.attemptID)),
    ).rejects.toThrow("isolated execution principal is unavailable");
    expect(owned.creates.get("Actor")).toBe(1);
    expect(owned.creates.get("Atespace")).toBe(1);
    expect(owned.counts().resumes).toBe(1);
    const [declaration] = await f.database.client`
      SELECT payload->'declaration' AS declaration FROM factory.operation
      WHERE kind='runtime.staging_configuration' AND scope_type='runtime_attempt'
        AND scope_id=${attemptID}
        AND idempotency_key=${`runtime.staging_configuration:${attemptID}`}`;
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
      .client`SELECT intent FROM factory.substrate_provision WHERE runtime_attempt_id=${attemptID}`;
    expect(intent?.["intent"].projectTemplate).toEqual(nativeProjectTemplate);
    const objects = owned.objects(attemptID);
    const originalImage = owned.config.workloadImage;
    owned.config.workloadImage = `registry.test/native@sha256:${"b".repeat(64)}`;
    expect((await owned.controller().get(attemptID))?.native?.actorUID).toBe(
      nativeActor.parse(objects.get("Actor")).metadata.uid,
    );
    const originalTemplate = objects.get("ActorTemplate");
    if (!originalTemplate) throw new Error("Original native template is missing");
    const bootstrap = JSON.parse(
      (originalTemplate["containers"] as { env: { value: string }[] }[])[0]?.env[0]?.value ??
        "null",
    );
    const factoryCA = await Bun.file(owned.config.factoryCAFile).text();
    expect(bootstrap.factoryCA).toBe(`${factoryCA.trimEnd()}\n${registryCA}`);
    expect((originalTemplate["containers"] as { image: string }[])[0]?.image).toBe(originalImage);
    expect((await runtime.ensureStaging(f.projectID, f.userID))?.id).toBe(attemptID);
    expect(owned.counts().resumes).toBe(1);
    await expect(
      Promise.resolve(
        f.database
          .client`UPDATE factory.substrate_provision SET resources=jsonb_set(resources,'{atespace,attemptedAt}','null'::jsonb) WHERE runtime_attempt_id=${attemptID}`,
      ),
    ).rejects.toThrow("immutable");
    const stopped = await runtime.stop(attemptID);
    expect(stopped?.state).toBe("stopped");
    await expect(
      f.database.client.begin((sql) => substrateIsolatedPrincipalIn(sql, attemptID)),
    ).rejects.toThrow("isolated execution principal is unavailable");
    expect(owned.counts().deletes).toBe(1);
    const successorID = runtimeIdentity(substrateStagingOwner(f.projectID), 2).attemptID;
    expect((await owned.controller().ensureStaging(f.projectID, f.userID))?.id).toBe(successorID);
    expect(owned.creates.get("Actor")).toBe(2);
    expect(
      (
        await f.database
          .client`SELECT intent FROM factory.substrate_provision WHERE runtime_attempt_id=${attemptID}`
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
    if (previous === undefined) delete process.env["FACTORY_REGISTRY_CA_FILE"];
    else process.env["FACTORY_REGISTRY_CA_FILE"] = previous;
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
  process.env["FACTORY_FORGEJO_API_URL"] = `${owned.forgeURL}/api/v1/`;
  process.env["FACTORY_FORGEJO_PUBLIC_URL"] = "https://git.native.test";
  const publicationID = crypto.randomUUID();
  const releaseID = crypto.randomUUID();
  const attemptID = runtimeIdentity(publicationID, 1).attemptID;
  const revision = owned.revision;
  const repository = `${owned.forgeURL}/${process.env["FACTORY_FORGEJO_OWNER"]}/publication.git`;
  const runnerUUID = crypto.randomUUID();
  try {
    await f.database
      .client`UPDATE factory.project SET repository_url=${repository} WHERE id=${f.projectID}`;
    await f.database
      .client`INSERT INTO factory.project_release(id,project_id,command_id,version,commit_sha,notes,state,created_by)
      VALUES(${releaseID},${f.projectID},${crypto.randomUUID()},'1.2.3',${revision},'Owned controller fixture','running',${f.userID})`;
    const publicationCommandID = crypto.randomUUID();
    await f.database
      .client`INSERT INTO factory.operation(id,kind,scope_type,scope_id,idempotency_key,active_key,state,payload,created_by)
      VALUES(${publicationID},'releases.attempt','project_release',${releaseID},${`releases.attempt:${publicationCommandID}`},
        ${`releases.attempt.ordinal:${releaseID}:1`},'running',
        ${JSON.stringify({
          id: publicationID,
          releaseId: releaseID,
          commandId: publicationCommandID,
          ordinal: 1,
          dispatchIntendedAt: new Date().toISOString(),
          runId: 1,
          runnerId: null,
          runnerUuid: runnerUUID,
          runnerToken: "owned-private-publication-token",
          jobHandle: "owned-original-publication-job",
          runtimeAttemptId: null,
          cleanedAt: null,
        })}::jsonb,${f.userID})`;
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
    expect(
      await f.database.client.begin((sql) => substrateIsolatedPrincipalIn(sql, attemptID)),
    ).toBe(f.userID);
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
    const [environment] = await f.database.client`
      SELECT payload->>'environment' AS environment,
        (payload->>'version')::float8 AS version,payload->>'secretKey' AS "secretKey"
      FROM factory.operation
      WHERE kind='runtime.environment_intent' AND scope_type='runtime_attempt'
        AND scope_id=${attemptID}
        AND idempotency_key=${`runtime.environment_intent:${attemptID}`}`;
    expect(environment).toEqual({ environment: "development", version: 0, secretKey: null });
    const [provision] = await f.database
      .client`SELECT intent FROM factory.substrate_provision WHERE runtime_attempt_id=${attemptID}`;
    expect(provision?.["intent"].projectTemplate).toEqual(nativeProjectTemplate);
    expect(JSON.stringify(provision)).not.toContain("owned-private-publication-token");
    expect(JSON.stringify(provision)).not.toContain("parentToken");
    expect(await f.database.client.begin((sql) => substrateIsolatedSourceIn(sql, attemptID))).toBe(
      repository,
    );
    const expired = owned.controller(async () => {
      throw new SubstrateRPCError("Unauthenticated", "expired provisioner");
    });
    expect((await expired.startPublication(publicationID, f.userID))?.id).toBe(attemptID);
    expect(owned.counts().resumes).toBe(1);
    await f.database
      .client`UPDATE factory.operation SET state='succeeded', updated_at=now() WHERE id=${publicationID} AND kind='releases.attempt'`;
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

test.each(["missing", "pending", "passed", "capacity-refused", "unknown-resume"] as const)(
  "native promotion rechecks independent review %s and retains the previous Preview until Connector readiness",
  async (scenario) => {
    const reviewState =
      scenario === "capacity-refused" || scenario === "unknown-resume" ? "passed" : scenario;
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
        .client`INSERT INTO factory.verification(id,change_id,commit_sha,pull_request_number,state,action_run_id,created_by,completed_at)
      VALUES(${verificationID},${f.changeID},${owned.revision},1,'succeeded',1,${f.userID},now())`;
      if (reviewState !== "missing")
        await f.database
          .client`INSERT INTO factory.candidate_review(id,verification_id,change_id,commit_sha,base_sha,created_by,state,result,completed_at)
        VALUES(${reviewID},${verificationID},${f.changeID},${owned.revision},${"a".repeat(40)},${f.userID},${reviewState},
            ${reviewState === "passed" ? '{"verdict":"passed"}' : null}::jsonb,
            CASE WHEN ${reviewState === "passed"} THEN now() ELSE NULL END)`;
      await f.database
        .client`INSERT INTO factory.delivery_approval(id,change_id,verification_id,commit_sha,approved_by,candidate_review_id)
      VALUES(${approvalID},${f.changeID},${verificationID},${owned.revision},${f.userID},${reviewState === "missing" ? null : reviewID})`;
      await f.database.client`INSERT INTO factory.operation(
        id,kind,scope_type,scope_id,idempotency_key,active_key,state,payload,result,created_by,completed_at)
      VALUES(${crypto.randomUUID()},'delivery.merge','change',${f.changeID},
        ${`delivery.merge:owned-merge:${promotionID}`},NULL,'succeeded',
        jsonb_build_object(
          'changeId',${f.changeID}::text,'commitSha',${owned.revision}::text,'baseSha',${"a".repeat(40)}::text,
          'pullRequestNumber',1,'approvalId',${approvalID}::text,'deliveryPolicyId',NULL::text
        ),
        jsonb_build_object('mergeSha',${owned.revision}::text),${f.userID},now())`;
      await f.database.client`INSERT INTO factory.operation(
        id,kind,scope_type,scope_id,idempotency_key,active_key,state,payload,created_by)
      VALUES(${promotionID},'delivery.promotion','change',${f.changeID},
        ${`delivery.promotion:${f.changeID}:1`},${`delivery.promotion:${f.projectID}`},'pending',
        jsonb_build_object(
          'changeId',${f.changeID}::text,'projectId',${f.projectID}::text,
          'commitSha',${owned.revision}::text,'previousRuntimeAttemptId',${original.id}::text,
          'replacementRuntimeAttemptId',NULL::text,'ordinal',1,
          'supersedesId',NULL::text,'retryCommandId',NULL::text
        ),${f.userID})`;
      const before = owned.creates.get("Actor");
      if (reviewState !== "passed") {
        await expect(runtime.startStagingReplacement(promotionID, f.userID)).rejects.toThrow(
          "approved exact-commit",
        );
        expect(owned.creates.get("Actor")).toBe(before);
        expect(
          (
            await f.database
              .client`SELECT payload->>'runtimeAttemptId' AS runtime_attempt_id FROM factory.operation WHERE kind='delivery.staging_preview' AND scope_type='project' AND scope_id=${f.projectID}`
          )[0]?.["runtime_attempt_id"],
        ).toBe(original.id);
        return;
      }
      let retiredBranches = 0;
      let replacementStarts = 0;
      const promote = createDeliveryPromotion(
        f.database,
        {
          ...runtime,
          async startStagingReplacement(id, userID) {
            replacementStarts++;
            return runtime.startStagingReplacement(id, userID);
          },
        },
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
      if (scenario === "capacity-refused" || scenario === "unknown-resume") {
        const failure = new SubstrateRPCError(
          scenario === "capacity-refused" ? "ResourceExhausted" : "Unavailable",
          "owned Staging Resume failure",
        );
        owned.failResume(failure);
        await expect(promote(change, { owner: "owned", name: "staging" })).rejects.toBe(failure);
        const replacementID = runtimeIdentity(promotionID, 1).attemptID;
        const facts = await f.database.client`
          SELECT * FROM factory.operation
          WHERE kind='runtime.actor_rpc' AND scope_type='runtime_attempt' AND scope_id=${replacementID}`;
        const intent = await f.database
          .client`SELECT * FROM factory.substrate_provision WHERE runtime_attempt_id=${replacementID}`;
        expect(await runtime.get(replacementID)).toMatchObject({
          state: scenario === "capacity-refused" ? "failed" : "starting",
          failure: scenario === "capacity-refused" ? expect.stringContaining("capacity") : null,
        });
        await promote(change, { owner: "owned", name: "staging" });
        const [promotion] = await f.database.client`
          SELECT state,error AS last_error,
            payload->>'replacementRuntimeAttemptId' AS replacement_runtime_attempt_id
          FROM factory.operation WHERE id=${promotionID} AND kind='delivery.promotion'`;
        expect(promotion).toEqual({
          state: scenario === "capacity-refused" ? "failed" : "starting",
          last_error:
            scenario === "capacity-refused" ? "Replacement Staging failed before readiness" : null,
          replacement_runtime_attempt_id: replacementID,
        });
        expect(
          (
            await f.database
              .client`SELECT payload->>'runtimeAttemptId' AS runtime_attempt_id FROM factory.operation WHERE kind='delivery.staging_preview' AND scope_type='project' AND scope_id=${f.projectID}`
          )[0]?.["runtime_attempt_id"],
        ).toBe(original.id);
        expect((await runtime.get(original.id))?.state).toBe("starting");
        expect(
          await f.database.client`
            SELECT * FROM factory.operation
            WHERE kind='runtime.actor_rpc' AND scope_type='runtime_attempt' AND scope_id=${replacementID}`,
        ).toEqual(facts);
        expect(
          await f.database
            .client`SELECT * FROM factory.substrate_provision WHERE runtime_attempt_id=${replacementID}`,
        ).toEqual(intent);
        expect(replacementStarts).toBe(1);
        expect(retiredBranches).toBe(0);
        expect(owned.creates.get("Actor")).toBe(2);
        expect(owned.counts()).toEqual({ resumes: 2, deletes: 0 });
        const commandID = crypto.randomUUID();
        const retry = () =>
          retryPromotion(
            f.database,
            f.changeID,
            f.userID,
            commandID,
            promotionID,
            async () => owned.revision,
          );
        await expect(retry()).rejects.toThrow("cleanup are confirmed");
        if (scenario === "capacity-refused") {
          const merge = await f.database.client`
            SELECT * FROM factory.operation
            WHERE kind='delivery.merge' AND scope_type='change' AND scope_id=${f.changeID}`;
          expect((await runtime.stop(replacementID))?.state).toBe("stopped");
          owned.allowResume();
          expect(await retry()).toBe(true);
          await promote(change, { owner: "owned", name: "staging" });
          const successor = await runtime.get(runtimeIdentity(commandID, 1).attemptID);
          expect(successor?.state).toBe("starting");
          expect(successor?.native?.actorUID).not.toBe(facts[0]?.["payload"]?.["actorUid"]);
          expect(replacementStarts).toBe(2);
          expect(owned.counts()).toEqual({ resumes: 3, deletes: 1 });
          expect(
            await f.database.client`
              SELECT * FROM factory.operation
              WHERE kind='runtime.actor_rpc' AND scope_type='runtime_attempt' AND scope_id=${replacementID}`,
          ).toEqual(facts);
          expect(
            await f.database
              .client`SELECT * FROM factory.substrate_provision WHERE runtime_attempt_id=${replacementID}`,
          ).toEqual(intent);
          expect(
            await f.database.client`
              SELECT * FROM factory.operation
              WHERE kind='delivery.merge' AND scope_type='change' AND scope_id=${f.changeID}`,
          ).toEqual(merge);
        }
        return;
      }
      const replacement = await runtime.startStagingReplacement(promotionID, f.userID);
      if (!replacement) throw new Error("Native replacement is missing");
      expect(replacement.id).toBe(runtimeIdentity(promotionID, 1).attemptID);
      expect(replacement.state).toBe("starting");
      await promote(change, { owner: "owned", name: "staging" });
      expect(
        (
          await f.database
            .client`SELECT payload->>'runtimeAttemptId' AS runtime_attempt_id FROM factory.operation WHERE kind='delivery.staging_preview' AND scope_type='project' AND scope_id=${f.projectID}`
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
            .client`SELECT payload->>'runtimeAttemptId' AS runtime_attempt_id FROM factory.operation WHERE kind='delivery.staging_preview' AND scope_type='project' AND scope_id=${f.projectID}`
        )[0]?.["runtime_attempt_id"],
      ).toBe(replacement.id);
      expect(
        (
          await f.database.client`
            SELECT state FROM factory.operation WHERE id=${promotionID} AND kind='delivery.promotion'`
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
