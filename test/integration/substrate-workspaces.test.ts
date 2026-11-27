import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { defaultExecutionPolicy } from "#conversation-domain/execution-policy";
import { runtimeConnectorTokens } from "#runtime-domain/identity";
import {
  nativeActor,
  type SubstrateCall,
  SubstrateRPCError,
} from "#runtime-kubernetes/substrate-control";
import { claimAgentWriterIn } from "../../apps/factory/src/access/change-writer";
import { createChangeWriterController } from "../../apps/factory/src/access/writer-controller";
import { createAgentCommitTransport } from "../../apps/factory/src/agent/commit-transport";
import { createChangeAgentStop } from "../../apps/factory/src/agent/stop";
import { createAgentTurnStore } from "../../apps/factory/src/agent/turn-store";
import { createDeliveryCoordination } from "../../apps/factory/src/delivery/coordination";
import { createChangeIntegration } from "../../apps/factory/src/delivery/integration";
import { createRuntimeController } from "../../apps/factory/src/runtime/controller";
import { removeRuntimeRepository } from "../../apps/factory/src/runtime/git-http";
import { substrateTemplateSHA256 } from "../../apps/factory/src/runtime/substrate";
import {
  substrateWorkspaceGrantIn,
  substrateWorkspaceSourceIn,
} from "../../apps/factory/src/runtime/substrate-grant";
import {
  renderSubstrateTemplate,
  substrateBootstrapCA,
} from "../../apps/factory/src/runtime/substrate-template";
import {
  createSubstrateWorkspaces,
  type SubstrateInstallationConfiguration,
} from "../../apps/factory/src/runtime/substrate-workspaces";
import type { RuntimeAttemptView } from "../../apps/factory/src/runtime/types";
import { objectDigest } from "../../apps/factory/src/storage/objects";
import { computeAllocationIn } from "../../apps/factory/src/usage/journal-api";
import { admitInitialSourceSeedIn } from "../../apps/factory/src/workspace/source-api";
import { createWorkspaceSourceController } from "../../apps/factory/src/workspace/source-controller";
import { admitInitialSource } from "../../apps/factory/src/workspace/source-initialization";
import { createSubstrateSources } from "../../apps/factory/src/workspace/substrate-source";
import {
  nativeProjectBootstrap,
  nativeProjectDefinition,
  nativeProjectTemplate,
} from "../fixtures/native-project";
import { nativeRuntimeFixture } from "../fixtures/native-runtime";
import { memoryPrivateObjects } from "../fixtures/private-objects";
import { substrateFixture } from "../fixtures/substrate";

const starterSourceFile = (path: string) => !path.split(/[\\/]/).includes("node_modules");

test("native Workspace bootstrap carries installation registry CA without changing Project Environment", async () => {
  const f = await nativeRuntimeFixture();
  const previous = process.env["FACTORY_REGISTRY_CA_FILE"];
  try {
    const registryCA =
      "-----BEGIN CERTIFICATE-----\nowned-extra-registry-ca\n-----END CERTIFICATE-----\n";
    const registryCAFile = resolve(f.repository, "../registry-ca.pem");
    await writeFile(registryCAFile, registryCA);
    process.env["FACTORY_REGISTRY_CA_FILE"] = registryCAFile;
    const environment = await f.database
      .client`SELECT * FROM factory.operation WHERE kind='environments.environment' AND scope_type='project' AND scope_id=${f.projectID}`;
    await writeFile(registryCAFile, `${registryCA}-----BEGIN PRIVATE KEY-----\nowned-invalid`);
    await expect(f.controller().start(f.projectID, f.userID)).rejects.toThrow(
      "public certificates only",
    );
    expect(f.calls.some((call) => call.method.startsWith("Create"))).toBe(false);
    await writeFile(registryCAFile, registryCA);
    const started = await f.controller().start(f.projectID, f.userID);
    if (!started) throw new Error("Owned native Workspace was not admitted");
    const template = f.resources
      .get(`fa-${started.id.replaceAll("-", "")}`)
      ?.get("ActorTemplate") as { containers: { env: { value: string }[] }[] } | undefined;
    if (!template) throw new Error("Owned native template missing");
    const bootstrap = JSON.parse(template.containers[0]?.env[0]?.value ?? "null");
    const factoryCA = await Bun.file(f.configuration.factoryCAFile).text();
    expect(bootstrap.factoryCA).toBe(`${factoryCA.trimEnd()}\n${registryCA}`);
    expect(
      await f.database
        .client`SELECT * FROM factory.operation WHERE kind='environments.environment' AND scope_type='project' AND scope_id=${f.projectID}`,
    ).toEqual(environment);
    const originalTemplate = structuredClone(template);
    const creates = f.calls.filter((call) => call.method.startsWith("Create")).length;
    // Installation trust changes must never replace or rebootstrap an existing Actor.
    await writeFile(registryCAFile, `${registryCA}-----BEGIN PRIVATE KEY-----\nowned-invalid`);
    expect((await f.controller().start(f.projectID, f.userID))?.id).toBe(started.id);
    expect(template).toEqual(originalTemplate);
    expect(f.calls.filter((call) => call.method.startsWith("Create"))).toHaveLength(creates);
  } finally {
    if (previous === undefined) delete process.env["FACTORY_REGISTRY_CA_FILE"];
    else process.env["FACTORY_REGISTRY_CA_FILE"] = previous;
    await f.dispose();
  }
}, 60_000);

test("native bootstrap trust preserves no-extra template hashes and refuses private keys", async () => {
  const directory = await mkdtemp(join(tmpdir(), "factory-bootstrap-trust-"));
  const previous = process.env["FACTORY_REGISTRY_CA_FILE"];
  try {
    const factoryCA =
      "\n-----BEGIN CERTIFICATE-----\nowned-factory-ca\n-----END CERTIFICATE-----\n\n";
    const ca = join(directory, "factory-ca.pem");
    const extra = join(directory, "registry-ca.pem");
    await writeFile(ca, factoryCA);
    await writeFile(extra, factoryCA.trim());
    const config = {
      workloadImage: `registry.test/native@sha256:${"a".repeat(64)}`,
      workerSelector: { "factory.dev/deployment": "owned" },
    };
    const original = renderSubstrateTemplate(
      "owned",
      config,
      nativeProjectBootstrap({ factoryCA }),
      nativeProjectDefinition,
    );
    for (const file of [undefined, "/etc/ssl/certs/ca-certificates.crt", ca, extra]) {
      if (file === undefined) delete process.env["FACTORY_REGISTRY_CA_FILE"];
      else process.env["FACTORY_REGISTRY_CA_FILE"] = file;
      const trust = substrateBootstrapCA(ca);
      expect(trust).toBe(factoryCA);
      expect(
        substrateTemplateSHA256(
          renderSubstrateTemplate(
            "owned",
            config,
            nativeProjectBootstrap({ factoryCA: trust }),
            nativeProjectDefinition,
          ),
        ),
      ).toBe(substrateTemplateSHA256(original));
    }
    process.env["FACTORY_REGISTRY_CA_FILE"] = extra;
    for (const kind of [
      "PRIVATE KEY",
      "RSA PRIVATE KEY",
      "EC PRIVATE KEY",
      "ENCRYPTED PRIVATE KEY",
      "OPENSSH PRIVATE KEY",
    ]) {
      await writeFile(extra, `${factoryCA}-----BEGIN ${kind}-----\nowned-invalid`);
      expect(() => substrateBootstrapCA(ca)).toThrow("public certificates only");
    }
    await writeFile(extra, "not a public certificate");
    expect(() => substrateBootstrapCA(ca)).toThrow("public certificates only");
    process.env["FACTORY_REGISTRY_CA_FILE"] = join(directory, "missing.pem");
    expect(() => substrateBootstrapCA(ca)).toThrow();
    delete process.env["FACTORY_REGISTRY_CA_FILE"];
    await writeFile(ca, `${factoryCA}-----BEGIN PRIVATE KEY-----\nowned-invalid`);
    expect(() => substrateBootstrapCA(ca)).toThrow("public certificates only");
  } finally {
    if (previous === undefined) delete process.env["FACTORY_REGISTRY_CA_FILE"];
    else process.env["FACTORY_REGISTRY_CA_FILE"] = previous;
    await rm(directory, { recursive: true, force: true });
  }
});

test("Starter fixture copies source without local installed dependencies", async () => {
  const directory = await mkdtemp(join(tmpdir(), "factory-starter-copy-"));
  try {
    const source = join(directory, "source");
    const target = join(directory, "target");
    await mkdir(join(source, "node_modules", "installed-package"), { recursive: true });
    await mkdir(join(source, "src"));
    await writeFile(join(source, "src", "app.ts"), "export const source = true;\n");
    await writeFile(join(source, "node_modules", "installed-package", "index.js"), "ignored");
    await cp(source, target, { recursive: true, filter: starterSourceFile });
    expect(await Bun.file(join(target, "src", "app.ts")).text()).toBe(
      "export const source = true;\n",
    );
    expect(
      await Bun.file(join(target, "node_modules", "installed-package", "index.js")).exists(),
    ).toBe(false);
  } finally {
    await rm(directory, { recursive: true });
  }
});

