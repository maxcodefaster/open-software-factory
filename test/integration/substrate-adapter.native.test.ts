import { expect, test } from "bun:test";
import { chmod, writeFile } from "node:fs/promises";
import { z } from "zod";
import { RuntimeHub, type RuntimeSocketData } from "../../apps/factory/src/runtime/hub";
import {
  substrateActorSelector,
  substrateTemplateSHA256,
} from "../../apps/factory/src/runtime/substrate";
import {
  hashConnectorToken,
  runtimeConnectorTokens,
} from "../../packages/runtime-domain/src/identity";
import {
  createSubstrateControl,
  nativeRuntime,
  SubstrateRPCError,
} from "../../packages/runtime-kubernetes/src/substrate-control";
import { substrateFixture } from "../fixtures/substrate";
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
  workloadImage: z.string().includes("@sha256:"),
  sourceRevision: z.string().regex(/^[a-f0-9]{40}$/),
  relaySocket: z.string(),
  factoryHostname: z.string(),
  factoryPort: z.number(),
  factoryListenPort: z.number().optional(),
  certFile: z.string(),
  keyFile: z.string(),
  runtime: nativeRuntime,
});

test("owned native Substrate gRPC through Factory Start/Connector registration/Suspend/Resume/Delete", async () => {
  const file = process.env["FACTORY_SUBSTRATE_NATIVE_FIXTURE"];
  if (!file)
    throw new Error("FACTORY_SUBSTRATE_NATIVE_FIXTURE must name a prepared, owned native fixture");
  const live = liveSchema.parse(await Bun.file(file).json());
  if (live.context !== `kind-${live.owner}`)
    throw new Error("Native fixture context ownership mismatch");
  const f = await substrateFixture(live.sourceRevision);
  if (live.relaySocket !== `${live.directory}/relay/connection.sock`)
    throw new Error("Owned relay socket path differs");
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
  const tokens = runtimeConnectorTokens("owned-native-secret", f.attemptID, 1);
  const assignment = {
    version: 1,
    runtimeAttemptId: f.attemptID,
    generation: 1,
    workspaceFolder: "/home/rootless/persist/project",
    remoteWorkspaceFolder: "/workspace",
    repositoryUrl: "file:///opt/native-repo",
    repositoryIdentity: f.projectID,
    preserveWorkspace: false,
    revision: live.sourceRevision,
    devcontainerPath: ".devcontainer/devcontainer.json",
    composeProjectName: `native-${f.attemptID}`,
    controlUrl: `wss://${live.factoryHostname}:${live.factoryPort}/internal/runtime-connect`,
    channels: [{ name: "ide", kind: "ide", target: "", healthPath: "" }],
    processes: [],
  };
  let c: ReturnType<typeof f.controller> | undefined;
  const roles = new Set<string>();
  const connections: Array<{ role: string; id: string }> = [];
  const phases: unknown[] = [];
  const server = Bun.serve<RuntimeSocketData>({
    hostname: "0.0.0.0",
    port: live.factoryListenPort ?? live.factoryPort,
    tls: { cert: Bun.file(live.certFile), key: Bun.file(live.keyFile) },
    async fetch(request, server) {
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
  const closeRelay = await substrateTestTransport(
    live.relaySocket,
    live.factoryListenPort ?? live.factoryPort,
  );
  let originalUID: string | undefined,
    spaceCreated = false;
  try {
    const labels = substrateActorSelector("owned-native-secret", f.attemptID);
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
    const space = JSON.parse(await run([...cli, "create", "atespace", f.atespace]));
    spaceCreated = true;
    const template = await Bun.file(`${live.directory}/rendered/actorTemplate.json`).json();
    template.metadata = { atespace: f.atespace, name: "runtime" };
    template.containers[0].image = live.workloadImage;
    template.containers[0].command = [
      "/opt/factory-rootless/start.sh",
      "/opt/factory-rootless/connector.sh",
      "/opt/native/run.sh",
    ];
    template.containers[0].env = [
      { name: "FACTORY_NATIVE_ASSIGNMENT", value: JSON.stringify(assignment) },
      { name: "FACTORY_NATIVE_PARENT", value: tokens.parent },
      { name: "FACTORY_NATIVE_CHILD", value: tokens.child },
    ];
    template.volumes.push({
      name: "identity",
      systemInfo: {
        dataSources: [
          { actorMetadata: { items: [{ field: "ACTOR_METADATA_FIELD_UID", path: "uid" }] } },
        ],
      },
    });
    template.containers[0].volumeMounts.push({ name: "identity", mountPath: "/run/ate/identity" });
    const actualTemplate = JSON.parse(
      await run([...cli, "create", "actor-template", "-f", "-"], template),
    );
    await run([...cli, "create", "access-policy", "-a", f.atespace, "-f", "-"], {
      bindings: [
        {
          role: "editor",
          members: [`user:system:serviceaccount:${live.owner}:factory-substrate-control`],
        },
      ],
    });
    Object.assign(f.config, {
      connection: {
        bridge: live.bridge,
        endpoint: live.endpoint,
        serverName: "api.ate-system.svc",
        caFile: live.caFile,
        tokenFile: live.tokenFile,
      },
      connectorURL: assignment.controlUrl,
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
    c = f.controller();
    const started = await c.start(f.projectID, f.userID);
    originalUID = started?.native?.actorUID;
    expect(originalUID).toBeTruthy();
    if (!originalUID) throw new Error("Factory did not retain the native Actor UID");
    expect(started?.native?.state).toBe("ACTOR_STATE_RUNNING");
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
    if (roles.size < 2 && originalUID) {
      // Read-only owned-fixture diagnostics, never the product transport.
      const observed = z
        .object({
          status: z.object({
            workerAssignment: z.object({ workerPod: z.string(), workerPodUid: z.string() }),
          }),
        })
        .parse(
          await rpc("GetActor", {
            actor: { atespace: f.atespace, name: `runtime-${f.attemptID.replaceAll("-", "")}` },
          }),
        );
      const worker = observed.status.workerAssignment;
      const pod = JSON.parse(
        await run([...k, "get", "pod", worker.workerPod, "-n", live.owner, "-o", "json"]),
      );
      if (pod.metadata.uid !== worker.workerPodUid)
        throw new Error("Diagnostic worker identity changed");
      const exec = [
        ...k,
        "exec",
        "-n",
        live.owner,
        worker.workerPod,
        "--",
        `/var/lib/ate/actors/${originalUID}/sandbox-assets/gvisor/runsc`,
        "--root",
        `/var/lib/ate/actors/${originalUID}/runsc-state`,
        "exec",
        "--user",
        "1000:1000",
        "workload",
      ];
      const logs = await run([
        ...exec,
        "head",
        "-c",
        "8192",
        "/home/rootless/persist/parent.log",
        "/home/rootless/persist/child.log",
      ]);
      await writeFile(`${live.directory}/connector-diagnostics.log`, logs);
      const probe =
        "import urllib.request,ssl,sys; p=urllib.request.ProxyHandler({'https':'http://127.0.0.1:8888'}); o=urllib.request.build_opener(p,urllib.request.HTTPSHandler(context=ssl.create_default_context(cafile='/opt/native/factory-ca.pem')));\ntry: print(o.open(sys.argv[1],timeout=5).status)\nexcept Exception as e: print(repr(e))";
      await run([
        ...exec,
        "sh",
        "-c",
        'exec nsenter --target "$(cat /run/user/1000/docker-direct/child_pid)" --user --mount --net -- python3 -c "$1" "$2"',
        "sh",
        probe,
        `https://${live.factoryHostname}:${live.factoryPort}/internal/runtime-connect`,
      ]).then(
        (text) => writeFile(`${live.directory}/connector-network.log`, text),
        (error) => writeFile(`${live.directory}/connector-network.log`, String(error)),
      );
    }
    const paused = await c.pause(f.attemptID);
    expect(paused?.state).toBe("paused");
    expect(paused?.native?.portable).toBe(false);
    const [checkpoint] = await f.database
      .client`SELECT checkpoint FROM factory.substrate_binding WHERE runtime_attempt_id=${f.attemptID}`;
    expect(checkpoint?.["checkpoint"].actorUID).toBe(originalUID);
    await c.resumeForApp(f.attemptID, f.userID);
    expect((await c.get(f.attemptID))?.native?.actorUID).toBe(originalUID);
    const reconnected = () =>
      ["parent", "child"].every((role) => connections.filter((c) => c.role === role).length >= 2);
    const reconnectDeadline = Date.now() + 30_000;
    while (!reconnected() && Date.now() < reconnectDeadline) await Bun.sleep(200);
    expect(reconnected()).toBe(true);
    expect((await c.stop(f.attemptID))?.state).toBe("stopped");
    await writeFile(
      `${live.directory}/native-result.json`,
      JSON.stringify(
        {
          passed: roles.size === 2,
          grpcLifecyclePassed: true,
          nativeDeletePreconditionsPassed: true,
          coldReconnectPassed: reconnected(),
          connections,
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
    if (c && originalUID) await c.stop(f.attemptID).catch(() => undefined);
    server.stop(true);
    await closeRelay();
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
    await f.dispose();
  }
}, 300_000);
