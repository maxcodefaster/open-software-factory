import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmod, readFile, writeFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { hashConnectorToken } from "#runtime-domain/identity";
import {
  createSubstrateControl,
  nativeRuntime,
  nativeSnapshot,
  SubstrateRPCError,
} from "#runtime-kubernetes/substrate-control";
import { createRuntimeEnvironmentEndpoint } from "../../apps/factory/src/environments/runtime";
import {
  prepareRuntimeRepository,
  readRepositoryFileAtRevision,
  removeRuntimeRepository,
  resolveRepositoryRevision,
  runtimeSourceCapability,
} from "../../apps/factory/src/runtime/git-http";
import { RuntimeHub, type RuntimeSocketData } from "../../apps/factory/src/runtime/hub";
import {
  substrateActorSelector,
  substrateTemplateSHA256,
} from "../../apps/factory/src/runtime/substrate";
import { createInternalProtocol } from "../../apps/factory/src/server/protocols/internal";
import { substrateFixture } from "../fixtures/substrate";
import { nativeAdapterTemplate } from "../fixtures/substrate-adapter-native";
import { substrateTestTransport } from "../fixtures/substrate-transport";

// Required, explicit owned resources. Missing prerequisites are an error, never
// a skipped native proof. The operator owns setup/teardown of this exact cluster.
const liveSchema = z.object({
  owner: z.string().regex(/^subadapter-[a-f0-9]+$/),
  kubeconfig: z.string(),
  context: z.string(),
  directory: z.string(),
  cli: z.string(),
  bridge: z.string(),
  endpoint: z.string(),
  caFile: z.string(),
  tokenFile: z.string(),
  wrongAudienceFile: z.string(),
  workloadImage: z.string().regex(/^[^\s@]+@sha256:[a-f0-9]{64}$/),
  repositoryDirectory: z.string().refine(isAbsolute, "Owned repository must be an absolute path"),
  sourceRevision: z.string().regex(/^[a-f0-9]{40}$/),
  relaySocket: z.string(),
  factoryHostname: z.string(),
  factoryPort: z.number(),
  factoryListenPort: z.number().optional(),
  certFile: z.string(),
  keyFile: z.string(),
  runtime: nativeRuntime,
});