test("native template Start needs no setup confirmation; lost replies keep the same native intent", async () => {
  const f = await substrateFixture();
  const directory = await mkdtemp(join(tmpdir(), "substrate-provision-"));
  const ca = join(directory, "ca.pem");
  await writeFile(ca, "-----BEGIN CERTIFICATE-----\nowned-test\n-----END CERTIFICATE-----\n");
  await f.database.client`DELETE FROM factory.development_workspace WHERE id=${f.workspaceID}`;
  const config: SubstrateInstallationConfiguration = {
    deployment: "fresh-workspaces",
    database: f.config.database,
    connection: f.config.connection,
    provisioner: { ...f.config.connection, tokenFile: "/owner-token" },
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
  await f.database
    .client`UPDATE factory.project SET repository_url='file:///not-dispatched',default_branch='main' WHERE id=${f.projectID}`;
  // A real local Git repository supplies the same revision resolution as normal Start.
  const repo = join(directory, "repository");
  await Bun.$`git init -b main ${repo}`.quiet();
  await writeFile(join(repo, "README"), "owned source\n");
  await mkdir(join(repo, ".factory"));
  await writeFile(join(repo, nativeProjectTemplate.path), nativeProjectTemplate.content);
  await Bun.$`git -C ${repo} add .`.quiet();
  await Bun.$`git -C ${repo} -c user.name=Owned -c user.email=owned@example.invalid commit -m initial`.quiet();
  const revision = (await Bun.$`git -C ${repo} rev-parse HEAD`.text()).trim();
  await f.database
    .client`UPDATE factory.project SET repository_url=${`file://${repo}`} WHERE id=${f.projectID}`;
  await f.database
    .client`INSERT INTO factory.operation(id,kind,scope_type,scope_id,idempotency_key,state,payload,created_by)
    VALUES(${crypto.randomUUID()},'projects.setup_readiness','project',${f.projectID},${`projects.setup_readiness:${f.projectID}:configuration`},'pending',${JSON.stringify({ task: "configuration", commandId: crypto.randomUUID() })}::jsonb,${f.userID})`;
  const objects = new Map<string, Record<string, unknown>>();
  let extraAttemptID: string | undefined;
  const creates = new Map<string, number>();
  let nativeCalls = 0;
  let lose = "CreateAtespace";
  const call: SubstrateCall = async (method, input) => {
    nativeCalls++;
    const request = input as Record<string, Record<string, unknown>>;
    const kind = method.replace(/^(Get|Create)/, "");
    if (method.startsWith("Get")) {
      const object = objects.get(kind);
      if (!object) throw new SubstrateRPCError("NotFound", "absent");
      return structuredClone(object);
    }
    if (method.startsWith("Create")) {
      creates.set(kind, (creates.get(kind) ?? 0) + 1);
      const [intent] = await f.database
        .client`SELECT resources#>>'{atespace,attemptedAt}' AS atespace_attempted_at,
          resources#>>'{policy,attemptedAt}' AS policy_attempted_at,
          resources#>>'{template,attemptedAt}' AS template_attempted_at
        FROM factory.substrate_provision WHERE owner_id=${f.workspaceID} AND kind='workspace'`;
      expect(
        intent?.[
          kind === "Atespace"
            ? "atespace_attempted_at"
            : kind === "AtespaceAccessPolicy"
              ? "policy_attempted_at"
              : "template_attempted_at"
        ],
      ).not.toBeNull();
      let spec = request[`${kind[0]?.toLowerCase()}${kind.slice(1)}`];
      if (kind === "AtespaceAccessPolicy") spec = request["accessPolicy"];
      if (kind === "ActorEgressPolicy") spec = request["egressPolicy"];
      if (!spec) throw new Error(`Missing ${kind}`);
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
        lose = "";
        throw new SubstrateRPCError("Unavailable", "lost provisioning reply");
      }
      return structuredClone(value);
    }
    if (method === "ResumeActor") {
      const actor = nativeActor.parse(objects.get("Actor"));
      actor.metadata.version = "2";
      actor.status = {
        state: "ACTOR_STATE_RUNNING",
        workerAssignment: { sandboxRuntime: f.config.runtime },
      };
      objects.set("Actor", actor);
      return { actor };
    }
    throw new Error(`Unexpected ${method}`);
  };
  function expectTemplateImages(controlImage: string) {
    const template = objects.get("ActorTemplate") as {
      containers: { name: string; image: string }[];
    };
    expect(template.containers.map(({ name, image }) => ({ name, image }))).toEqual([
      { name: "factory-control", image: controlImage },
      ...nativeProjectDefinition.containers.map(({ name, image }) => ({ name, image })),
    ]);
  }
  const controller = (provisioner: SubstrateCall = call) =>
    createRuntimeController(f.database, f.hub, "owned-native-secret", {
      configuration: config,
      call,
      provisionerCall: provisioner,
    });
  try {
    const c = controller();
    await expect(c.start(f.projectID, crypto.randomUUID())).rejects.toThrow();
    expect(creates.size).toBe(0);
    await expect(c.ensureStaging(f.projectID, f.userID)).rejects.toThrow(
      "Confirm this Project's configuration",
    );
    expect(creates.size).toBe(0);
    await f.database
      .client`UPDATE factory.operation SET state='ready',completed_at=now(),updated_at=now() WHERE kind='projects.setup_readiness' AND scope_type='project' AND scope_id=${f.projectID}`;
    await expect(c.ensureStaging(f.projectID, f.userID)).rejects.toThrow(
      ".factory/system.json is required for Staging",
    );
    expect(
      await f.database
        .client`SELECT scope_id AS project_id FROM factory.operation WHERE kind='delivery.staging_preview'`,
    ).toHaveLength(0);
    expect(creates.size).toBe(0);
    await f.database
      .client`UPDATE factory.operation SET state='pending',completed_at=NULL,updated_at=now() WHERE kind='projects.setup_readiness' AND scope_type='project' AND scope_id=${f.projectID}`;
    await expect(c.start(f.projectID, f.userID)).rejects.toThrow("lost provisioning reply");
    lose = "CreateAtespaceAccessPolicy";
    await expect(c.start(f.projectID, f.userID)).rejects.toThrow("lost provisioning reply");
    lose = "CreateActorTemplate";
    await expect(c.start(f.projectID, f.userID)).rejects.toThrow("lost provisioning reply");
    const started = await controller().start(f.projectID, f.userID);
    expect(started?.native?.state).toBe("ACTOR_STATE_RUNNING");
    expect(started?.state).not.toBe("ready");
    expect(started?.native?.portable).toBe(false);
    expect(creates.get("Atespace")).toBe(1);
    expect(creates.get("AtespaceAccessPolicy")).toBe(1);
    expect(creates.get("ActorTemplate")).toBe(1);
    expect(creates.get("Actor")).toBe(1);
    const collaborator = crypto.randomUUID();
    await f.database.client`INSERT INTO auth."user"(id,name,email)
      VALUES(${collaborator},'Native collaborator',${`${collaborator}@factory.local`})`;
    await f.database
      .client`INSERT INTO factory.project_membership(project_id,user_id,role,updated_by)
      VALUES(${f.projectID},${collaborator},'developer',${f.userID})`;
    await f.database
      .client`INSERT INTO factory.workspace_share(workspace_id,user_id,permission,granted_by)
      VALUES(${f.workspaceID},${collaborator},'observe',${f.userID})`;
    await expect(controller().start(f.projectID, collaborator, f.workspaceID)).rejects.toThrow(
      "observation",
    );
    await f.database
      .client`UPDATE factory.workspace_share SET permission='collaborate',version=version+1
      WHERE workspace_id=${f.workspaceID} AND user_id=${collaborator}`;
    expect((await controller().start(f.projectID, collaborator, f.workspaceID))?.id).toBe(
      f.attemptID,
    );
    expect(creates.get("Actor")).toBe(1);
    const [shared] = await f.database
      .client`SELECT workspace.owner_user_id AS owner,attempt.created_by AS creator
      FROM factory.development_workspace workspace JOIN factory.runtime_attempt attempt ON attempt.workspace_id=workspace.id
      WHERE attempt.id=${f.attemptID}`;
    expect(shared).toEqual({ owner: f.userID, creator: f.userID });
    await f.database.client`UPDATE factory.workspace_share SET revoked_at=now(),version=version+1
      WHERE workspace_id=${f.workspaceID} AND user_id=${collaborator}`;
    await expect(controller().start(f.projectID, collaborator, f.workspaceID)).rejects.toThrow();
    expect([
      ...(await f.database.client`SELECT to_regclass('factory.workspace_source') AS source,
        to_regclass('factory.factorybox_worker') AS worker`),
    ]).toEqual([{ source: null, worker: null }]);
    const [saved] = await f.database
      .client`SELECT intent,resources->'template'->'value' AS template FROM factory.substrate_provision WHERE owner_id=${f.workspaceID} AND kind='workspace'`;
    expect(saved?.["intent"].systemContract).toBeNull();
    expect(saved?.["intent"].revision).toBe(revision);
    expect(saved?.["intent"].projectTemplate).toEqual(nativeProjectTemplate);
    const bootstrap = JSON.parse(
      (objects.get("ActorTemplate") as { containers: { env: { value: string }[] }[] }).containers[0]
        ?.env[0]?.value ?? "null",
    );
    expect(bootstrap.assignment.channels).toEqual([
      { name: "ide", kind: "ide", target: "", healthPath: "" },
    ]);
    expect(bootstrap.assignment.processes).toEqual([]);
    expect(bootstrap.assignment.actorTemplatePath).toBe(".factory/actor-template.json");
    expect(bootstrap.projectTemplate).toEqual({
      path: nativeProjectTemplate.path,
      sha256: nativeProjectTemplate.sha256,
    });
    const [attempt] = await f.database
      .client`SELECT declared_apps FROM factory.runtime_attempt WHERE id=${f.attemptID}`;
    expect(attempt?.["declared_apps"]).toEqual([]);
    expect(JSON.stringify(saved)).not.toContain("parentToken");
    const spec = objects.get("ActorTemplate");
    expect(JSON.stringify(spec)).toContain("native-parent");
    expect(JSON.stringify(spec)).not.toContain("file://");
    await expect(
      Promise.resolve(
        f.database
          .client`UPDATE factory.substrate_provision SET resources=jsonb_set(resources,'{template,value}','null'::jsonb) WHERE owner_id=${f.workspaceID} AND kind='workspace'`,
      ),
    ).rejects.toThrow("immutable");
    let retainedOwnerCalls = 0;
    const expiredProvisioner: SubstrateCall = async () => {
      retainedOwnerCalls++;
      throw new SubstrateRPCError("Unauthenticated", "expired provisioner");
    };
    // The existing, scoped Editor grant is enough to revalidate the original
    // resources. Continuation never observes them through the global Owner.
    expect((await controller(expiredProvisioner).start(f.projectID, f.userID))?.id).toBe(
      f.attemptID,
    );
    expect(retainedOwnerCalls).toBe(0);
    const policy = objects.get("AtespaceAccessPolicy");
    if (!policy) throw new Error("Native policy fixture missing");
    objects.set("AtespaceAccessPolicy", { ...policy, bindings: [] });
    await expect(controller(expiredProvisioner).start(f.projectID, f.userID)).rejects.toThrow(
      "grant differs",
    );
    expect(retainedOwnerCalls).toBe(0);
    objects.set("AtespaceAccessPolicy", policy);
    const template = objects.get("ActorTemplate");
    if (!template) throw new Error("Native template fixture missing");
    const original = structuredClone(template);
    (template["metadata"] as { uid: string }).uid = crypto.randomUUID();
    await expect(controller().start(f.projectID, f.userID)).rejects.toThrow("original identity");
    objects.set("ActorTemplate", original);
    objects.set("ActorTemplate", { ...original, resources: { limits: { memoryBytes: "4096" } } });
    await expect(controller().start(f.projectID, f.userID)).rejects.toThrow("spec differs");
    objects.set("ActorTemplate", original);
    const space = objects.get("Atespace");
    if (!space) throw new Error("Native space fixture missing");
    objects.delete("Atespace");
    await expect(controller().start(f.projectID, f.userID)).rejects.toThrow("absent");
    expect(creates.get("Atespace")).toBe(1);
    objects.set("Atespace", space);
    const originalImage = config.workloadImage;
    config.workloadImage = `registry.test/native@sha256:${"b".repeat(64)}`;
    config.resources = { cpuMilli: 2000, memoryMiB: 4096 };
    expect((await controller().start(f.projectID, f.userID))?.id).toBe(f.attemptID);
    expectTemplateImages(originalImage);
    expect(creates.get("Actor")).toBe(1);
    expect(await computeAllocationIn(f.database.client, null)).toEqual({
      sandboxes: 1,
      cpuMilli: 1500,
      memoryMiB: 3072,
    });
    expect(objects.get("ActorTemplate")).toMatchObject({
      resources: { limits: { cpuMillicores: "1500", memoryBytes: "3221225472" } },
    });
    expect(
      (
        await f.database
          .client`SELECT intent#>>'{configuration,workloadImage}' AS image FROM factory.substrate_provision WHERE owner_id=${f.workspaceID} AND kind='workspace'`
      )[0]?.["image"],
    ).toBe(originalImage);
    // Every fresh Project uses this installation's native runtime. A new image
    // never replaces the original Actor or rewrites its retained Project binding.
    const originalObjects = new Map(objects);
    objects.clear();
    const other = crypto.randomUUID();
    const otherProjectID = crypto.randomUUID();
    await f.database
      .client`INSERT INTO auth."user"(id,name,email) VALUES(${other},'Fresh image developer',${`${other}@factory.local`})`;
    await f.database
      .client`INSERT INTO factory.project(id,name,slug,repository_url,default_branch,actor_template_path,created_by)
      VALUES(${otherProjectID},'Second native Project',${`second-native-${otherProjectID}`},${`file://${repo}`},'main','.factory/actor-template.json',${other})`;
    await f.database
      .client`INSERT INTO factory.project_membership(project_id,user_id,role,updated_by) VALUES(${otherProjectID},${other},'developer',${other})`;
    for (const [cpuMilli, memoryMiB] of [
      [3500, 7167],
      [3499, 7168],
    ]) {
      await f.database.client`INSERT INTO factory.execution_policy(scope,version,policy,updated_by)
        VALUES('factory',1,${JSON.stringify({ ...defaultExecutionPolicy(), cpuMilli, memoryMiB })}::jsonb,${f.userID})
        ON CONFLICT(scope) DO UPDATE SET policy=EXCLUDED.policy`;
      await expect(controller().start(otherProjectID, other)).rejects.toMatchObject({
        code: "conflict",
      });
      expect(creates.get("Actor")).toBe(1);
    }
    await f.database
      .client`UPDATE factory.execution_policy SET policy=${JSON.stringify({ ...defaultExecutionPolicy(), cpuMilli: 3500, memoryMiB: 7168 })}::jsonb WHERE scope='factory'`;
    const installation = controller();
    extraAttemptID = (await installation.start(otherProjectID, other))?.id;
    expect(extraAttemptID).toBeDefined();
    expect(extraAttemptID).not.toBe(f.attemptID);
    expectTemplateImages(config.workloadImage);
    expect(objects.get("ActorTemplate")).toMatchObject({
      resources: { limits: { cpuMillicores: "2000", memoryBytes: "4294967296" } },
    });
    expect(await computeAllocationIn(f.database.client, null)).toEqual({
      sandboxes: 2,
      cpuMilli: 3500,
      memoryMiB: 7168,
    });
    expect(creates.get("Actor")).toBe(2);
    const [second] = await f.database.client`
      SELECT w.project_id AS "projectID",p.intent#>>'{configuration,projectID}' AS binding
      FROM factory.runtime_attempt a JOIN factory.development_workspace w ON w.id=a.workspace_id
      JOIN factory.substrate_provision p ON p.owner_id=w.id AND p.kind='workspace' WHERE a.id=${extraAttemptID ?? ""}`;
    expect(second).toEqual({ projectID: otherProjectID, binding: otherProjectID });
    objects.clear();
    for (const [kind, value] of originalObjects) objects.set(kind, value);
    expect((await installation.get(f.attemptID))?.native?.actorUID).toBe(
      nativeActor.parse(originalObjects.get("Actor")).metadata.uid,
    );
    expectTemplateImages(originalImage);
    const connectorURL = config.connectorURL;
    config.connectorURL = "wss://foreign.test/internal/runtime-connect";
    await expect(controller().start(f.projectID, f.userID)).rejects.toThrow("immutable");
    await expect(controller().get(f.attemptID)).rejects.toThrow("immutable");
    config.connectorURL = connectorURL;
    const originalUID = nativeActor.parse(originalObjects.get("Actor")).metadata.uid;
    await f.database
      .client`INSERT INTO factory.substrate_source(workspace_id,actor_uid) VALUES(${f.workspaceID},${originalUID})`;
    const callsBefore = nativeCalls;
    let ownerCalls = 0;
    for (const state of ["pausing", "failed"]) {
      await f.database
        .client`UPDATE factory.runtime_attempt SET state=${state}::factory.runtime_attempt_state WHERE id=${f.attemptID}`;
      await expect(
        controller(async () => {
          ownerCalls++;
          throw new SubstrateRPCError("Unauthenticated", "expired provisioner");
        }).start(f.projectID, f.userID),
      ).rejects.toThrow("Reconcile the startup outcome");
    }
    expect(ownerCalls).toBe(0);
    expect(nativeCalls).toBe(callsBefore);
  } finally {
    await removeRuntimeRepository(f.attemptID);
    if (extraAttemptID) await removeRuntimeRepository(extraAttemptID);
    await f.dispose();
    await rm(directory, { recursive: true, force: true });
  }
}, 60_000);

