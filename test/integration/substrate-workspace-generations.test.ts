import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRuntimeController } from "../../apps/factory/src/runtime/controller";
import {
  substrateWorkspaceGrantIn,
  substrateWorkspaceRevisionIn,
} from "../../apps/factory/src/runtime/substrate-grant";
import {
  createSubstrateWorkspaces,
  type SubstrateWorkspaceConfiguration,
} from "../../apps/factory/src/runtime/substrate-workspaces";
import { objectDigest } from "../../apps/factory/src/storage/objects";
import { createWorkspaceSharing } from "../../apps/factory/src/workspace/sharing";
import {
  createSubstrateSources,
  type SubstrateSourceHandoff,
} from "../../apps/factory/src/workspace/substrate-source";
import { runtimeConnectorTokens } from "../../packages/runtime-domain/src/identity";
import {
  nativeActor,
  type SubstrateCall,
  SubstrateRPCError,
} from "../../packages/runtime-kubernetes/src/substrate-control";
import { eventually } from "../fixtures/factory-process";
import { memoryPrivateObjects } from "../fixtures/private-objects";
import { substrateFixture } from "../fixtures/substrate";

async function proveGenerations(kind: "personal" | "ticket") {
  const base = "a".repeat(40);
  let submitted = "d".repeat(40);
  const f = await substrateFixture(base, kind);
  const recordSubmission = (revision: string, sequence: number, state = "succeeded") =>
    f.database.client`INSERT INTO factory.change_commit_operation(
        id,change_id,runtime_attempt_id,sequence,branch_name,expected_parent_sha,commit_sha,
        observed_remote_sha,commit_message,idempotency_key,state,source,created_by,completed_at)
        SELECT ${crypto.randomUUID()},id,runtime_attempt_id,${sequence},branch_name,base_sha,${revision},
          ${revision},'Owned saved checkout',${`generation:${f.changeID}:${sequence}`},${state},'workspace',${f.userID},now()
        FROM factory.change WHERE id=${f.changeID}`;
  if (kind === "ticket")
    await f.database
      .client`UPDATE factory.change_writer SET state='human',epoch=2,user_id=${f.userID} WHERE change_id=${f.changeID}`;
  const directory = await mkdtemp(join(tmpdir(), "factory-generation-"));
  const ca = join(directory, "ca.pem");
  await writeFile(
    ca,
    "-----BEGIN CERTIFICATE-----\ncontrolled fixture\n-----END CERTIFICATE-----\n",
  );
  const secret = "owned-generation-secret";
  const config: SubstrateWorkspaceConfiguration = {
    deployment: "fresh-workspaces",
    database: f.config.database,
    projectID: f.projectID,
    connection: f.config.connection,
    provisioner: f.config.connection,
    editorPrincipal: "user:system:serviceaccount:owned:factory-control",
    connectorURL: f.config.connectorURL,
    factoryCAFile: ca,
    workloadImage: `registry.test/native@sha256:${"a".repeat(64)}`,
    profile: f.config.profile,
    runtime: f.config.runtime,
    workerSelector: {
      "factory.runtime/profile": f.config.profile,
      "factory.dev/deployment": "owned",
    },
    egressHosts: [],
  };
  const objects = new Map<string, Record<string, unknown>>();
  const creates: string[] = [];
  let loseDelete = true;
  let loseCreate = false;
  let independent = true;
  let latestBytes = new TextEncoder().encode("original saved Source");
  const bundle = () => ({
    version: 1,
    bytes: latestBytes.length,
    sha256: objectDigest(latestBytes),
    chunks: [objectDigest(latestBytes)],
  });
  const blobs = memoryPrivateObjects();
  const source = createSubstrateSources(f.database, f.hub, blobs);
  f.hub.sourceConnected = () => true;
  f.hub.parentOperation = async () => ({});
  f.hub.request = async (_attempt, _channel, request, path) => {
    if (path.endsWith("/checkpoint")) return Response.json(bundle());
    if (path.endsWith("/chunk")) return new Response(latestBytes);
    throw new Error(`Unexpected controlled Source request ${request.method} ${path}`);
  };
  // Controlled Source-service observations, not Linux materialization or a live
  // Substrate proof. The actual lease constraints and restore endpoint run here.
  const sources: SubstrateSourceHandoff = {
    async attach(workspaceID, actorUID, sql) {
      const previous = await source.lease(workspaceID, sql);
      if (!previous || previous.actorUID === actorUID) {
        await source.attach(workspaceID, actorUID, sql);
        return;
      }
      const id = crypto.randomUUID();
      const saved = {
        id,
        workspaceID,
        actorUID: previous.actorUID,
        writerEpoch: previous.writerEpoch + 1,
        generation: previous.generation + 1,
        bundle: bundle(),
      };
      await blobs.put(
        `workspace-source/v1/${workspaceID}/${id}/chunk-0`,
        latestBytes,
        "application/octet-stream",
      );
      await blobs.put(
        `workspace-source/v1/${workspaceID}/${id}/manifest.json`,
        new TextEncoder().encode(JSON.stringify(saved)),
        "application/json",
      );
      await sql`UPDATE factory.substrate_source SET writable=false,writer_epoch=writer_epoch+1,checkpoint_id=${id} WHERE workspace_id=${workspaceID}`;
      await sql`UPDATE factory.substrate_source SET generation=generation+1,checkpoint=${JSON.stringify(saved)}::text::jsonb WHERE workspace_id=${workspaceID}`;
      await sql`UPDATE factory.substrate_source SET owner='actor',actor_uid=${actorUID},writer_epoch=writer_epoch+1,writable=true,checkpoint_id=NULL WHERE workspace_id=${workspaceID}`;
    },
    freezeActor: source.freezeActor,
    async paused(workspaceID, sql) {
      const row = await source.lease(workspaceID, sql);
      if (row?.owner === "actor")
        await sql`UPDATE factory.substrate_source SET owner='service',writer_epoch=writer_epoch+1,
          writable=true,service_base=checkpoint_id,checkpoint_id=NULL WHERE workspace_id=${workspaceID}`;
    },
    async resume() {},
    async requireIndependent(workspaceID, actorUID, sql) {
      const row = await source.lease(workspaceID, sql);
      if (
        !independent ||
        row?.actorUID !== actorUID ||
        row.owner !== "service" ||
        !row.writable ||
        !row.checkpoint
      )
        throw new Error("Controlled independent Source is unavailable");
    },
  };
  const call: SubstrateCall = async (method, input) => {
    const request = input as Record<string, Record<string, unknown>>;
    let kind = method.replace(/^(Get|Create)/, "");
    const payload = request["actorTemplate"] ?? request["actor"] ?? request["atespace"];
    const metadata = payload?.["metadata"] as { atespace?: string; name: string } | undefined;
    const space =
      metadata?.atespace ?? metadata?.name ?? payload?.["atespace"] ?? payload?.["name"];
    const key = `${kind}:${String(space)}`;
    if (method.startsWith("Get")) {
      const value = objects.get(key);
      if (!value) throw new SubstrateRPCError("NotFound", "absent");
      return structuredClone(value);
    }
    if (method.startsWith("Create")) {
      if (objects.has(key)) throw new Error("Controlled native name was reused");
      const value =
        kind === "AtespaceAccessPolicy"
          ? request["accessPolicy"]
          : kind === "ActorEgressPolicy"
            ? request["egressPolicy"]
            : payload;
      if (!value) throw new Error("Missing native declaration");
      const declaredMetadata = value["metadata"] as { name: string; atespace?: string };
      const actual = {
        ...value,
        metadata: {
          name: declaredMetadata.name,
          uid: crypto.randomUUID(),
          version: "1",
          createTime: new Date().toISOString(),
          ...(declaredMetadata.atespace ? { atespace: declaredMetadata.atespace } : {}),
        },
        ...(kind === "Actor" ? { status: { state: "ACTOR_STATE_SUSPENDED" } } : {}),
      };
      objects.set(key, actual);
      creates.push(key);
      if (kind === "Actor" && loseCreate) {
        loseCreate = false;
        throw new SubstrateRPCError("Unavailable", "lost successor Create reply");
      }
      return structuredClone(actual);
    }
    const actorRef = request["actor"];
    kind = "Actor";
    const actorKey = `${kind}:${String(actorRef?.["atespace"])}`;
    const actor = nativeActor.parse(objects.get(actorKey));
    actor.metadata.version = String(BigInt(actor.metadata.version) + 1n);
    if (method === "ResumeActor") {
      actor.status = {
        ...actor.status,
        state: "ACTOR_STATE_RUNNING",
        workerAssignment: { sandboxRuntime: config.runtime },
      };
      objects.set(actorKey, actor);
      return { actor: structuredClone(actor) };
    }
    if (method === "SuspendActor") {
      const template = objects.get(`ActorTemplate:${String(actorRef?.["atespace"])}`);
      const templateMetadata = template?.["metadata"] as { uid: string };
      const uuid = crypto.randomUUID();
      const generation = (actor.status.lastAssignedGeneration ?? 0) + 1;
      actor.status = {
        state: "ACTOR_STATE_SUSPENDED",
        lastAssignedGeneration: generation,
        snapshots: [
          {
            uuid,
            generation,
            owner: "SNAPSHOT_OWNER_ACTOR",
            fidelity: "SNAPSHOT_FIDELITY_ROOTFS",
            actorTemplateUid: templateMetadata.uid,
            sandboxRuntime: config.runtime,
            durableSnapshot: {
              state: "SNAPSHOT_STORAGE_STATE_COMPLETED",
              object: {
                snapshotUri: `s3://owned/prefix/atespaces/${actor.metadata.atespace}/actors/${actor.metadata.uid}/snapshots/${uuid}`,
              },
            },
          },
        ],
      };
      objects.set(actorKey, actor);
      return { actor: structuredClone(actor) };
    }
    if (method === "DeleteActor") {
      objects.delete(actorKey);
      if (loseDelete) {
        loseDelete = false;
        throw new SubstrateRPCError("Unavailable", "lost predecessor Delete reply");
      }
      return actor;
    }
    throw new Error(`Unexpected native operation ${method}`);
  };
  const contractRevisions: string[] = [];
  let submitDuringContractRead = false;
  const workspaces = createSubstrateWorkspaces(
    f.database,
    f.hub,
    secret,
    config,
    call,
    call,
    async (_repository, revision) => {
      contractRevisions.push(revision);
      if (submitDuringContractRead) {
        submitDuringContractRead = false;
        submitted = "f".repeat(40);
        await recordSubmission(submitted, 3);
      }
      return {
        version: 1,
        primaryApp: "web",
        apps: [
          {
            id: "web",
            label: "Owned",
            command: ["node", "server.mjs"],
            port: 4300,
            healthPath: "/",
          },
        ],
      };
    },
    sources,
  );
  const start = (userID = f.userID) =>
    kind === "ticket"
      ? workspaces.start(userID, f.changeID)
      : workspaces.start(userID, undefined, f.workspaceID);
  try {
    expect(
      await f.database.client.begin((sql) => substrateWorkspaceRevisionIn(sql, f.workspaceID)),
    ).toBe(base);
    const firstID = await start();
    expect(firstID).toBe(f.attemptID);
    const first = await workspaces.forAttempt(firstID);
    if (!first) throw new Error("First native owner is missing");
    const firstNative = await first.get();
    const oldUID = firstNative.actorUID;
    if (!oldUID) throw new Error("First native Actor is missing");
    await f.database
      .client`UPDATE factory.runtime_attempt SET state='ready',ready_at=now() WHERE id=${firstID}`;
    await expect(first.stop()).rejects.toThrow("lost predecessor Delete reply");
    await expect(start()).rejects.toThrow("retired");
    expect(creates).toHaveLength(5);
    await first.stop();
    if (kind === "ticket") {
      await recordSubmission(submitted, 1);
      await recordSubmission("e".repeat(40), 2, "failed");
      expect(
        await f.database.client.begin((sql) => substrateWorkspaceRevisionIn(sql, f.workspaceID)),
      ).toBe(submitted);
    }
    const original = await f.database
      .client`SELECT row_to_json(b) AS binding FROM factory.substrate_binding b WHERE runtime_attempt_id=${firstID}`;
    independent = false;
    await expect(start()).rejects.toThrow("independent Source");
    expect(creates).toHaveLength(5);
    independent = true;
    latestBytes = new TextEncoder().encode("saved edits made after Stop");
    const collaborator = crypto.randomUUID();
    await f.database
      .client`INSERT INTO auth."user"(id,name,email) VALUES(${collaborator},'Collaborator',${`${collaborator}@factory.invalid`})`;
    await f.database
      .client`INSERT INTO factory.project_membership(project_id,user_id,role,updated_by)
      VALUES(${f.projectID},${collaborator},'developer',${f.userID})`;
    if (kind === "personal")
      await createWorkspaceSharing(f.database, () => {}).decide(f.userID, {
        commandID: crypto.randomUUID(),
        workspaceID: f.workspaceID,
        userID: collaborator,
        permission: "collaborate",
        expectedVersion: 0,
      });
    const nextUser = kind === "personal" ? collaborator : f.userID;
    if (kind === "ticket") {
      submitDuringContractRead = true;
      await expect(start(nextUser)).rejects.toThrow(
        "execution revision changed before native provisioning",
      );
      expect(contractRevisions.at(-1)).toBe("d".repeat(40));
      expect(creates).toHaveLength(5);
      expect(
        await f.database
          .client`SELECT generation FROM factory.substrate_workspace WHERE workspace_id=${f.workspaceID} AND generation=2`,
      ).toHaveLength(0);
    }
    loseCreate = true;
    await expect(start(nextUser)).rejects.toThrow("lost successor Create reply");
    const secondID = await start(nextUser);
    expect(secondID).not.toBe(firstID);
    expect(creates).toHaveLength(10);
    const second = await workspaces.forAttempt(secondID);
    if (!second) throw new Error("Successor native owner is missing");
    const newUID = (await second.get()).actorUID;
    expect(newUID).not.toBe(oldUID);
    const token = runtimeConnectorTokens(secret, secondID, 2).parent;
    const request = (extra: Record<string, string> = {}) =>
      new Request(`https://factory.test/internal/substrate-source/${secondID}`, {
        headers: {
          authorization: `Bearer ${token}`,
          "X-Factory-Runtime-Actor-UID": newUID ?? "",
          "X-Factory-Runtime-Generation": "2",
          ...extra,
        },
      });
    const restored = await source.restoreEndpoint(request(), secondID);
    expect(restored.status).toBe(200);
    const restore = await restored.json();
    expect(restore.actorUID).toBe(newUID);
    expect(restore.checkpointActorUID).toBe(oldUID);
    expect(restore.checkpoint.bundle.sha256).toBe(objectDigest(latestBytes));
    expect(restore.writerEpoch).toBe(5);
    expect(
      (await source.restoreEndpoint(request({ "X-Factory-Runtime-Generation": "1" }), secondID))
        .status,
    ).toBe(403);
    expect((await source.restoreEndpoint(request(), firstID)).status).toBe(403);
    expect(
      await f.database
        .client`SELECT row_to_json(b) AS binding FROM factory.substrate_binding b WHERE runtime_attempt_id=${firstID}`,
    ).toEqual(original);
    const revision = kind === "ticket" ? submitted : base;
    const attempts = await f.database
      .client`SELECT generation,created_by,revision FROM factory.runtime_attempt WHERE workspace_id=${f.workspaceID} ORDER BY generation`;
    expect([...attempts]).toEqual([
      { generation: "1", created_by: f.userID, revision: base },
      { generation: "2", created_by: nextUser, revision },
    ]);
    const { projectID, ...installation } = config;
    const inventory = createRuntimeController(f.database, f.hub, secret, {
      configuration: installation,
      call,
      provisionerCall: call,
      sources,
    });
    expect(
      (await inventory.list(projectID, f.userID))
        .filter((row) => row.workspaceId === f.workspaceID)
        .map((row) => row.id),
    ).toEqual([secondID]);
    expect(
      (await inventory.list(undefined, f.userID))
        .filter((row) => row.workspaceId === f.workspaceID)
        .map((row) => row.id)
        .sort(),
    ).toEqual([firstID, secondID].sort());
    expect(contractRevisions.at(-1)).toBe(revision);
    expect(
      (
        await f.database.client<
          { source_revision: string }[]
        >`SELECT source_revision FROM factory.development_workspace WHERE id=${f.workspaceID}`
      )[0]?.source_revision,
    ).toBe(base);
    const successor = (
      await f.database.client<
        { intent: { revision: string } }[]
      >`SELECT intent FROM factory.substrate_workspace WHERE workspace_id=${f.workspaceID} AND generation=2`
    )[0]?.intent;
    expect(successor?.revision).toBe(revision);
    expect((await first.get()).state).toBe("deleted");
    const provisions = await f.database
      .client`SELECT generation FROM factory.substrate_workspace WHERE workspace_id=${f.workspaceID} ORDER BY generation`;
    expect([...provisions]).toEqual([{ generation: "1" }, { generation: "2" }]);
    await expect(
      Promise.resolve(f.database.client`
      INSERT INTO factory.substrate_workspace(workspace_id,generation,intent)
      SELECT workspace_id,3,intent FROM factory.substrate_workspace
      WHERE workspace_id=${f.workspaceID} AND generation=2`),
    ).rejects.toThrow("exact cleanup and independent Source");
    const lease = await source.lease(f.workspaceID);
    await expect(
      source.attach(f.workspaceID, crypto.randomUUID(), f.database.client),
    ).rejects.toMatchObject({
      cause: { message: expect.stringContaining("current original Actor binding") },
    });
    expect(await source.lease(f.workspaceID)).toEqual(lease);
    await expect(
      Promise.resolve(f.database.client`
      UPDATE factory.substrate_source SET actor_uid=${crypto.randomUUID()}
      WHERE workspace_id=${f.workspaceID}`),
    ).rejects.toThrow("confirmed stopped predecessor");
  } finally {
    await source.close();
    await f.dispose();
    await rm(directory, { recursive: true, force: true });
  }
}