test("owned native Substrate adapter gRPC/Connector registration/Suspend/Resume/Delete", async () => {
  const file = process.env["FACTORY_SUBSTRATE_NATIVE_FIXTURE"];
  if (!file)
    throw new Error("FACTORY_SUBSTRATE_NATIVE_FIXTURE must name a prepared, owned native fixture");
  const live = liveSchema.parse(await Bun.file(file).json());
  if (live.context !== `kind-${live.owner}`)
    throw new Error("Native fixture context ownership mismatch");
  if (live.relaySocket !== `${live.directory}/relay/connection.sock`)
    throw new Error("Owned relay socket path differs");
  const repository = pathToFileURL(resolve(live.repositoryDirectory)).href;
  expect(await resolveRepositoryRevision(repository, "main")).toBe(live.sourceRevision);
  const projectTemplateContent = await readRepositoryFileAtRevision(
    repository,
    live.sourceRevision,
    ".factory/actor-template.json",
  );
  const f = await substrateFixture(live.sourceRevision);
  const k = ["kubectl", "--kubeconfig", live.kubeconfig, "--context", live.context];
  const cli = [live.cli, "--kubeconfig", live.kubeconfig, "--context", live.context, "-o", "json"];
  async function run(argv: string[], input?: unknown) {
    const p = Bun.spawn(argv, {
      stdin: input ? new Blob([JSON.stringify(input)]) : "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, code] = await Promise.all([
      new Response(p.stdout).text(),
      new Response(p.stderr).text(),
      p.exited,
    ]);
    if (code) throw new Error(`${argv[0]} ${argv.at(-1)} failed: ${stderr.slice(-2000)}`);
    return stdout;
  }
  const secret = "owned-native-secret";
  const previousSecret = process.env["FACTORY_AUTH_SECRET"];
  const factoryOrigin = `https://${live.factoryHostname}:${live.factoryPort}`;
  const connectorURL = `${factoryOrigin.replace("https:", "wss:")}/internal/runtime-connect`;
  let c: ReturnType<typeof f.execution> | undefined;
  let server: ReturnType<typeof Bun.serve<RuntimeSocketData>> | undefined;
  let closeRelay: (() => Promise<void>) | undefined;
  let originalUID: string | undefined,
    spaceCreated = false;
  const roles = new Set<string>();
  const connections: Array<{ role: string; id: string }> = [];
  const phases: unknown[] = [];
  try {
    process.env["FACTORY_AUTH_SECRET"] =
      "owned-native-adapter-source-signing-secret-not-production";
    await f.database
      .client`UPDATE factory.project SET repository_url=${repository} WHERE id=${f.projectID}`;
    await prepareRuntimeRepository(f.attemptID, repository, live.sourceRevision);
    const labels = substrateActorSelector(secret, f.attemptID);
    const { template, projectTemplate } = nativeAdapterTemplate({
      secret,
      atespace: f.atespace,
      attemptID: f.attemptID,
      workspaceID: f.workspaceID,
      projectID: f.projectID,
      revision: live.sourceRevision,
      branch: f.branch,
      connectorURL,
      repositoryURL: `${factoryOrigin}/internal/runtime-source/${f.attemptID}/${runtimeSourceCapability(f.attemptID)}`,
      factoryCA: await readFile(live.certFile, "utf8"),
      workloadImage: live.workloadImage,
      workerSelector: labels,
      projectTemplateContent,
    });
    const templateSHA256 = substrateTemplateSHA256(template);
    // Frozen native intent precedes external creates. No credential-bearing
    // control/bootstrap body is copied into Factory's provisioning metadata.
    await f.database.client`INSERT INTO factory.substrate_provision(owner_id,kind,intent)
      VALUES(${f.workspaceID},'workspace',${JSON.stringify({
        revision: live.sourceRevision,
        repositoryURL: repository,
        branch: f.branch,
        actorTemplatePath: projectTemplate.path,
        projectTemplate,
        templateSHA256,
      })}::jsonb)`;
    const runtimeEnvironmentEndpoint = createRuntimeEnvironmentEndpoint(
      f.database,
      {
        configured: false,
        read: async () => undefined,
        create: async () => {
          throw Error("Native adapter fixture has no Project credentials");
        },
      },
      secret,
      {
        sourceConnected: (attemptID) => f.hub.sourceConnected(attemptID),
        sourceEpoch: (attemptID) => f.hub.sourceEpoch(attemptID),
      },
    );
    // Only the real internal Source and environment routes are exposed. Other
    // Factory services are neither replaced nor exercised by this adapter proof.
    const internal = createInternalProtocol({
      database: f.database,
      factoryOrigin,
      runtimeEnvironmentEndpoint,
    } as Parameters<typeof createInternalProtocol>[0]);
    server = Bun.serve<RuntimeSocketData>({
      hostname: "0.0.0.0",
      port: live.factoryListenPort ?? live.factoryPort,
      tls: { cert: Bun.file(live.certFile), key: Bun.file(live.keyFile) },
      async fetch(request, server) {
        const path = new URL(request.url).pathname;
        if (
          path.startsWith("/internal/runtime-source/") ||
          path.startsWith("/internal/runtime-environment/")
        )
          return internal(request);
        if (path !== "/internal/runtime-connect") return new Response(null, { status: 404 });
        const data = f.hub.authorize(request, hashConnectorToken);
        if (!data || !c || !(await c.authorizeConnector(request))) {
          phases.push({
            rejected: data ? "current-binding/grant" : "capability/UID/generation",
            role: request.headers.get("x-factory-connector-role"),
            actorUID: request.headers.get("x-factory-runtime-actor-uid"),
          });
          return new Response("Unauthorized", { status: 401 });
        }
        if (
          server.upgrade(request, {
            data,
            headers: { "sec-websocket-protocol": RuntimeHub.protocol() },
          })
        )
          return;
        return new Response("Upgrade failed", { status: 500 });
      },
      websocket: {
        open(socket) {
          if (socket.data.kind === "connector") {
            roles.add(socket.data.role);
            connections.push({ role: socket.data.role, id: crypto.randomUUID() });
          }
          f.hub.open(socket);
        },
        message(socket, message) {
          phases.push(JSON.parse(String(message)));
          f.hub.message(socket, message);
        },
        close(socket) {
          f.hub.close(socket);
        },
      },
    });
    closeRelay = await substrateTestTransport(
      live.relaySocket,
      live.factoryListenPort ?? live.factoryPort,
    );
    const actors = z
      .object({ actors: z.array(z.unknown()).optional() })
      .parse(JSON.parse(await run([...cli, "get", "actors", "--all-atespaces"])));
    if (actors.actors?.length)
      throw new Error("Owned proof pool must have no retained Actors before relabeling");
    const pool = JSON.parse(
      await run([...k, "get", "workerpool", "adapter-worker", "-n", live.owner, "-o", "json"]),
    );
    await run([
      ...k,
      "label",
      "workerpool",
      "adapter-worker",
      "-n",
      live.owner,
      "--overwrite",
      `--resource-version=${pool.metadata.resourceVersion}`,
      ...Object.entries(labels).map(([k, v]) => `${k}=${v}`),
    ]);
    await f.database.client`UPDATE factory.substrate_provision
      SET resources=jsonb_set(resources, ARRAY['atespace'], COALESCE(resources->'atespace','{}'::jsonb) || jsonb_build_object('attemptedAt', to_jsonb(now())), true)
      WHERE owner_id=${f.workspaceID} AND kind='workspace'`;
    const space = JSON.parse(await run([...cli, "create", "atespace", f.atespace]));
    spaceCreated = true;
    await f.database.client`UPDATE factory.substrate_provision
      SET resources=jsonb_set(
        jsonb_set(resources, ARRAY['atespace'], COALESCE(resources->'atespace','{}'::jsonb) || jsonb_build_object('value', ${JSON.stringify(space)}::text::jsonb), true),
        ARRAY['template'], COALESCE(resources->'template','{}'::jsonb) || jsonb_build_object('attemptedAt', to_jsonb(now())), true)
      WHERE owner_id=${f.workspaceID} AND kind='workspace'`;
    const actualTemplate = JSON.parse(
      await run([...cli, "create", "actor-template", "-f", "-"], template),
    );
    expect(substrateTemplateSHA256(actualTemplate)).toBe(templateSHA256);
    await f.database.client`UPDATE factory.substrate_provision
      SET resources=jsonb_set(
        jsonb_set(resources, ARRAY['template'], COALESCE(resources->'template','{}'::jsonb) || jsonb_build_object('value', ${JSON.stringify({ metadata: actualTemplate.metadata })}::text::jsonb), true),
        ARRAY['policy'], COALESCE(resources->'policy','{}'::jsonb) || jsonb_build_object('attemptedAt', to_jsonb(now())), true)
      WHERE owner_id=${f.workspaceID} AND kind='workspace'`;
    const policy = JSON.parse(
      await run([...cli, "create", "access-policy", "-a", f.atespace, "-f", "-"], {
        bindings: [
          {
            role: "editor",
            members: [`user:system:serviceaccount:${live.owner}:factory-substrate-control`],
          },
        ],
      }),
    );
    await f.database.client`UPDATE factory.substrate_provision
      SET resources=jsonb_set(resources, ARRAY['policy'], COALESCE(resources->'policy','{}'::jsonb) || jsonb_build_object('value', ${JSON.stringify(policy)}::text::jsonb), true)
      WHERE owner_id=${f.workspaceID} AND kind='workspace'`;
    Object.assign(f.config, {
      connection: {
        bridge: live.bridge,
        endpoint: live.endpoint,
        serverName: "api.ate-system.svc",
        caFile: live.caFile,
        tokenFile: live.tokenFile,
      },
      connectorURL,
      environment: { version: 0, secretKey: null },
      workerSelector: labels,
      atespaceUID: space.metadata.uid,
      templateUID: actualTemplate.metadata.uid,
      templateVersion: actualTemplate.metadata.version,
      templateSHA256: substrateTemplateSHA256(actualTemplate),
      runtime: live.runtime,
    });
    const rpc = createSubstrateControl(f.config.connection);
    const wrongAudience = createSubstrateControl({
      ...f.config.connection,
      tokenFile: live.wrongAudienceFile,
    });
    await expect(
      wrongAudience("GetActorTemplate", {
        actorTemplate: { atespace: f.atespace, name: "runtime" },
      }),
    ).rejects.toBeInstanceOf(SubstrateRPCError);
    c = f.execution();
    expect(await c.start(f.userID)).toBe(f.attemptID);
    const started = await c.get();
    originalUID = started.actorUID;
    expect(originalUID).toBeTruthy();
    if (!originalUID) throw new Error("Factory did not retain the native Actor UID");
    // Controlled already-granted Source ownership for this adapter-only proof;
    // the actual Parent still initializes Source and must announce its real epoch
    // before the production endpoint will admit Work or service entry.
    await f.admitActorSource(originalUID);
    const runningDeadline = Date.now() + 60_000;
    while ((await c.get()).state !== "ACTOR_STATE_RUNNING" && Date.now() < runningDeadline)
      await Bun.sleep(200);
    expect((await c.get()).state).toBe("ACTOR_STATE_RUNNING");
    const actorRef = { atespace: f.atespace, name: `runtime-${f.attemptID.replaceAll("-", "")}` };
    const metadata = z
      .object({ metadata: z.object({ uid: z.uuid(), version: z.string() }) })
      .parse(await rpc("GetActor", { actor: actorRef })).metadata;
    await expect(
      rpc("DeleteActor", {
        actor: actorRef,
        options: { uid: crypto.randomUUID(), version: metadata.version },
      }),
    ).rejects.toBeInstanceOf(SubstrateRPCError);
    await expect(
      rpc("DeleteActor", {
        actor: actorRef,
        options: { uid: metadata.uid, version: String(BigInt(metadata.version) + 100n) },
      }),
    ).rejects.toBeInstanceOf(SubstrateRPCError);
    expect(
      z
        .object({ metadata: z.object({ uid: z.uuid() }) })
        .parse(await rpc("GetActor", { actor: actorRef })).metadata.uid,
    ).toBe(originalUID);
    const deadline = Date.now() + 60_000;
    while (roles.size < 2 && Date.now() < deadline) await Bun.sleep(200);
    await writeFile(
      `${live.directory}/connector-observation.json`,
      JSON.stringify({ roles: [...roles], phases, attemptID: f.attemptID, originalUID }, null, 2),
    );
    expect([...roles].sort()).toEqual(["child", "parent"]);
    expect(f.hub.sourceConnected(f.attemptID)).toBe(true);
    async function workCommand(command: string) {
      const id = crypto.randomUUID();
      const digest = createHash("sha256").update(command).digest("hex");
      const request = async (action: string, data: unknown) => {
        const reply = await f.hub.childRequest(f.attemptID, {
          operationId: crypto.randomUUID(),
          action,
          data: JSON.stringify(data),
        });
        if (!reply) throw Error("Native ROOTFS probe command outcome is unconfirmed");
        return z
          .object({
            id: z.uuid(),
            digest: z.string(),
            state: z.string(),
            exitCode: z.number().optional(),
            stdout: z.string().optional(),
            stderr: z.string().optional(),
            outputLost: z.boolean(),
          })
          .parse(JSON.parse(reply));
      };
      let result = await request("command-start", { id, digest, command, env: {} });
      const deadline = Date.now() + 30_000;
      while (["starting", "running"].includes(result.state) && Date.now() < deadline) {
        await Bun.sleep(100);
        result = await request("command-read", { id });
      }
      result = await request("command-read", { id });
      expect(result.id).toBe(id);
      expect(result.digest).toBe(digest);
      expect(result.state).toBe("exited");
      expect(result.outputLost).toBe(false);
      expect(result.exitCode, Buffer.from(result.stderr ?? "", "base64").toString()).toBe(0);
      return JSON.parse(Buffer.from(result.stdout ?? "", "base64").toString());
    }
    const markerName = `factory-rootfs-${f.attemptID}.json`;
    const quote = (value: string) => `'${value.replace(/'/g, "'\"'\"'")}'`;
    const beforeRootFS = await workCommand(
      `node -e ${quote(
        `const fs=require("node:fs"),crypto=require("node:crypto");` +
          `const home=require("node:os").userInfo().homedir;` +
          `const path=require("node:path").join(home,${JSON.stringify(markerName)});` +
          `if(home==="/tmp"||home.startsWith("/workspace"))throw Error("ROOTFS probe requires an image-backed home outside Source and tmpfs");` +
          `if(fs.existsSync(path))throw Error("Observe original owned ROOTFS probe");` +
          `const value=crypto.randomUUID();fs.writeFileSync(path,value,{flag:"wx",mode:384});` +
          `console.log(JSON.stringify({path,value,user:process.getuid(),mtime:fs.statSync(path,{bigint:true}).mtimeNs.toString(),boot:fs.readFileSync("/proc/sys/kernel/random/boot_id","utf8").trim(),tmpMount:fs.readFileSync("/proc/self/mountinfo","utf8").split("\\n").filter(line=>line.split(" ")[4]==="/tmp")}));`,
      )}`,
    );
    expect(beforeRootFS.user).toBe(1000);
    await writeFile(
      `${live.directory}/rootfs-probe-before.json`,
      JSON.stringify(beforeRootFS, null, 2),
      { mode: 0o600 },
    );
    await c.suspend();
    const paused = await c.get();
    expect(paused.state).toBe("ACTOR_STATE_SUSPENDED");
    expect(paused.portable).toBe(false);
    const [checkpoint] = await f.database
      .client`SELECT checkpoint FROM factory.runtime_attempt WHERE id=${f.attemptID}`;
    const snapshot = nativeSnapshot
      .extend({ actorUID: z.uuid(), templateUID: z.uuid() })
      .parse(checkpoint?.["checkpoint"]);
    expect(snapshot.actorUID).toBe(originalUID);
    expect(snapshot.templateUID).toBe(actualTemplate.metadata.uid);
    expect(snapshot.fidelity).toBe("SNAPSHOT_FIDELITY_ROOTFS");
    expect(snapshot.durableSnapshot.state).toBe("SNAPSHOT_STORAGE_STATE_COMPLETED");
    await writeFile(
      `${live.directory}/rootfs-durable-snapshot.json`,
      JSON.stringify(snapshot, null, 2),
      { mode: 0o600 },
    );
    // A resumed in-place sandbox can retain memory at any snapshot preference.
    // Wait for upstream atelet's ordinary detach report before calling this a
    // cold ROOTFS restore. A timeout is a failed proof, not another Suspend.
    const detachDeadline = Date.now() + 180_000;
    let detached = false;
    while (Date.now() < detachDeadline) {
      const observed = z
        .object({
          metadata: z.object({ uid: z.uuid() }),
          status: z.object({
            state: z.string(),
            assignedNode: z.string().optional(),
            snapshots: z.array(nativeSnapshot.extend({ locality: z.string().optional() })),
          }),
        })
        .parse(await rpc("GetActor", { actor: actorRef }));
      expect(observed.metadata.uid).toBe(originalUID);
      expect(observed.status.state).toBe("ACTOR_STATE_SUSPENDED");
      const current = observed.status.snapshots.find((item) => item.uuid === snapshot.uuid);
      expect(current).toBeDefined();
      if (!observed.status.assignedNode && current && !current.locality) {
        detached = true;
        break;
      }
      await Bun.sleep(1000);
    }
    expect(detached).toBe(true);
    await c.resume(f.userID);
    expect((await c.get()).actorUID).toBe(originalUID);
    const reconnected = () =>
      ["parent", "child"].every((role) => connections.filter((c) => c.role === role).length >= 2);
    const reconnectDeadline = Date.now() + 30_000;
    while (!reconnected() && Date.now() < reconnectDeadline) await Bun.sleep(200);
    expect(reconnected()).toBe(true);
    const afterRootFS = await workCommand(
      `node -e ${quote(
        `const fs=require("node:fs"),path=${JSON.stringify(beforeRootFS.path)};` +
          `console.log(JSON.stringify({value:fs.readFileSync(path,"utf8"),mtime:fs.statSync(path,{bigint:true}).mtimeNs.toString(),boot:fs.readFileSync("/proc/sys/kernel/random/boot_id","utf8").trim()}));`,
      )}`,
    );
    expect(afterRootFS.value).toBe(beforeRootFS.value);
    expect(afterRootFS.mtime).toBe(beforeRootFS.mtime);
    expect(afterRootFS.boot).not.toBe(beforeRootFS.boot);
    await c.stop();
    expect((await c.get()).state).toBe("deleted");
    await writeFile(
      `${live.directory}/native-result.json`,
      JSON.stringify(
        {
          passed: roles.size === 2,
          grpcLifecyclePassed: true,
          nativeDeletePreconditionsPassed: true,
          coldReconnectPassed: reconnected(),
          upstreamDetachConfirmed: detached,
          rootFSFileAndNanosecondMtimePreserved: true,
          coldBootIdentityChanged: true,
          rootFSProbe: { before: beforeRootFS, after: afterRootFS },
          connections,
          templateSHA256,
          workloadImage: live.workloadImage,
          projectTemplateSHA256: projectTemplate.sha256,
          nativeDirectContainers: true,
          parentWorkflowReady: false,
          attemptID: f.attemptID,
          originalUID,
          checkpoint: checkpoint?.["checkpoint"],
          roles: [...roles],
          fullFactoryE2E: false,
          toolchainQualified: false,
          sourceHandoff: "pending",
        },
        null,
        2,
      ),
    );
    await chmod(`${live.directory}/native-result.json`, 0o600);
    expect(await rpc("GetAtespace", { atespace: { name: f.atespace } })).toBeTruthy();
    expect([...roles].sort()).toEqual(["child", "parent"]);
  } finally {
    // Stop only this Factory-bound original. Operator metadata below is not
    // passed to Actors or to the normal editor-scoped gRPC bridge.
    if (c && originalUID) await c.stop().catch(() => undefined);
    await server?.stop(true);
    await closeRelay?.();
    if (spaceCreated)
      await writeFile(
        `${live.directory}/native-owned-space.json`,
        JSON.stringify({
          atespace: f.atespace,
          template: "runtime",
          attemptID: f.attemptID,
          actorUID: originalUID,
        }),
      );
    await removeRuntimeRepository(f.attemptID);
    await f.dispose();
    if (previousSecret === undefined) delete process.env["FACTORY_AUTH_SECRET"];
    else process.env["FACTORY_AUTH_SECRET"] = previousSecret;
  }
}, 300_000);