test.each(["personal", "ticket"] as const)(
  "direct %s Start admits its exact Source seed before native effects without opening Source",
  async (kind) => {
    const f = await substrateFixture("a".repeat(40), kind);
    const directory = await mkdtemp(join(tmpdir(), "factory-start-seed-"));
    const ca = join(directory, "ca.pem");
    await writeFile(ca, "-----BEGIN CERTIFICATE-----\nowned-test\n-----END CERTIFICATE-----\n");
    const sources = createSubstrateSources(f.database, f.hub);
    let effects = 0;
    try {
      if (kind === "ticket") {
        const [approval] = await f.database.client<{ revision: string }[]>`
          SELECT requirement_revision_id AS revision FROM factory.requirement_approval WHERE ticket_id=${f.ticketID}`;
        if (!approval) throw new Error("Owned Ticket approval is missing");
        await f.database.client`UPDATE factory.project_membership SET role='product-contributor'
          WHERE project_id=${f.projectID} AND user_id=${f.userID}`;
        const turns = createAgentTurnStore(f.database);
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
            modelId: "factory-coding-model",
            skillRevisionIds: [],
            requiredSkillRevisionIds: [],
            conversationVersion: null,
            requirementRevisionId: approval.revision,
          },
          (sql, record) => claimAgentWriterIn(sql, f.changeID, record.id, f.userID),
        );
        const writers = createChangeWriterController({
          database: f.database,
          agentUsername: "owned-agent",
          protect: async () => {},
          stopAgent: async () => {
            throw new Error("No earlier Agent exists");
          },
          runtime: {
            stop: async () => {
              throw new Error("No earlier runtime exists");
            },
            get: async () => null,
          },
        });
        expect(await writers.prepareAgent(f.changeID, turn.id)).toBe(true);
        expect((await turns.claimPending(turn.id, 60_000))?.ownerToken).toBeTruthy();
        await f.database
          .client`DELETE FROM factory.development_workspace WHERE id=${f.workspaceID}`;
      }
      const branch =
        kind === "ticket"
          ? (
              await f.database.client<{ branch: string }[]>`
                SELECT branch_name AS branch FROM factory.change WHERE id=${f.changeID}`
            )[0]?.branch
          : "main";
      const call: SubstrateCall = async (method) => {
        if (method.startsWith("Get")) throw new SubstrateRPCError("NotFound", "absent");
        effects++;
        const [source] = await f.database.client`
          SELECT actor_uid,owner,seed,seed_confirmed_at FROM factory.substrate_source
          WHERE workspace_id=${f.workspaceID}`;
        expect(source).toMatchObject({
          actor_uid: null,
          owner: "service",
          seed_confirmed_at: null,
          seed: {
            workspaceID: f.workspaceID,
            projectID: f.projectID,
            repositoryURL: "https://example.invalid/fixture.git",
            revision: "a".repeat(40),
            branch,
          },
        });
        expect(await f.database.client`SELECT id FROM factory.runtime_attempt`).toHaveLength(0);
        throw new Error("owned-seeded-provisioning-boundary");
      };
      sources.startupConfiguration = async () => undefined;
      const runtime = createSubstrateWorkspaces(
        f.database,
        f.hub,
        "owned-native-secret",
        {
          deployment: f.config.deployment,
          database: f.config.database,
          projectID: f.projectID,
          connection: f.config.connection,
          connectorURL: f.config.connectorURL,
          profile: f.config.profile,
          runtime: f.config.runtime,
          provisioner: f.config.connection,
          editorPrincipal: "user:system:serviceaccount:owned:factory-control",
          factoryCAFile: ca,
          workloadImage: `registry.test/native@sha256:${"a".repeat(64)}`,
          workerSelector: {
            "factory.runtime/profile": f.config.profile,
            "factory.dev/deployment": "owned",
          },
          egressHosts: [],
        },
        call,
        call,
        async () => ({ systemContract: null, actorTemplate: nativeProjectTemplate }),
        sources,
      );
      await expect(
        runtime.start(f.userID, kind === "ticket" ? f.changeID : undefined),
      ).rejects.toThrow("owned-seeded-provisioning-boundary");
      expect(effects).toBe(1);
      const retained = [
        ...(await f.database
          .client`SELECT seed FROM factory.substrate_source WHERE workspace_id=${f.workspaceID}`),
      ];
      await expect(
        runtime.start(f.userID, kind === "ticket" ? f.changeID : undefined),
      ).rejects.toThrow("absent");
      expect([
        ...(await f.database
          .client`SELECT seed FROM factory.substrate_source WHERE workspace_id=${f.workspaceID}`),
      ]).toEqual(retained);
      expect(effects).toBe(1);
    } finally {
      await sources.close();
      await f.dispose();
      await rm(directory, { recursive: true, force: true });
    }
  },
  60_000,
);

test("initial Source seed admission refuses missing history after any Runtime Attempt", async () => {
  const f = await substrateFixture();
  try {
    await f.database.client.begin(async (sql) => {
      await sql`INSERT INTO factory.substrate_provision(owner_id,kind,intent) VALUES(${f.workspaceID},'workspace','{}')`;
      await sql`INSERT INTO factory.runtime_attempt(id,project_id,workspace_id,generation,revision,state,
        parent_connector_token_hash,create_intended_at,created_by,
        atespace,actor_name,binding_intent)
        VALUES(${f.attemptID},${f.projectID},${f.workspaceID},1,${"a".repeat(40)},
          'create-intended',${"b".repeat(64)},now(),${f.userID},
          ${f.atespace},${`runtime-${f.attemptID.replaceAll("-", "")}`},'{}')`;
    });
    for (const state of ["create-intended", "stopped"]) {
      await f.database.client`UPDATE factory.runtime_attempt
        SET state=${state}::factory.runtime_attempt_state WHERE id=${f.attemptID}`;
      await expect(
        f.database.client.begin(async (sql) => {
          await sql`SELECT pg_advisory_xact_lock(hashtext(${`runtime:${f.workspaceID}`}))`;
          const grant = await substrateWorkspaceGrantIn(
            f.database,
            sql,
            f.workspaceID,
            f.userID,
            true,
          );
          await admitInitialSourceSeedIn(sql, {
            workspaceID: f.workspaceID,
            projectID: grant.projectID,
            repositoryURL: "https://example.invalid/fixture.git",
            revision: "a".repeat(40),
            branch: "main",
          });
        }),
      ).rejects.toThrow("Retained Source is missing; reinitialization refused");
      await expect(
        admitInitialSource(f.database, f.userID, { projectID: f.projectID }),
      ).rejects.toThrow("Retained Source is missing; reinitialization refused");
    }
    expect(await f.database.client`SELECT workspace_id FROM factory.substrate_source`).toHaveLength(
      0,
    );
  } finally {
    await f.dispose();
  }
}, 60_000);