test.each(["personal", "ticket"] as const)(
  "native %s Workspace generations retain old identities and start from the latest submitted revision and confirmed Source",
  proveGenerations,
  60_000,
);

test("a human Ticket Start rechecks a concurrent Agent Stop after the existing Change lock", async () => {
  const f = await substrateFixture("a".repeat(40), "ticket");
  const blocker = f.database.coordination();
  const pidReady = Promise.withResolvers<number>();
  let waiting: Promise<string> | undefined;
  let locked = false;
  try {
    await f.database.client.begin(async (sql) => {
      await sql`INSERT INTO factory.substrate_workspace(workspace_id,intent) VALUES(${f.workspaceID},'{}')`;
      await sql`INSERT INTO factory.runtime_attempt(id,project_id,workspace_id,change_id,generation,revision,
        state,parent_connector_token_hash,child_connector_token_hash,create_intended_at,created_by)
        VALUES(${f.attemptID},${f.projectID},${f.workspaceID},${f.changeID},1,${"a".repeat(40)},
          'create-intended',${"b".repeat(64)},${"c".repeat(64)},now(),${f.userID})`;
      await sql`INSERT INTO factory.substrate_binding(runtime_attempt_id,atespace,actor_name,intent)
        VALUES(${f.attemptID},${f.atespace},${`runtime-${f.attemptID.replaceAll("-", "")}`},'{}')`;
      await sql`UPDATE factory.runtime_attempt SET state='ready' WHERE id=${f.attemptID}`;
      await sql`UPDATE factory.change SET runtime_attempt_id=${f.attemptID} WHERE id=${f.changeID}`;
      await sql`UPDATE factory.change_writer SET state='human',epoch=2,user_id=${f.userID} WHERE change_id=${f.changeID}`;
      await sql`INSERT INTO factory.change_agent_session(change_id,runtime_attempt_id,state,created_by)
        VALUES(${f.changeID},${f.attemptID},'waiting',${f.userID})`;
    });
    await blocker`BEGIN`;
    await blocker`SELECT c.id FROM factory.change c JOIN factory.ticket t ON t.id=c.ticket_id
      WHERE c.id=${f.changeID} FOR UPDATE OF c,t`;
    locked = true;
    waiting = f.database.client
      .begin(async (sql) => {
        const [backend] = await sql<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
        if (!backend) throw new Error("Owned grant backend is missing");
        pidReady.resolve(backend.pid);
        await substrateWorkspaceGrantIn(f.database, sql, f.workspaceID, f.userID, true);
        return "unexpected admission";
      })
      .catch((error: Error) => {
        pidReady.reject(error);
        return error.message;
      });
    const pid = await pidReady.promise;
    await eventually(
      async () =>
        (
          await f.database.client<{ waiting: boolean }[]>`
        SELECT wait_event_type='Lock' AS waiting FROM pg_stat_activity WHERE pid=${pid}`
        )[0]?.waiting,
      (value) => value === true,
      "Owned grant did not wait on the Change lock",
    );
    await blocker`UPDATE factory.change_agent_session SET state='stopped',stop_pending=true,
      stop_id=${crypto.randomUUID()} WHERE change_id=${f.changeID}`;
    await blocker`COMMIT`;
    locked = false;
    expect(await waiting).toContain("Confirm the recorded Agent Stop");
    await expect(
      f.database.client.begin((sql) =>
        substrateWorkspaceGrantIn(f.database, sql, f.workspaceID, f.userID, true),
      ),
    ).rejects.toThrow("Confirm the recorded Agent Stop");
    expect(
      await f.database.client.begin((sql) =>
        substrateWorkspaceGrantIn(f.database, sql, f.workspaceID, f.userID, false),
      ),
    ).toMatchObject({ changeID: f.changeID, kind: "ticket" });
  } finally {
    if (locked) await blocker`ROLLBACK`;
    await waiting;
    await blocker.end({ timeout: 1 });
    await f.dispose();
  }
}, 60_000);