test("native-template-only startPersisted retains commissioned Contributor, lost Actor create and native Source role fences", async () => {
  await mkdir(".factory/test-results", { recursive: true });
  const directory = await mkdtemp(resolve(".factory/test-results/native-ticket-controller-"));
  const repo = join(directory, "repository");
  await cp("templates/starter-app", repo, {
    recursive: true,
    filter: starterSourceFile,
  });
  await rm(join(repo, ".factory/system.json"));
  await rm(join(repo, ".devcontainer"), { recursive: true, force: true });
  await writeFile(join(repo, nativeProjectTemplate.path), nativeProjectTemplate.content);
  await Bun.$`git init -b main ${repo}`.quiet();
  await Bun.$`git -C ${repo} add .`.quiet();
  await Bun.$`git -C ${repo} -c user.name=Owned -c user.email=owned@example.invalid commit -m initial`.quiet();
  const revision = (await Bun.$`git -C ${repo} rev-parse HEAD`.text()).trim();
  const f = await substrateFixture(revision, "ticket");
  const ca = join(directory, "ca.pem");
  await writeFile(ca, "-----BEGIN CERTIFICATE-----\nowned-test\n-----END CERTIFICATE-----\n");
  const config: SubstrateInstallationConfiguration = {
    deployment: "owned-test",
    database: f.config.database,
    connection: f.config.connection,
    provisioner: { ...f.config.connection, tokenFile: "/owner-token" },
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
  const creates = new Map<string, number>();
  let loseActor = true;
  const call: SubstrateCall = async (method, input) => {
    const request = input as Record<string, Record<string, unknown>>;
    const kind = method.replace(/^(Get|Create)/, "");
    if (method.startsWith("Get")) {
      const object = objects.get(kind);
      if (!object) throw new SubstrateRPCError("NotFound", "absent");
      return structuredClone(object);
    }
    if (method.startsWith("Create")) {
      creates.set(kind, (creates.get(kind) ?? 0) + 1);
      const spec =
        request[
          kind === "AtespaceAccessPolicy"
            ? "accessPolicy"
            : kind === "ActorEgressPolicy"
              ? "egressPolicy"
              : `${kind[0]?.toLowerCase()}${kind.slice(1)}`
        ];
      if (!spec) throw new Error("Owned native intent missing");
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
      if (kind === "Actor" && loseActor) {
        loseActor = false;
        throw new SubstrateRPCError("Unavailable", "lost Actor create reply");
      }
      return structuredClone(value);
    }
    if (method === "ResumeActor") {
      const actor = nativeActor.parse(objects.get("Actor"));
      actor.metadata.version = "2";
      actor.status = {
        state: "ACTOR_STATE_RUNNING",
        workerAssignment: { sandboxRuntime: f.config.runtime },
      };
      objects.set("Actor", actor);
      return { actor };
    }
    throw new Error(`Unexpected ${method}`);
  };
  const blobs = memoryPrivateObjects();
  const sources = createSubstrateSources(f.database, f.hub, blobs);
  let sourceResumes = 0;
  const runtime = createRuntimeController(f.database, f.hub, "owned-native-secret", {
    configuration: config,
    sources: {
      ...sources,
      async resume(workspaceID, attemptID, sql, inputStop) {
        expect(workspaceID).toBe(f.workspaceID);
        expect(attemptID).toBe(f.attemptID);
        expect(inputStop).toBe(false);
        // This fixture publishes its controlled complete export below. Native
        // allocation must leave the seed independent until the real v2 receipt.
        expect(await sources.lease(workspaceID, sql)).toMatchObject({
          actorUID: null,
          owner: "service",
          writable: true,
          seedConfirmedAt: null,
          seed: { workspaceID, projectID: f.projectID, revision },
        });
        sourceResumes++;
      },
    },
    call,
    provisionerCall: call,
  });
  try {
    await f.database
      .client`UPDATE factory.project SET repository_url=${`file://${repo}`} WHERE id=${f.projectID}`;
    await f.database
      .client`INSERT INTO factory.operation(id,kind,scope_type,scope_id,idempotency_key,state,payload,created_by)
      VALUES(${crypto.randomUUID()},'projects.setup_readiness','project',${f.projectID},${`projects.setup_readiness:${f.projectID}:configuration`},'pending',${JSON.stringify({ task: "configuration", commandId: crypto.randomUUID() })}::jsonb,${f.userID})`;
    await f.database
      .client`UPDATE factory.project_membership SET role='product-contributor' WHERE project_id=${f.projectID}`;
    await expect(runtime.startPersisted(f.changeID, f.userID)).rejects.toThrow(
      "commissioned Ticket writer",
    );
    expect(creates.size).toBe(0);
    const [approved] = await f.database.client<
      { id: string }[]
    >`SELECT requirement_revision_id AS id FROM factory.requirement_approval WHERE ticket_id=${f.ticketID}`;
    if (!approved) throw new Error("Controlled approval fixture missing");
    const turns = createAgentTurnStore(f.database);
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
        modelId: "factory-coding-model",
        skillRevisionIds: [],
        requiredSkillRevisionIds: [],
        conversationVersion: null,
        requirementRevisionId: approved.id,
      },
      (sql, record) => claimAgentWriterIn(sql, f.changeID, record.id, f.userID),
    );
    const writers = createChangeWriterController({
      database: f.database,
      agentUsername: "owned-agent",
      protect: async () => {},
      stopAgent: async () => {
        throw new Error("No previous Agent exists");
      },
      runtime: {
        stop: async () => {
          throw new Error("No previous runtime exists");
        },
        async get() {
          return null;
        },
      },
    });
    expect(await writers.prepareAgent(f.changeID, turn.id)).toBe(true);
    await expect(runtime.startPersisted(f.changeID, f.userID)).rejects.toThrow(
      "current admitted turn",
    );
    expect(creates.size).toBe(0);
    const owned = await turns.claimPending(turn.id, 60_000);
    if (!owned?.ownerToken) throw new Error("Admitted turn lease missing");
    await expect(runtime.startPersisted(f.changeID, f.userID)).rejects.toThrow(
      "lost Actor create reply",
    );
    const started = await runtime.startPersisted(f.changeID, f.userID);
    expect(started?.id).toBe(f.attemptID);
    expect(started?.native?.state).toBe("ACTOR_STATE_RUNNING");
    expect(creates.get("Actor")).toBe(1);
    expect(sourceResumes).toBe(1);
    const readTicketSource = () =>
      f.database.client.begin((sql) => substrateWorkspaceSourceIn(f.database, sql, f.attemptID));
    expect(await readTicketSource()).toBe(`file://${repo}`);
    const [binding] = await f.database
      .client`SELECT w.kind,w.owner_user_id,a.change_id FROM factory.development_workspace w JOIN factory.runtime_attempt a ON a.workspace_id=w.id WHERE a.id=${f.attemptID}`;
    expect(binding).toMatchObject({
      kind: "ticket",
      owner_user_id: null,
      change_id: f.changeID,
    });
    expect([
      ...(await f.database.client`SELECT to_regclass('factory.workspace_source') AS source,
        to_regclass('factory.factorybox_worker') AS worker`),
    ]).toEqual([{ source: null, worker: null }]);
    const template = objects.get("ActorTemplate") as { containers: { env: { value: string }[] }[] };
    const bootstrap = JSON.parse(template.containers[0]?.env[0]?.value ?? "null");
    expect(bootstrap.assignment.channels).toContainEqual({
      name: "agent",
      kind: "agent",
      target: "http://127.0.0.1:4096",
      healthPath: "/api/info",
    });
    expect(bootstrap.assignment.channels.map((channel: { kind: string }) => channel.kind)).toEqual([
      "ide",
      "agent",
    ]);
    expect(bootstrap.assignment.processes.map((process: { name: string }) => process.name)).toEqual(
      ["agent"],
    );
    const [provision] = await f.database
      .client`SELECT intent->'systemContract' AS contract,intent->'projectTemplate' AS template,
        intent->>'revision' AS revision
      FROM factory.substrate_provision WHERE owner_id=${f.workspaceID} AND kind='workspace'`;
    expect(provision?.["contract"]).toBeNull();
    expect(provision?.["template"]).toEqual(nativeProjectTemplate);
    expect(provision?.["revision"]).toBe(revision);
    expect(bootstrap.assignment.actorTemplatePath).toBe(nativeProjectTemplate.path);
    expect(bootstrap.assignment.revision).toBe(revision);
    expect(bootstrap.projectTemplate).toEqual({
      path: nativeProjectTemplate.path,
      sha256: nativeProjectTemplate.sha256,
    });
    expect(
      bootstrap.assignment.processes.find((p: { name: string }) => p.name === "agent").env
        .FACTORY_OPENCODE_TOKEN,
    ).toBeTruthy();
    expect(bootstrap.sourceHandoff).toBe(true);
    const agentEnvironment = bootstrap.assignment.processes.find(
      (p: { name: string }) => p.name === "agent",
    ).env;
    expect(
      JSON.parse(agentEnvironment.FACTORY_OPENCODE_CONFIG).providers.factory.settings.baseURL,
    ).toBe(`https://factory.test/internal/model/${f.attemptID}/v1`);
    expect(agentEnvironment.FACTORY_BUILD_BROWSER_URL).toBe(
      `https://factory.test/internal/build-browser/${f.attemptID}`,
    );
    const seeded = await sources.lease(f.workspaceID);
    expect(seeded).toMatchObject({
      actorUID: null,
      owner: "service",
      writable: true,
      writerEpoch: 1,
      seedConfirmedAt: null,
    });
    if (!seeded?.seed) throw new Error("Owned initial Ticket Source seed is missing");
    // Controlled complete service export, not Linux archive or native acceptance.
    // The real v2 receipt below must grant the Actor before synthetic readiness.
    const checkpointID = crypto.randomUUID();
    const bytes = new TextEncoder().encode("Owned imported Ticket Source fixture");
    const checkpoint = {
      id: checkpointID,
      workspaceID: f.workspaceID,
      actorUID: null,
      seedID: seeded.seed.id,
      writerEpoch: 2,
      generation: 1,
      bundle: {
        version: 1,
        bytes: bytes.length,
        sha256: objectDigest(bytes),
        chunks: [objectDigest(bytes)],
      },
    };
    await f.database.client`UPDATE factory.substrate_source SET seed_confirmed_at=now()
      WHERE workspace_id=${f.workspaceID}`;
    await f.database.client`UPDATE factory.substrate_source
      SET writable=false,writer_epoch=2,checkpoint_id=${checkpointID}
      WHERE workspace_id=${f.workspaceID}`;
    await blobs.put(
      `workspace-source/v1/${f.workspaceID}/${checkpointID}/manifest.json`,
      new TextEncoder().encode(JSON.stringify(checkpoint)),
      "application/json",
    );
    await blobs.put(
      `workspace-source/v1/${f.workspaceID}/${checkpointID}/chunk-0`,
      bytes,
      "application/octet-stream",
    );
    await f.database.client`UPDATE factory.substrate_source
      SET generation=1,checkpoint=${JSON.stringify(checkpoint)}::jsonb
      WHERE workspace_id=${f.workspaceID}`;
    const headers = {
      authorization: `Bearer ${runtimeConnectorTokens("owned-native-secret", f.attemptID, 1).parent}`,
      "X-Factory-Runtime-Actor-UID": started?.native?.actorUID ?? "",
      "X-Factory-Runtime-Generation": "1",
      "X-Factory-Source-Protocol": "2",
    };
    const restore = await sources.restoreEndpoint(
      new Request(`https://factory.test/internal/substrate-source/${f.attemptID}`, {
        headers,
      }),
      f.attemptID,
    );
    expect(restore.status).toBe(200);
    expect(await restore.json()).toMatchObject({
      version: 2,
      writerEpoch: 3,
      changeWriterEpoch: 2,
      readOnly: true,
      checkpoint,
    });
    expect((await sources.lease(f.workspaceID))?.owner).toBe("service");
    const committed = await sources.restoreEndpoint(
      new Request(`https://factory.test/internal/substrate-source/${f.attemptID}`, {
        method: "POST",
        headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify({ checkpointID, writerEpoch: 3 }),
      }),
      f.attemptID,
    );
    expect(committed.status).toBe(200);
    expect(await sources.lease(f.workspaceID)).toMatchObject({
      actorUID: started?.native?.actorUID,
      owner: "actor",
      writable: true,
      writerEpoch: 3,
    });
    await f.database
      .client`UPDATE factory.agent_turn SET owner_expires_at=clock_timestamp()-interval '1 second' WHERE id=${turn.id}`;
    await expect(readTicketSource()).rejects.toThrow("current admitted turn");
    await expect(runtime.startPersisted(f.changeID, f.userID)).rejects.toThrow(
      "current admitted turn",
    );
    expect(creates.get("Actor")).toBe(1);
    const completed = await turns.claimPending(turn.id, 60_000);
    if (!completed?.ownerToken) throw new Error("Owned completed Build lease missing");
    await turns.beginDispatch(turn.id, completed.ownerToken);
    await turns.settle(turn.id, completed.ownerToken, "completed", "Owned Build completed");
    await runtime.status(f.attemptID, "ready");
    const [notReady] = await f.database.client<{ state: string }[]>`
      SELECT state FROM factory.change WHERE id=${f.changeID}`;
    expect(notReady?.state).toBe("starting");
    f.hub.ready = () => true;
    await runtime.status(f.attemptID, "ready");
    const [active] = await f.database.client<{ state: string }[]>`
      SELECT state FROM factory.change WHERE id=${f.changeID}`;
    expect(active?.state).toBe("active");
    await expect(readTicketSource()).rejects.toThrow("Workspace Source grant required");
    const sessionID = `ses_owned_${turn.id.replaceAll("-", "")}`;
    await f.database.client.begin(async (sql) => {
      await sql`INSERT INTO factory.change_agent_turn_intent(turn_id,change_id,session_id,prompt_id,prompt_text,bootstrap,session_title,runtime_attempt_id) VALUES(${turn.id},${f.changeID},${sessionID},${`msg_owned_${turn.id.replaceAll("-", "")}`},'Owned Build',true,'Owned native Build',${f.attemptID})`;
      await sql`INSERT INTO factory.change_agent_session(change_id,runtime_attempt_id,opencode_session_id,state,created_by,active_turn_id,native_session_confirmed_at) VALUES(${f.changeID},${f.attemptID},${sessionID},'committed',${f.userID},${turn.id},now())`;
      await sql`INSERT INTO factory.change_commit_operation(id,change_id,runtime_attempt_id,sequence,branch_name,expected_parent_sha,commit_sha,observed_remote_sha,commit_message,idempotency_key,state,created_by,completed_at) SELECT ${turn.id},id,runtime_attempt_id,1,branch_name,base_sha,${"d".repeat(40)},${"d".repeat(40)},'Owned Build',${`owned:${turn.id}`},'succeeded',created_by,now() FROM factory.change WHERE id=${f.changeID}`;
    });
    // Completion alone cannot wake a Ticket. The existing Delivery owner must
    // first persist its exact pending integration under the Project queue.
    await expect(runtime.startPersisted(f.changeID, f.userID)).rejects.toThrow(
      "current admitted turn",
    );
    expect(await createDeliveryCoordination(f.database).claim(f.projectID, f.changeID)).toBe(true);
    await expect(runtime.startPersisted(f.changeID, f.userID)).rejects.toThrow(
      "current admitted turn",
    );
    let integrationFrames = 0;
    f.hub.parentOperation = async (_id, operation, beforeSend) => {
      await beforeSend?.(() => integrationFrames++);
      expect(operation["repositoryURL"]).toBe(`file://${repo}`);
      return { commitSHA: "f".repeat(40), remoteSHA: "f".repeat(40) };
    };
    // This controller fixture uses a local owned remote; the separate TLS-frame
    // test covers native public-Forge routing. Never relax the real native URL
    // policy to make this fixture deliver its synthetic candidate.
    const integration = createChangeIntegration(
      f.database,
      f.hub,
      {
        prompt: async () => {
          throw new Error("Integration cannot start inference");
        },
      },
      runtime,
    );
    expect(await integration.reconcile(f.changeID, "e".repeat(40))).toBe(false);
    expect(integrationFrames).toBe(0);
    expect((await runtime.startPersisted(f.changeID, f.userID))?.id).toBe(f.attemptID);
    const [integrationIntent] = await f.database.client<{ state: string; error: string | null }[]>`
      SELECT state,last_error AS error FROM factory.change_commit_operation
      WHERE change_id=${f.changeID} AND source='integration'`;
    // Provisioning successfully reuses the admitted Actor; the synthetic local
    // destination is then refused by the normal strict native Git boundary.
    expect(integrationIntent?.state).toBe("commit-intended");
    expect(integrationIntent?.error).toBeTruthy();
    expect(creates.get("Actor")).toBe(1);
    await createDeliveryCoordination(f.database).release(f.changeID);
    await expect(runtime.startPersisted(f.changeID, f.userID)).rejects.toThrow(
      "current admitted turn",
    );
    expect(await createDeliveryCoordination(f.database).claim(f.projectID, f.changeID)).toBe(true);
    expect((await runtime.startPersisted(f.changeID, f.userID))?.id).toBe(f.attemptID);
    await f.database.client.begin(async (sql) => {
      const refusals = [
        () =>
          sql`UPDATE factory.operation
            SET active_key=NULL, state='idle',
              payload=jsonb_build_object('projectId', ${f.projectID}::text, 'changeId', NULL)
            WHERE kind='project.delivery_queue' AND idempotency_key=${`project.delivery_queue:${f.projectID}`}`,
        () =>
          sql`UPDATE factory.change_agent_session SET state='stopped',stop_pending=true,stop_id=${crypto.randomUUID()} WHERE change_id=${f.changeID}`,
        () =>
          sql`UPDATE factory.runtime_attempt SET state='stopping',stop_intended_at=now() WHERE id=${f.attemptID}`,
        () =>
          sql`UPDATE factory.change_commit_operation SET state='failed',completed_at=now() WHERE change_id=${f.changeID} AND source='integration'`,
        () => sql`INSERT INTO factory.requirement_revision(id,ticket_id,ordinal,canonical_content,content_digest,created_by)
          SELECT ${crypto.randomUUID()},ticket_id,ordinal+1,canonical_content,content_digest,created_by
          FROM factory.requirement_revision WHERE id=${approved.id}`,
        () =>
          sql`DELETE FROM factory.project_membership WHERE project_id=${f.projectID} AND user_id=${f.userID}`,
      ];
      for (const refuse of refusals) {
        await sql`SAVEPOINT native_integration_grant`;
        await refuse();
        await expect(
          substrateWorkspaceGrantIn(f.database, sql, f.workspaceID, f.userID, true),
        ).rejects.toThrow();
        await sql`ROLLBACK TO SAVEPOINT native_integration_grant`;
      }
    });
    // The local-only regression never sent a Git frame. Settle that refused
    // fixture operation before projecting the later human writer below.
    await f.database
      .client`UPDATE factory.change_commit_operation SET state='failed',completed_at=now()
      WHERE change_id=${f.changeID} AND source='integration' AND state='commit-intended'`;
    await expect(runtime.startPersisted(f.changeID, f.userID)).rejects.toThrow(
      "current admitted turn",
    );
    // Controlled authority projection only: the writer owner, not Actor creation
    // attribution, determines a later connection. This is not a native handoff or
    // queued-input settlement proof.
    const developer = crypto.randomUUID();
    await f.database.client.begin(async (sql) => {
      await sql`INSERT INTO auth."user"(id,name,email,email_verified) VALUES(${developer},'Next native writer',${`${developer}@factory.local`},true)`;
      await sql`INSERT INTO factory.project_membership(project_id,user_id,role,updated_by) VALUES(${f.projectID},${developer},'developer',${f.userID})`;
      await sql`UPDATE factory.runtime_attempt SET state='starting' WHERE id=${f.attemptID}`;
      await sql`UPDATE factory.change_writer SET state='human',epoch=epoch+1,turn_id=NULL,user_id=${developer} WHERE change_id=${f.changeID}`;
    });
    const currentRestore = () =>
      sources.restoreEndpoint(
        new Request(`https://factory.test/internal/substrate-source/${f.attemptID}`, {
          headers: {
            authorization: `Bearer ${runtimeConnectorTokens("owned-native-secret", f.attemptID, 1).parent}`,
            "X-Factory-Runtime-Actor-UID": started?.native?.actorUID ?? "",
            "X-Factory-Runtime-Generation": "1",
            "X-Factory-Source-Protocol": "2",
          },
        }),
        f.attemptID,
      );
    const sourceBefore = await sources.lease(f.workspaceID);
    if (!sourceBefore) throw new Error("Owned retained Ticket Source is missing");
    expect(sourceBefore).toMatchObject({
      actorUID: started?.native?.actorUID,
      owner: "actor",
      writable: true,
      checkpointID: null,
    });
    const currentIdentity = () =>
      f.database.client`SELECT w.epoch::integer AS epoch,w.state,w.user_id,a.generation,a.actor_uid
        FROM factory.change_writer w
        JOIN factory.runtime_attempt a ON a.change_id=w.change_id
        WHERE a.id=${f.attemptID}`;
    const [writerBefore] = await currentIdentity();
    if (!writerBefore) throw new Error("Owned current Ticket writer is missing");
    expect(writerBefore).toMatchObject({ state: "human", user_id: developer });
    const handed = await currentRestore();
    expect(handed.status).toBe(200);
    // Retained identity grants current writing authority, never another initial import.
    expect(await handed.json()).toEqual({
      version: 2,
      retained: true,
      actorUID: sourceBefore.actorUID,
      writerEpoch: sourceBefore.writerEpoch,
      changeWriterEpoch: writerBefore["epoch"],
      readOnly: false,
      checkpoint: null,
    });
    expect(await sources.lease(f.workspaceID)).toEqual(sourceBefore);
    expect([...(await currentIdentity())]).toEqual([writerBefore]);
    const currentGrant = () =>
      f.database.client.begin((sql) =>
        substrateWorkspaceGrantIn(f.database, sql, f.workspaceID, developer, true),
      );
    expect(await currentGrant()).toMatchObject({ projectID: f.projectID, changeID: f.changeID });
    const [creator] = await f.database
      .client`SELECT created_by FROM factory.runtime_attempt WHERE id=${f.attemptID}`;
    expect(creator?.["created_by"]).toBe(f.userID);
    await f.database
      .client`UPDATE factory.project_membership SET role='product-contributor' WHERE project_id=${f.projectID} AND user_id=${developer}`;
    await expect(currentGrant()).rejects.toThrow("Developer access required");
    await expect(currentRestore()).rejects.toThrow("Developer access required");
  } finally {
    await sources.close();
    await removeRuntimeRepository(f.attemptID);
    await f.dispose();
    await rm(directory, { recursive: true, force: true });
  }
}, 60_000);

test.each([
  "saved contract",
  "saved absence",
  "saved template",
  "saved missing template",
  "saved invalid template",
  "saved unconfirmed template",
  "no Source",
  "missing repository contract",
  "invalid repository contract",
  "missing repository template",
  "invalid repository template",
  "oversized repository template",
  "Source failure",
  "unavailable revision",
  "unavailable repository",
] as const)(
  "Workspace Start selects authoritative Source configuration: %s",
  async (scenario) => {
    const directory = await mkdtemp(join(tmpdir(), "factory-source-before-setup-"));
    const repository = join(directory, "repository");
    const contract = {
      version: 1 as const,
      primaryApp: "python",
      apps: [
        {
          id: "python",
          label: "Python",
          command: ["python", "app.py"],
          port: 9000,
          healthPath: "/",
        },
      ],
    };
    await Bun.$`git init -b main ${repository}`.quiet();
    await writeFile(join(repository, "README"), "Saved before setup\n");
    await mkdir(join(repository, ".factory"));
    if (scenario !== "missing repository template")
      await writeFile(
        join(repository, nativeProjectTemplate.path),
        scenario === "invalid repository template"
          ? "{invalid JSON"
          : scenario === "oversized repository template"
            ? " ".repeat(65537)
            : nativeProjectTemplate.content,
      );
    if (!["saved contract", "missing repository contract"].includes(scenario)) {
      await writeFile(
        join(repository, ".factory/system.json"),
        scenario === "invalid repository contract" ? "{invalid JSON" : JSON.stringify(contract),
      );
    }
    await Bun.$`git -C ${repository} add .`.quiet();
    await Bun.$`git -C ${repository} -c user.name=Owned -c user.email=owned@example.invalid commit -m source`.quiet();
    const revision =
      scenario === "unavailable revision"
        ? "e".repeat(40)
        : (await Bun.$`git -C ${repository} rev-parse HEAD`.text()).trim();
    const f = await substrateFixture(revision);
    const sources = createSubstrateSources(f.database, f.hub);
    if (scenario === "saved contract") {
      await writeFile(join(repository, ".factory/system.json"), JSON.stringify(contract));
      await Bun.$`git -C ${repository} add .`.quiet();
      await Bun.$`git -C ${repository} -c user.name=Owned -c user.email=owned@example.invalid commit -m setup`.quiet();
    }
    await f.database
      .client`UPDATE factory.project SET repository_url=${`file://${repository}`} WHERE id=${f.projectID}`;
    const ca = join(directory, "ca.pem");
    await writeFile(ca, "-----BEGIN CERTIFICATE-----\nowned-test\n-----END CERTIFICATE-----\n");
    let canonicalReads = 0;
    const savedTemplateContent = `${nativeProjectTemplate.content}\n`;
    const savedTemplate = {
      ...nativeProjectTemplate,
      content: savedTemplateContent,
      sha256: createHash("sha256").update(savedTemplateContent).digest("hex"),
    };
    Object.assign(sources, {
      async startupConfiguration(workspaceID: string, actorTemplatePath: string) {
        expect(workspaceID).toBe(f.workspaceID);
        expect(actorTemplatePath).toBe(nativeProjectTemplate.path);
        canonicalReads++;
        if (scenario === "Source failure") throw new Error("owned-source-read-failure");
        if (scenario === "saved contract")
          return { systemContract: contract, actorTemplate: nativeProjectTemplate };
        if (scenario === "saved absence")
          return { systemContract: null, actorTemplate: nativeProjectTemplate };
        if (scenario === "saved template")
          return { systemContract: contract, actorTemplate: savedTemplate };
        if (scenario === "saved missing template")
          return { systemContract: contract, actorTemplate: null };
        if (scenario === "saved invalid template") {
          const content = "{invalid JSON";
          return {
            systemContract: contract,
            actorTemplate: {
              ...nativeProjectTemplate,
              content,
              sha256: createHash("sha256").update(content).digest("hex"),
            },
          };
        }
        if (scenario === "saved unconfirmed template")
          return {
            systemContract: contract,
            actorTemplate: { ...nativeProjectTemplate, sha256: "f".repeat(64) },
          };
        return undefined;
      },
    });
    const call: SubstrateCall = async (method) => {
      if (method.startsWith("Get")) throw new SubstrateRPCError("NotFound", "absent");
      throw new Error("owned-provisioning-boundary");
    };
    const runtime = createRuntimeController(f.database, f.hub, "owned-native-secret", {
      configuration: {
        deployment: "fresh-workspaces",
        database: f.config.database,
        connection: f.config.connection,
        provisioner: { ...f.config.connection, tokenFile: "/owner-token" },
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
      },
      sources,
      call,
      provisionerCall: call,
    });
    try {
      if (scenario === "unavailable repository")
        await rm(repository, { recursive: true, force: true });
      const failure =
        scenario === "Source failure"
          ? "owned-source-read-failure"
          : scenario === "invalid repository contract"
            ? ".factory/system.json is not valid JSON"
            : scenario === "saved missing template" || scenario === "missing repository template"
              ? "is required for Workspace Start"
              : scenario === "saved invalid template" || scenario === "invalid repository template"
                ? "Project ActorTemplate must be valid JSON"
                : scenario === "oversized repository template"
                  ? "Project ActorTemplate exceeds 64 KiB"
                  : scenario === "saved unconfirmed template"
                    ? "Project ActorTemplate version is unconfirmed"
                    : scenario.startsWith("unavailable")
                      ? "Cannot read .factory/system.json"
                      : null;
      await expect(runtime.start(f.projectID, f.userID, f.workspaceID)).rejects.toThrow(
        failure ?? "owned-provisioning-boundary",
      );
      expect(canonicalReads).toBe(1);
      const [provision] = await f.database.client<
        { intent: { systemContract: unknown; revision: string; projectTemplate: unknown } }[]
      >`
      SELECT intent FROM factory.substrate_provision WHERE owner_id=${f.workspaceID} AND kind='workspace'`;
      if (failure) expect(provision).toBeUndefined();
      else {
        expect(provision?.intent.systemContract).toEqual(
          scenario === "saved absence" || scenario === "missing repository contract"
            ? null
            : contract,
        );
        expect(provision?.intent.revision).toBe(revision);
        expect(provision?.intent.projectTemplate).toEqual(
          scenario === "saved template" ? savedTemplate : nativeProjectTemplate,
        );
        if (scenario === "saved template") {
          // A lost Create reply retains the admitted bytes. Recovery must not
          // rerun setup or replace the immutable template with later Source edits.
          sources.startupConfiguration = async () => {
            throw new Error("must-not-recapture-source");
          };
          await expect(runtime.start(f.projectID, f.userID, f.workspaceID)).rejects.not.toThrow(
            "must-not-recapture-source",
          );
          expect(canonicalReads).toBe(1);
          const [retained] = await f.database.client`
            SELECT intent FROM factory.substrate_provision WHERE owner_id=${f.workspaceID} AND kind='workspace'`;
          expect(retained?.["intent"]).toEqual(provision?.intent);
        }
      }
      expect(await f.database.client`SELECT id FROM factory.runtime_attempt`).toHaveLength(0);
    } finally {
      await sources.close();
      await f.dispose();
      await rm(directory, { recursive: true, force: true });
    }
  },
  60_000,
);

test("Forge contract absence requires an available exact tree and never masks invalid or failed reads", async () => {
  const f = await substrateFixture();
  const directory = await mkdtemp(join(tmpdir(), "factory-optional-forge-contract-"));
  const ca = join(directory, "ca.pem");
  await writeFile(ca, "-----BEGIN CERTIFICATE-----\nowned-test\n-----END CERTIFICATE-----\n");
  let mode = "invalid";
  const reads: string[] = [];
  const server = Bun.serve({
    port: 0,
    fetch(request) {
      const url = new URL(request.url);
      reads.push(url.pathname);
      if (url.pathname.endsWith("/contents/.factory/actor-template.json"))
        return Response.json({
          content: Buffer.from(nativeProjectTemplate.content).toString("base64"),
          encoding: "base64",
          sha: "c".repeat(40),
        });
      if (url.pathname.endsWith("/contents/.factory/system.json")) {
        expect(url.searchParams.get("ref")).toBe("a".repeat(40));
        if (mode === "access") return new Response(null, { status: 403 });
        if (mode === "transport") return new Response(null, { status: 503 });
        if (mode === "invalid")
          return Response.json({
            content: Buffer.from("{invalid JSON").toString("base64"),
            encoding: "base64",
            sha: "b".repeat(40),
          });
        return new Response(null, { status: 404 });
      }
      if (url.pathname.endsWith(`/git/trees/${"a".repeat(40)}`)) {
        if (mode === "missing revision") return new Response(null, { status: 404 });
        return Response.json({
          tree:
            mode === "inconsistent"
              ? [{ path: ".factory/system.json", type: "blob", sha: "b".repeat(40) }]
              : [],
        });
      }
      throw new Error("Unexpected owned Forge request");
    },
  });
  let nativeCalls = 0;
  const call: SubstrateCall = async (method) => {
    nativeCalls++;
    if (method.startsWith("Get")) throw new SubstrateRPCError("NotFound", "absent");
    throw new Error("owned-provisioning-boundary");
  };
  process.env["FACTORY_FORGEJO_API_URL"] = `${server.url.origin}/api/v1`;
  const runtime = createRuntimeController(f.database, f.hub, "owned-native-secret", {
    configuration: {
      deployment: "fresh-workspaces",
      database: f.config.database,
      connection: f.config.connection,
      provisioner: { ...f.config.connection, tokenFile: "/owner-token" },
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
    },
    call,
    provisionerCall: call,
  });
  try {
    await f.database
      .client`UPDATE factory.project SET repository_url=${`${server.url.origin}/owned-runtime-fixture/fixture.git`} WHERE id=${f.projectID}`;
    for (mode of ["invalid", "access", "transport", "missing revision", "inconsistent"]) {
      await expect(runtime.start(f.projectID, f.userID, f.workspaceID)).rejects.toThrow(
        mode === "invalid" ? "not valid JSON" : "Cannot read .factory/system.json",
      );
      expect(nativeCalls).toBe(0);
      expect(
        await f.database
          .client`SELECT owner_id FROM factory.substrate_provision WHERE kind='workspace'`,
      ).toHaveLength(0);
    }
    mode = "absent";
    await expect(runtime.start(f.projectID, f.userID, f.workspaceID)).rejects.toThrow(
      "owned-provisioning-boundary",
    );
    const [provision] = await f.database
      .client`SELECT intent->'systemContract' AS contract FROM factory.substrate_provision WHERE owner_id=${f.workspaceID} AND kind='workspace'`;
    expect(provision?.["contract"]).toBeNull();
    expect(reads.at(-2)).toEndWith(`/git/trees/${"a".repeat(40)}`);
    expect(reads.at(-1)).toEndWith("/contents/.factory/actor-template.json");
    expect(await f.database.client`SELECT id FROM factory.runtime_attempt`).toHaveLength(0);
  } finally {
    await server.stop(true);
    await f.dispose();
    await rm(directory, { recursive: true, force: true });
  }
}, 60_000);

test("first Source access admits a personal Source owner without creating native compute", async () => {
  const f = await substrateFixture();
  const directory = await mkdtemp(join(tmpdir(), "factory-first-source-"));
  const repository = join(directory, "repository");
  await Bun.$`git init -b main ${repository}`.quiet();
  await writeFile(join(repository, "README"), "Fresh Source before compute\n");
  await Bun.$`git -C ${repository} add .`.quiet();
  await Bun.$`git -C ${repository} -c user.name=Owned -c user.email=owned@example.invalid commit -m initial`.quiet();
  const revision = (await Bun.$`git -C ${repository} rev-parse HEAD`.text()).trim();
  await f.database
    .client`UPDATE factory.project SET repository_url=${`file://${repository}`} WHERE id=${f.projectID}`;
  await f.database.client`DELETE FROM factory.development_workspace WHERE id=${f.workspaceID}`;
  const sources = createSubstrateSources(f.database, f.hub);
  // This controller seam observes admission, not the Linux file service. Real
  // clone/read/save/first-Actor import is qualified in the native Source lane.
  sources.available = async (workspaceID) => {
    const row = await sources.lease(workspaceID);
    return row?.owner === "service" && row.actorUID === null;
  };
  const forwarded: string[] = [];
  sources.forward = async (workspaceID, attemptID, operation, request) => {
    expect(workspaceID).toBe(f.workspaceID);
    expect(attemptID).toBeNull();
    if (operation === "write") expect(request.headers.get("X-Factory-Writer-Epoch")).toBe("1");
    forwarded.push(operation);
    return Response.json({ accepted: true });
  };
  const source = createWorkspaceSourceController(f.database, f.hub, sources);
  try {
    expect(await source.ensurePersonal(f.projectID, f.userID)).toMatchObject({
      workspaceID: f.workspaceID,
      state: "ready",
      epoch: 1,
      failure: null,
    });
    expect([
      ...(await f.database
        .client`SELECT id,source_revision,source_branch FROM factory.development_workspace`),
    ]).toEqual([{ id: f.workspaceID, source_revision: revision, source_branch: "main" }]);
    expect(await f.database.client`SELECT id FROM factory.runtime_attempt`).toHaveLength(0);
    expect(
      await f.database
        .client`SELECT owner_id FROM factory.substrate_provision WHERE kind='workspace'`,
    ).toHaveLength(0);
    expect(await source.ensurePersonal(f.projectID, f.userID)).toMatchObject({
      workspaceID: f.workspaceID,
      state: "ready",
      epoch: 1,
    });
    expect(await f.database.client`SELECT workspace_id FROM factory.substrate_source`).toHaveLength(
      1,
    );
    const resume = f.database.coordination();
    let admission: ReturnType<typeof admitInitialSource> | undefined;
    try {
      await resume`SELECT pg_advisory_lock(hashtext(${`runtime:${f.workspaceID}`}))`;
      admission = admitInitialSource(f.database, f.userID, { projectID: f.projectID });
      expect(
        await Promise.race([
          admission,
          Bun.sleep(1000).then(() => {
            throw new Error("Existing Source admission waited behind native Resume");
          }),
        ]),
      ).toBe(f.workspaceID);
    } finally {
      await resume`SELECT pg_advisory_unlock(hashtext(${`runtime:${f.workspaceID}`}))`;
      await resume.end({ timeout: 1 });
      await admission;
    }
    await f.database
      .client`UPDATE factory.account_access SET disabled_at=now() WHERE user_id=${f.userID}`;
    await expect(
      admitInitialSource(f.database, f.userID, { projectID: f.projectID }),
    ).rejects.toThrow("Account access is disabled");
    await f.database
      .client`UPDATE factory.account_access SET disabled_at=NULL WHERE user_id=${f.userID}`;
    for (const operation of ["read", "write"])
      expect(
        (
          await source.forward(
            f.workspaceID,
            f.userID,
            operation,
            new Request("https://factory.test/source", {
              method: "POST",
              body: '{"path":"README"}',
            }),
          )
        ).status,
      ).toBe(200);
    expect(forwarded).toEqual(["read", "write"]);
    expect([
      ...(await f.database.client`SELECT to_regclass('factory.workspace_source') AS source,
        to_regclass('factory.factorybox_worker') AS worker`),
    ]).toEqual([{ source: null, worker: null }]);
  } finally {
    await source.close();
    await f.dispose();
    await rm(directory, { recursive: true, force: true });
  }
}, 60_000);

test.each([
  "fresh",
  "confirmed",
  "reused",
  "pending-source",
  "running",
  "wrong-attempt",
  "no-observer",
  "wake-race",
  "confirmation-race",
  "implementation-race",
  "stop-race",
] as const)(
  "native paused Stop settles only an exact never-submitted bootstrap: %s",
  async (condition) => {
    const f = await substrateFixture("a".repeat(40), "ticket");
    let observations = 0;
    let requests = 0;
    f.hub.connected = () => false;
    f.hub.request = async () => {
      requests++;
      throw new Error("Paused bootstrap must not send native input or wake compute");
    };
    try {
      const [approval] = await f.database.client<
        { revision: string }[]
      >`SELECT requirement_revision_id AS revision FROM factory.requirement_approval WHERE ticket_id=${f.ticketID}`;
      if (!approval) throw new Error("Owned approval fixture missing");
      const { turn } = await createAgentTurnStore(f.database).admit(
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
          modelId: "factory-coding-model",
          skillRevisionIds: [],
          requiredSkillRevisionIds: [],
          conversationVersion: null,
          requirementRevisionId: approval.revision,
        },
      );
      const sessionID = `ses_owned_${crypto.randomUUID().replaceAll("-", "")}`;
      const actorUID = crypto.randomUUID();
      await f.database.client.begin(async (sql) => {
        await sql`INSERT INTO factory.substrate_provision(owner_id,kind,intent) VALUES(${f.workspaceID},'workspace','{}')`;
        await sql`INSERT INTO factory.runtime_attempt(id,project_id,workspace_id,change_id,generation,revision,state,parent_connector_token_hash,create_intended_at,created_by,atespace,actor_name,binding_intent,actor_uid,create_attempted_at) VALUES(${f.attemptID},${f.projectID},${f.workspaceID},${f.changeID},1,${"a".repeat(40)},'create-intended',${"b".repeat(64)},now(),${f.userID},${f.atespace},${`runtime-${f.attemptID.replaceAll("-", "")}`},'{}',${actorUID},now())`;
        await sql`UPDATE factory.runtime_attempt SET state='paused' WHERE id=${f.attemptID}`;
        await sql`UPDATE factory.change SET runtime_attempt_id=${f.attemptID} WHERE id=${f.changeID}`;
        await sql`INSERT INTO factory.change_agent_turn_intent(turn_id,change_id,session_id,prompt_id,prompt_text,bootstrap,session_title,runtime_attempt_id) VALUES(${turn.id},${f.changeID},${sessionID},${`msg_owned_${turn.id.replaceAll("-", "")}`},'Owned bootstrap',${condition !== "reused"},'Owned native bootstrap',${f.attemptID})`;
        await sql`INSERT INTO factory.change_agent_session(change_id,runtime_attempt_id,opencode_session_id,state,created_by,active_turn_id,native_session_confirmed_at) VALUES(${f.changeID},${f.attemptID},${sessionID},'starting',${f.userID},${turn.id},CASE WHEN ${condition === "confirmed"} THEN now() ELSE NULL END)`;
      });
      const view: RuntimeAttemptView = {
        id: condition === "wrong-attempt" ? crypto.randomUUID() : f.attemptID,
        projectId: f.projectID,
        changeId: f.changeID,
        workspaceId: f.workspaceID,
        workspaceKind: "ticket",
        ownerUserId: null,
        generation: "1",
        revision: "a".repeat(40),
        runtimeKind: "ticket",
        state: "paused",
        failure: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        native: {
          engine: "substrate",
          actorUID,
          state: condition === "running" ? "ACTOR_STATE_RUNNING" : "ACTOR_STATE_SUSPENDED",
          coldRestart: true,
          portable: false,
          sourceHandoff: condition === "pending-source" ? "pending" : "confirmed-same-node",
        },
      };
      const observe = async (attemptID: string) => {
        observations++;
        expect(attemptID).toBe(f.attemptID);
        if (condition === "wake-race")
          await f.database
            .client`UPDATE factory.runtime_attempt SET state='starting' WHERE id=${attemptID}`;
        if (condition === "confirmation-race")
          await f.database
            .client`UPDATE factory.change_agent_session SET native_session_confirmed_at=now() WHERE change_id=${f.changeID}`;
        if (condition === "implementation-race")
          await f.database
            .client`UPDATE factory.change_agent_session SET implementation_session_id=${sessionID},implementation_session_confirmed_at=now() WHERE change_id=${f.changeID}`;
        if (condition === "stop-race")
          await f.database
            .client`UPDATE factory.change_agent_session SET stop_id=${crypto.randomUUID()} WHERE change_id=${f.changeID}`;
        return view;
      };
      const stop = createChangeAgentStop(
        f.database,
        f.hub,
        undefined,
        condition === "no-observer" ? undefined : observe,
      );
      await stop.persist(f.changeID);
      expect(await stop.confirm(f.changeID, undefined, "observe")).toBe(condition === "fresh");
      const [saved] = await f.database.client<
        { pending: boolean }[]
      >`SELECT stop_pending AS pending FROM factory.change_agent_session WHERE change_id=${f.changeID}`;
      expect(saved?.pending).toBe(condition !== "fresh");
      expect(observations).toBe(["confirmed", "reused", "no-observer"].includes(condition) ? 0 : 1);
      expect(requests).toBe(0);
    } finally {
      await f.dispose();
    }
  },
  60_000,
);

test("native Build push and Delivery integration validate their admitted TLS destination before the actual Parent frame", async () => {
  const f = await substrateFixture("a".repeat(40), "ticket");
  const previous = {
    api: process.env["FACTORY_FORGEJO_API_URL"],
    public: process.env["FACTORY_FORGEJO_PUBLIC_URL"],
  };
  process.env["FACTORY_FORGEJO_API_URL"] = "http://forgejo.cluster.svc:3000/api/v1/";
  process.env["FACTORY_FORGEJO_PUBLIC_URL"] = "https://git.example";
  const repository = "http://forgejo.cluster.svc:3000/team/project.git";
  const nativeIntent = {
    connectorURL: "wss://factory.example/internal/runtime-connect",
    egressHosts: ["git.example"],
  };
  const frames: unknown[] = [];
  f.hub.parentOperation = async (_id, operation, beforeSend) => {
    await beforeSend?.(() => {
      frames.push(operation);
    });
    return { remoteSHA: "d".repeat(40) };
  };
  try {
    const [approval] = await f.database.client<
      { revision: string }[]
    >`SELECT requirement_revision_id AS revision FROM factory.requirement_approval WHERE ticket_id=${f.ticketID}`;
    if (!approval) throw new Error("Owned approval fixture missing");
    const { turn } = await createAgentTurnStore(f.database).admit(
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
        modelId: "factory-coding-model",
        skillRevisionIds: [],
        requiredSkillRevisionIds: [],
        conversationVersion: null,
        requirementRevisionId: approval.revision,
      },
    );
    const branch = `factory/change-${f.changeID.replaceAll("-", "").slice(0, 12)}`;
    const sessionID = `ses_owned_${turn.id.replaceAll("-", "")}`;
    const leased = await createAgentTurnStore(f.database).claimPending(turn.id);
    if (!leased?.ownerToken) throw new Error("Owned Build lease missing");
    await f.database.client.begin(async (sql) => {
      await sql`UPDATE factory.project SET repository_url=${repository} WHERE id=${f.projectID}`;
      await sql`INSERT INTO factory.substrate_provision(owner_id,kind,intent) VALUES(${f.workspaceID},'workspace','{}')`;
      await sql`INSERT INTO factory.runtime_attempt(id,project_id,workspace_id,change_id,generation,revision,state,parent_connector_token_hash,create_intended_at,created_by,atespace,actor_name,binding_intent,actor_uid,create_attempted_at) VALUES(${f.attemptID},${f.projectID},${f.workspaceID},${f.changeID},1,${"a".repeat(40)},'create-intended',${"b".repeat(64)},now(),${f.userID},${f.atespace},${`runtime-${f.attemptID.replaceAll("-", "")}`},${JSON.stringify(nativeIntent)}::jsonb,${crypto.randomUUID()},now())`;
      await sql`UPDATE factory.runtime_attempt SET state='ready' WHERE id=${f.attemptID}`;
      await sql`UPDATE factory.change SET runtime_attempt_id=${f.attemptID} WHERE id=${f.changeID}`;
      await sql`UPDATE factory.change_writer SET state='agent',turn_id=${turn.id},user_id=NULL,epoch=epoch+1 WHERE change_id=${f.changeID}`;
      await sql`UPDATE factory.agent_turn SET state='dispatching' WHERE id=${turn.id}`;
      await sql`UPDATE factory.agent_turn SET state='completed',owner_token=NULL,owner_expires_at=NULL WHERE id=${turn.id}`;
      await sql`INSERT INTO factory.change_agent_turn_intent(turn_id,change_id,session_id,prompt_id,prompt_text,bootstrap,session_title,runtime_attempt_id) VALUES(${turn.id},${f.changeID},${sessionID},${`msg_owned_${turn.id.replaceAll("-", "")}`},'Owned Build',true,'Owned native Build',${f.attemptID})`;
      await sql`INSERT INTO factory.change_agent_session(change_id,runtime_attempt_id,opencode_session_id,state,created_by,active_turn_id,native_session_confirmed_at) VALUES(${f.changeID},${f.attemptID},${sessionID},'waiting',${f.userID},${turn.id},now())`;
      await sql`INSERT INTO factory.change_commit_operation(id,change_id,runtime_attempt_id,sequence,branch_name,expected_parent_sha,commit_sha,commit_message,idempotency_key,state,created_by) VALUES(${turn.id},${f.changeID},${f.attemptID},1,${branch},${"a".repeat(40)},${"d".repeat(40)},'Owned Build',${`owned:${turn.id}`},'push-intended',${f.userID})`;
    });
    const transport = createAgentCommitTransport(f.database, f.hub);
    const push = {
      operationId: turn.id,
      action: "git-push" as const,
      expectedSha: "a".repeat(40),
      commitSha: "d".repeat(40),
      branch,
      repositoryURL: repository,
    };
    await expect(transport(f.attemptID, push)).rejects.toThrow("push destination");
    expect(frames).toHaveLength(0);
    expect(
      await transport(f.attemptID, {
        ...push,
        repositoryURL: "https://git.example/team/project.git",
      }),
    ).toEqual({ remoteSHA: "d".repeat(40) });
    expect(frames).toHaveLength(1);
    process.env["FACTORY_FORGEJO_PUBLIC_URL"] = "https://not-admitted.example";
    await expect(
      transport(f.attemptID, {
        ...push,
        repositoryURL: "https://not-admitted.example/team/project.git",
      }),
    ).rejects.toThrow("admitted Forge TLS origin");
    expect(frames).toHaveLength(1);
    expect([
      ...(await f.database.client`SELECT to_regclass('factory.factorybox_worker') AS worker`),
    ]).toEqual([{ worker: null }]);
    process.env["FACTORY_FORGEJO_PUBLIC_URL"] = "https://git.example";
    await f.database.client.begin(async (sql) => {
      await sql`UPDATE factory.change_commit_operation SET state='succeeded',observed_remote_sha=commit_sha,completed_at=now() WHERE id=${turn.id}`;
      await sql`UPDATE factory.change_agent_session SET state='committed' WHERE change_id=${f.changeID}`;
    });
    expect(await createDeliveryCoordination(f.database).claim(f.projectID, f.changeID)).toBe(true);
    let changeDestination = false;
    f.hub.parentOperation = async (_id, operation, beforeSend) => {
      expect(operation["repositoryURL"]).toBe("https://git.example/team/project.git");
      if (changeDestination)
        await f.database
          .client`UPDATE factory.project SET repository_url='http://forgejo.cluster.svc:3000/team/changed.git' WHERE id=${f.projectID}`;
      await beforeSend?.(() => {
        frames.push(operation);
      });
      return { commitSHA: "f".repeat(40), remoteSHA: "f".repeat(40) };
    };
    const integration = createChangeIntegration(
      f.database,
      f.hub,
      {
        prompt: async () => {
          throw new Error("Git integration cannot dispatch inference");
        },
      },
      { startPersisted: async () => null },
    );
    expect(await integration.reconcile(f.changeID, "e".repeat(40))).toBe(true);
    expect(frames).toHaveLength(3);
    changeDestination = true;
    expect(await integration.reconcile(f.changeID, "b".repeat(40))).toBe(false);
    expect(frames).toHaveLength(3);
    const [rejected] = await f.database.client<{ state: string; error: string }[]>`
      SELECT state,last_error AS error FROM factory.change_commit_operation
      WHERE change_id=${f.changeID} AND source='integration' ORDER BY sequence DESC LIMIT 1`;
    expect(rejected).toEqual({
      state: "failed",
      error: "Integration destination changed before dispatch.",
    });
  } finally {
    for (const [key, value] of [
      ["FACTORY_FORGEJO_API_URL", previous.api],
      ["FACTORY_FORGEJO_PUBLIC_URL", previous.public],
    ] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await f.dispose();
  }
}, 60_000);

test("product Stop without independent Source refuses deletion rather than reporting a Pause as Stop", async () => {
  const f = await substrateFixture();
  f.config.deployment = "fresh-workspaces";
  let actor: ReturnType<typeof f.actor> | undefined;
  let deletes = 0;
  const c = await f.controller(async (method) => {
    if (method === "GetAtespace") return f.space;
    if (method === "GetActorTemplate") return f.template;
    if (method === "GetActor") {
      if (!actor) throw new SubstrateRPCError("NotFound", "absent");
      return structuredClone(actor);
    }
    if (method === "CreateActor") {
      actor = await f.createdActor();
      return actor;
    }
    if (method === "ResumeActor" && actor) {
      actor.metadata.version = "2";
      actor.status = {
        state: "ACTOR_STATE_RUNNING",
        workerAssignment: { sandboxRuntime: f.config.runtime },
      };
      return { actor };
    }
    if (method === "SuspendActor" && actor) {
      const uuid = crypto.randomUUID();
      actor.metadata.version = "2";
      actor.status = {
        state: "ACTOR_STATE_SUSPENDED",
        lastAssignedGeneration: 1,
        snapshots: [
          {
            uuid,
            generation: 1,
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
      return { actor: structuredClone(actor) };
    }
    if (method === "DeleteActor") {
      deletes++;
      throw new Error("must not delete product Source");
    }
    throw new Error(`Unexpected ${method}`);
  });
  try {
    await c.start(f.projectID, f.userID);
    await c.status(f.attemptID, "failed", "owned parent preparation failure");
    expect((await c.get(f.attemptID))?.state).toBe("failed");
    await expect(c.stop(f.attemptID)).rejects.toThrow("confirmed Source owner");
    expect(deletes).toBe(0);
    const [saved] = await f.database
      .client`SELECT deleted_at,checkpoint FROM factory.runtime_attempt WHERE id=${f.attemptID}`;
    expect(saved?.["deleted_at"]).toBeNull();
    expect(saved?.["checkpoint"]).toBeNull();
    await expect(c.start(f.projectID, f.userID)).rejects.toThrow("retired");
    expect(deletes).toBe(0);
  } finally {
    await f.dispose();
  }
}, 60_000);
