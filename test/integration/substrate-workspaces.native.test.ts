import { expect, test } from "bun:test";
import { readFile, rm, writeFile } from "node:fs/promises";
import { createConnection } from "node:net";
import { createServer } from "node:tls";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { z } from "zod";
import { createDatabase } from "#db/client";
import { runtimeConnectorTokens, runtimeIdentity } from "#runtime-domain/identity";
import {
  createSubstrateControl,
  nativeActor,
  nativeRuntime,
  nativeSnapshot,
  SubstrateRPCError,
} from "#runtime-kubernetes/substrate-control";
import { parseSubstrateProjectTemplate } from "#runtime-kubernetes/substrate-project-template";
import { personalWorkspaceIdentity } from "#workspace-domain/workspace";
import { removeRuntimeRepository } from "../../apps/factory/src/runtime/git-http";
import type { SubstrateInstallationConfiguration } from "../../apps/factory/src/runtime/substrate-workspaces";
import { createFactoryApplication } from "../../apps/factory/src/server/application";
import { startFactoryLifecycle } from "../../apps/factory/src/server/lifecycle";
import { startFactoryTransport } from "../../apps/factory/src/server/transport";
import { serverCall } from "../../apps/factory/src/server-functions/result";
import { ownedAttachmentS3 } from "../fixtures/attachment-s3";
import { eventually } from "../fixtures/factory-process";
import { ownedMCPAuthorization, ownedMCPAuthProvider } from "../fixtures/mcp-authorization";
import { nativeGitHTTP } from "../fixtures/native-git-http";
import { ownedPostgresServer, ownedTestDatabase } from "../fixtures/postgres-server";
import { ownedRuntimeTerminal, runtimeAccessCookie } from "../fixtures/runtime-access";
import { ownedRuntimeConfiguration } from "../fixtures/runtime-configuration";
import { configuredRuntimeProjectFiles } from "../fixtures/runtime-project";
import { callFactoryFunction } from "../fixtures/server-functions";
import {
  starterActiveObservationSchema,
  starterNativeLifecycle,
} from "../fixtures/starter-native-lifecycle";
import { starterProbeCommand } from "../fixtures/starter-runtime-journey";
import { substrateTestTransport } from "../fixtures/substrate-transport";

const liveSchema = z.object({
  owner: z.string().regex(/^subadapter-[a-f0-9]+$/),
  kubeconfig: z.string(),
  context: z.string(),
  cli: z.string(),
  directory: z.string(),
  bridge: z.string(),
  endpoint: z.string(),
  caFile: z.string(),
  tokenFile: z.string(),
  provisionerTokenFile: z.string(),
  wrongAudienceFile: z.string(),
  workloadImage: z.string().includes("@sha256:"),
  factoryHostname: z.string(),
  factoryPort: z.literal(443),
  certFile: z.string(),
  keyFile: z.string(),
  directIngress: z.boolean().default(false),
  ingressListenPort: z.number().int().min(1).max(65535).default(443),
  qualification: z.enum(["lifecycle", "lifecycle-and-git"]).default("lifecycle-and-git"),
  runtime: nativeRuntime,
});

test("fresh Workspace through authenticated FactoryApplication command: native provisioning, real checkout, parent/child readiness and cold lifecycle", async () => {
  const file = process.env["FACTORY_SUBSTRATE_WORKSPACES_NATIVE_FIXTURE"];
  if (!file) throw new Error("Explicit owned FACTORY_SUBSTRATE_WORKSPACES_NATIVE_FIXTURE required");
  const live = liveSchema.parse(await Bun.file(file).json());
  if (live.tokenFile === live.provisionerTokenFile)
    throw new Error("Native Workspace proof requires separate Owner and Editor credentials");
  if (process.platform !== "linux" || process.getuid?.() !== 1000 || process.getgid?.() !== 1000)
    throw new Error("Native Workspace qualification requires Linux UID/GID 1000");
  if (live.context !== `kind-${live.owner}`)
    throw new Error("Native Workspace fixture context ownership mismatch");
  const owner = await ownedPostgresServer();
  const target = await ownedTestDatabase(owner.identity, crypto.randomUUID());
  const previous = { ...process.env };
  const objectStore = await ownedAttachmentS3();
  const projectID = crypto.randomUUID();
  const rpcLog = `${live.directory}/native-rpcs-${projectID}.jsonl`;
  const recordedBridge = `${live.directory}/recorded-bridge-${projectID}`;
  const pauseHeldFile = `${live.directory}/pause-held-${projectID}`;
  const pauseReleaseFile = `${live.directory}/pause-release-${projectID}`;
  const pauseFaultFile = `${live.directory}/pause-fault-${projectID}.json`;
  await writeFile(
    recordedBridge,
    `#!${process.execPath}
import { appendFileSync } from "node:fs";
const input = await Bun.stdin.text();
const request = JSON.parse(input);
const name = request.request?.actor?.name ?? request.request?.actor?.metadata?.name
  ?? request.request?.atespace?.metadata?.name;
appendFileSync(${JSON.stringify(rpcLog)}, JSON.stringify({ at: Date.now(), method: request.method, name, uid: request.request?.options?.uid, version: request.request?.options?.version, phase: "dispatch" }) + "\\n", { mode: 0o600 });
const child = Bun.spawn([${JSON.stringify(live.bridge)}], {
  stdin: new Blob([input]), stdout: "pipe", stderr: "pipe", env: { PATH: process.env.PATH },
});
const [out, err, exit] = await Promise.all([
  new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
]);
let result;
try { result = JSON.parse(out); } catch {}
const actor = result?.actor ?? result;
appendFileSync(${JSON.stringify(rpcLog)}, JSON.stringify({
  at: Date.now(), method: request.method,
  name: request.request?.actor?.name ?? request.request?.actor?.metadata?.name,
  uid: actor?.metadata?.uid, state: actor?.status?.state,
  error: result?.error?.code, exit, phase: "complete",
}) + "\\n", { mode: 0o600 });
const fault = Bun.file(${JSON.stringify(pauseFaultFile)});
if (request.method === "SuspendActor" && exit === 0 && !result?.error && await fault.exists()) {
  const expected = await fault.json();
  if (name === expected.name) {
    await Bun.write(${JSON.stringify(pauseHeldFile)}, name);
    while (!(await Bun.file(${JSON.stringify(pauseReleaseFile)}).exists())) await Bun.sleep(20);
    appendFileSync(${JSON.stringify(rpcLog)}, JSON.stringify({ at: Date.now(), method: request.method, name, phase: "released-reply" }) + "\\n", { mode: 0o600 });
  }
}
if (err) process.stderr.write(err);
process.stdout.write(out);
process.exit(exit);
`,
    { mode: 0o700 },
  );
  const rpcCalls = async () =>
    (await readFile(rpcLog, "utf8"))
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { method: string; phase: string; name?: string });
  const suspendCount = async () =>
    (await rpcCalls()).filter((call) => call.method === "SuspendActor" && call.phase === "dispatch")
      .length;
  const reserve = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
  const port = reserve.port;
  if (!port) throw new Error("Owned Factory listener address missing");
  await reserve.stop(true);
  const base = `http://127.0.0.1:${port}`;
  const configuration: SubstrateInstallationConfiguration = {
    deployment: "fresh-workspaces",
    database: new URL(target.url).pathname.slice(1),
    connection: {
      bridge: recordedBridge,
      endpoint: live.endpoint,
      serverName: "api.ate-system.svc",
      caFile: live.caFile,
      tokenFile: live.tokenFile,
    },
    provisioner: {
      bridge: recordedBridge,
      endpoint: live.endpoint,
      serverName: "api.ate-system.svc",
      caFile: live.caFile,
      tokenFile: live.provisionerTokenFile,
    },
    editorPrincipal: `user:system:serviceaccount:${live.owner}:factory-substrate-control`,
    connectorURL: `wss://${live.factoryHostname}/internal/runtime-connect`,
    factoryCAFile: live.certFile,
    workloadImage: live.workloadImage,
    resources: { cpuMilli: 2000, memoryMiB: 2048 },
    profile: "nightly-20261109-975fb172241c",
    runtime: live.runtime,
    workerSelector: {
      "factory.runtime/profile": "nightly-20261109-975fb172241c",
      "factory.dev/deployment": live.owner.slice("subadapter-".length),
    },
    egressHosts: [
      "auth.docker.io",
      "registry-1.docker.io",
      "production.cloudflare.docker.com",
      "production.cloudfront.docker.com",
    ],
  };
  const configFile = `${live.directory}/workspace-configuration-${projectID}.json`;
  await writeFile(configFile, JSON.stringify(configuration), { mode: 0o600 });
  Object.assign(process.env, ownedRuntimeConfiguration, {
    DATABASE_URL: target.url,
    KUBECONFIG: live.kubeconfig,
    FACTORY_KUBERNETES_CONTEXT: live.context,
    FACTORY_HOST: "127.0.0.1",
    FACTORY_PORT: String(port),
    FACTORY_BASE_URL: base,
    FACTORY_STATE_DIRECTORY: `${live.directory}/factory-state-${projectID}`,
    FACTORY_AUTH_SECRET: "native-workspace-owned-auth-secret-not-production",
    FACTORY_ADMIN_EMAIL: "native-admin@factory.local",
    FACTORY_ADMIN_PASSWORD: "owned-native-admin-password-not-production",
    FACTORY_FORGEJO_API_URL: "http://127.0.0.1:9/api/v1",
    FACTORY_FORGEJO_OWNER: "owned-native",
    FACTORY_FORGEJO_TOKEN: "owned-unused-forge-token",
    FACTORY_ZERO_CACHE_URL: "",
    FACTORY_SUBSTRATE_WORKSPACES_CONFIGURATION: configFile,
    FACTORY_MODEL_BASE_URL: "http://127.0.0.1:9/v1",
    FACTORY_MODEL_API_KEY: "owned-unused-model-key",
  });
  delete process.env["FACTORY_SUBSTRATE_OWNED_CONFIGURATION"];
  delete process.env["FACTORY_FORGEJO_ADMIN_TOKEN"];
  const database = createDatabase();
  let application: Awaited<ReturnType<typeof createFactoryApplication>> | undefined;
  let closeBackground: (() => Promise<void>) | undefined;
  let allowBackground = true;
  let servers: ReturnType<typeof startFactoryTransport> = [];
  let closeRelay: (() => Promise<void>) | undefined;
  let attemptID: string | undefined;
  const extraAttemptIDs: string[] = [];
  const pending: Promise<unknown>[] = [];
  const clients: Client[] = [];
  const connections: Array<{ role: string; at: number }> = [];
  let unconfirmedPermissionProbe = false;
  let failure: unknown;
  // Owned ingress only: TLS is terminated exactly as a normal Ingress would do.
  // The Unix relay carries opaque TLS; no firewall, trust or egress bypass.
  const ingress = createServer(
    { cert: await readFile(live.certFile), key: await readFile(live.keyFile) },
    (socket) => {
      const backend = createConnection({ host: "127.0.0.1", port });
      socket.pipe(backend);
      backend.pipe(socket);
      socket.on("error", () => backend.destroy());
      backend.on("error", () => socket.destroy());
      socket.on("close", () => backend.destroy());
      backend.on("close", () => socket.destroy());
    },
  );
  try {
    await new Promise<void>((resolve, reject) => {
      ingress.once("error", reject);
      ingress.listen(
        live.directIngress ? live.ingressListenPort : 0,
        live.directIngress ? "0.0.0.0" : "127.0.0.1",
        resolve,
      );
    });
    const address = ingress.address();
    if (!address || typeof address === "string") throw new Error("Owned ingress address missing");
    const sourceBinary = `${live.directory}/source-service-${projectID}`;
    const sourceBuild = Bun.spawn(
      [
        "go",
        "build",
        "-mod=readonly",
        "-trimpath",
        "-o",
        sourceBinary,
        "./cmd/factory-runtime-connector",
      ],
      {
        cwd: `${import.meta.dir}/../../services/runtime-connector`,
        stdout: "ignore",
        stderr: "pipe",
        env: { ...process.env, CGO_ENABLED: "0" },
      },
    );
    if (await sourceBuild.exited) throw new Error("Actual Source service binary build failed");
    process.env["FACTORY_SOURCE_SERVICE_BINARY"] = sourceBinary;
    application = await createFactoryApplication();
    const app = application;
    const start = app.runtimeController.start;
    app.runtimeController.start = async function (
      this: typeof app.runtimeController,
      ...args: Parameters<typeof start>
    ) {
      try {
        return await start.apply(this, args);
      } catch (cause) {
        const detail =
          cause instanceof Error
            ? `${cause.stack ?? cause.message}\n${cause.cause instanceof Error ? cause.cause.stack : ""}`
            : String(cause);
        await writeFile(
          `${live.directory}/native-start-failure-${crypto.randomUUID()}.log`,
          detail
            .replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, "<REDACTED-JWT>")
            .replace(/Bearer\s+\S+/g, "Bearer <REDACTED>")
            .replace(/\b[a-f0-9]{64}\b/gi, "<REDACTED-HEX>"),
          { flag: "wx", mode: 0o600 },
        );
        throw cause;
      }
    };
    const open = app.runtimeHub.open.bind(app.runtimeHub);
    app.runtimeHub.open = (socket) => {
      if (socket.data.kind === "connector")
        connections.push({ role: socket.data.role, at: Date.now() });
      open(socket);
    };
    servers = startFactoryTransport(app);
    closeBackground = startFactoryLifecycle(app, async () => allowBackground);
    if (!live.directIngress)
      closeRelay = await substrateTestTransport(
        `${live.directory}/relay/connection.sock`,
        address.port,
      );
    const developer = await app.factoryAuth.createManagedUser({
      name: "Native Developer",
      email: "native-developer@factory.local",
      password: "owned-native-developer-password",
    });
    const userID = z.uuid().parse(developer?.id);
    const workspaceID = personalWorkspaceIdentity(projectID, userID).workspaceID;
    attemptID = runtimeIdentity(workspaceID, 1).attemptID;
    const ref = {
      atespace: `fa-${attemptID.replaceAll("-", "")}`,
      name: `runtime-${attemptID.replaceAll("-", "")}`,
    };
    const repository = `${live.directory}/project-${projectID}`;
    await Bun.$`mkdir -p ${repository}/.factory`.quiet();
    await writeFile(
      `${repository}/.factory/system.json`,
      JSON.stringify({
        version: 1,
        primaryApp: "web",
        apps: [
          {
            id: "web",
            label: "Owned native App",
            command: ["node", "server.mjs"],
            port: 4300,
            healthPath: "/",
          },
        ],
      }),
    );
    const projectFiles = await configuredRuntimeProjectFiles(configFile);
    const projectTemplate = projectFiles.find(
      (file) => file.path === ".factory/actor-template.json",
    );
    if (!projectTemplate) throw new Error("Configured native fixture ActorTemplate missing");
    const project = parseSubstrateProjectTemplate(projectTemplate.content);
    const work = project.containers.find((container) => container.name === "work");
    if (!work) throw new Error("Configured native fixture work container missing");
    // The prepared image supplies UID/GID 1000; native Source mounts at /workspace/project.
    work.volumeMounts = [
      ...(work.volumeMounts ?? []),
      { name: "owned-native-home", mountPath: "/home/node" },
    ];
    work.command = [
      "node",
      "-e",
      // Source must be usable before Work preparation. Only this fixture's
      // deliberate Source write releases the bounded preparation gate.
      "const fs=require('fs');const end=Date.now()+60000;const wait=()=>{if(fs.existsSync('owned-prepare-release')){const path='/home/node/owned-create-effects';if(!fs.existsSync(path))fs.writeFileSync(path,'once\\n');return;}if(Date.now()>end)process.exit(1);setTimeout(wait,50)};wait()",
    ];
    project.volumes.push({ name: "owned-native-home", durableDir: {} });
    // This fixture requests cold continuation, like the native adapter proof.
    project.snapshotConfig = { preferredFidelity: "SNAPSHOT_FIDELITY_ROOTFS" };
    await writeFile(`${repository}/.factory/actor-template.json`, JSON.stringify(project));
    await writeFile(
      `${repository}/server.mjs`,
      "import http from 'node:http';import fs from 'node:fs';http.createServer((q,s)=>s.end(q.url==='/editor' ? fs.readFileSync('owned-editor.txt','utf8') : 'owned-native-ready')).listen(4300,'127.0.0.1');\n",
    );
    await writeFile(`${repository}/.gitignore`, "owned-private.txt\nowned-prepare-release\n");
    await Bun.$`git -C ${repository} init -b main`.quiet();
    await Bun.$`git -C ${repository} add .`.quiet();
    await Bun.$`git -C ${repository} -c user.name=Owned -c user.email=owned@example.invalid commit -m initial`.quiet();
    const revision = (await Bun.$`git -C ${repository} rev-parse HEAD`.text()).trim();
    await database.client.begin(async (sql) => {
      await sql`INSERT INTO factory.project(id,slug,name,repository_url,default_branch,actor_template_path,created_by) VALUES(${projectID},${`native-${projectID}`},'Owned native Project',${`file://${repository}`},'main','.factory/actor-template.json',${userID})`;
      await sql`INSERT INTO factory.project_membership(project_id,user_id,role,updated_by) VALUES(${projectID},${userID},'developer',${userID})`;
    });
    expect(await database.client`SELECT id FROM factory.development_workspace`).toHaveLength(0);
    const login = await fetch(`${base}/api/auth/sign-in/email`, {
      method: "POST",
      headers: { origin: base, "content-type": "application/json" },
      body: JSON.stringify({
        email: "native-developer@factory.local",
        password: "owned-native-developer-password",
      }),
    });
    expect(login.ok).toBe(true);
    const cookie = login.headers
      .getSetCookie()
      .map((c) => c.split(";")[0])
      .join("; ");
    await expect(
      serverCall(callFactoryFunction(base, "startPersonalWorkspace", [projectID])),
    ).rejects.toThrow();
    const source = (operation: string, input: unknown, signal?: AbortSignal) =>
      fetch(`${base}/api/workspaces/${workspaceID}/source/${operation}`, {
        method: operation === "events" ? "GET" : "POST",
        headers: { cookie, origin: base, "content-type": "application/json" },
        ...(operation === "events" ? {} : { body: JSON.stringify(input) }),
        ...(signal ? { signal } : {}),
      });
    const initialSource = await serverCall(
      callFactoryFunction(base, "ensurePersonalSource", [projectID], { cookie }),
    );
    expect(initialSource).toMatchObject({ workspaceID, state: "ready" });
    expect(await database.client`SELECT id FROM factory.development_workspace`).toHaveLength(1);
    expect(await database.client`SELECT id FROM factory.runtime_attempt`).toHaveLength(0);
    expect(
      await database.client`SELECT owner_id FROM factory.substrate_provision WHERE kind='workspace'`,
    ).toHaveLength(0);
    expect(
      (
        await source("write", {
          path: "owned-before-compute.txt",
          content: Buffer.from("saved before native Project execution\n").toString("base64"),
        })
      ).status,
    ).toBe(200);
    const provider = ownedMCPAuthProvider(await ownedMCPAuthorization(base, cookie));
    const connect = async (auth = provider) => {
      const client = new Client({ name: "Owned native Workspace qualification", version: "1" });
      clients.push(client);
      await client.connect(
        new StreamableHTTPClientTransport(new URL(`${base}/api/mcp`), { authProvider: auth }),
      );
      return client;
    };
    let client = await connect();
    const call = async (target: Client, name: string, args: Record<string, unknown>) => {
      const result = await target.callTool({ name, arguments: args }, { timeout: 300_000 });
      const text = result.content.find((part) => part.type === "text");
      if (text?.type !== "text") throw new Error(`Native Workspace ${name} has no result`);
      const value = JSON.parse(text.text);
      if (result.isError)
        throw new Error(
          `Native Workspace ${name} failed: ${value.error?.message ?? "unconfirmed"}`,
        );
      return value;
    };
    const editor = createSubstrateControl(configuration.connection);
    const forbiddenAtespace = `fa-${crypto.randomUUID().replaceAll("-", "")}`;
    await writeFile(
      `${live.directory}/permission-probe-${projectID}.json`,
      JSON.stringify({
        atespace: forbiddenAtespace,
        action: "CreateAtespace",
        expected: "PermissionDenied",
      }),
      { flag: "wx", mode: 0o600 },
    );
    unconfirmedPermissionProbe = true;
    const permissionFailure = await editor("CreateAtespace", {
      atespace: { metadata: { name: forbiddenAtespace } },
    }).then(
      () => null,
      (cause: unknown) => cause,
    );
    if (
      permissionFailure instanceof SubstrateRPCError &&
      ["PermissionDenied", "Unauthenticated"].includes(permissionFailure.code)
    )
      unconfirmedPermissionProbe = false;
    expect(permissionFailure).toBeInstanceOf(SubstrateRPCError);
    expect((permissionFailure as SubstrateRPCError).code).toBe("PermissionDenied");
    const wrong = createSubstrateControl({
      ...configuration.connection,
      tokenFile: live.wrongAudienceFile,
    });
    const startRequestID = crypto.randomUUID();
    const starting = call(client, "startWorkspace", { workspaceID, requestID: startRequestID });
    let startFailure: unknown;
    pending.push(
      starting.catch((cause: unknown) => {
        startFailure = cause;
      }),
    );
    await eventually(
      async () => {
        if (startFailure) throw startFailure;
        return app.runtimeHub.sourceConnected(attemptID ?? "");
      },
      Boolean,
      "Initialized native Source remained blocked behind Project preparation",
      30_000,
    );
    expect(app.runtimeHub.ready(attemptID)).toBe(false);
    const earlyRead = await source("read", { path: "server.mjs" });
    expect(earlyRead.status).toBe(200);
    expect(Buffer.from((await earlyRead.json()).content, "base64").toString()).toContain(
      "owned-native-ready",
    );
    const admittedDraft = await source("read", { path: "owned-before-compute.txt" });
    expect(admittedDraft.status).toBe(200);
    expect(Buffer.from((await admittedDraft.json()).content, "base64").toString()).toBe(
      "saved before native Project execution\n",
    );
    expect(
      (
        await source("write", {
          path: "owned-prepare-release",
          content: Buffer.from(projectID).toString("base64"),
        })
      ).status,
    ).toBe(200);
    const started = await starting;
    expect(started.id).toBe(attemptID);
    expect(started.native?.state).toBe("ACTOR_STATE_RUNNING");
    const actor = nativeActor.parse(await editor("GetActor", { actor: ref }));
    expect(actor.status.workerAssignment?.sandboxRuntime).toEqual(live.runtime);
    const originalUID = actor.metadata.uid;
    // Test audience rejection against an actually existing resource. NotFound
    // before native creation would not prove that the wrong audience was denied.
    const audienceFailure = await wrong("GetAtespace", { atespace: { name: ref.atespace } }).then(
      () => null,
      (cause: unknown) => cause,
    );
    expect(audienceFailure).toBeInstanceOf(SubstrateRPCError);
    expect(["Unauthenticated", "PermissionDenied"]).toContain(
      (audienceFailure as SubstrateRPCError).code,
    );
    const detached = (target: typeof ref, uid: string) =>
      eventually(
        async () => {
          const current = nativeActor.parse(await editor("GetActor", { actor: target }));
          expect(current.metadata.uid).toBe(uid);
          return current;
        },
        (value) =>
          value.status.state === "ACTOR_STATE_SUSPENDED" &&
          !value.status.workerAssignment &&
          !value.status.assignedNode,
        "Original ROOTFS proof did not observe node-local snapshot detachment",
        180_000,
      );
    await eventually(
      async () => {
        const observed = await app.runtimeController.get(started.id);
        if (observed?.state === "failed")
          throw new Error(`Native workflow failed: ${observed.failure}`);
        return observed;
      },
      (value) => value?.state === "ready" && app.runtimeHub.ready(started.id),
      "Native parent/child workflow did not become ready",
      180_000,
    );
    expect(app.runtimeHub.ready(started.id)).toBe(true);
    expect(app.runtimeHub.sourceConnected(started.id)).toBe(true);
    const sourceView = await app.workspaceSources.ensurePersonal(projectID, userID);
    expect(sourceView.state).toBe("ready");
    expect(sourceView.workspaceID).toBe(workspaceID);
    expect([
      ...(await database.client`SELECT to_regclass('factory.workspace_source') AS source`),
    ]).toEqual([{ source: null }]);
    const save = await source("write", {
      path: "owned-editor.txt",
      content: Buffer.from("editor-active").toString("base64"),
    });
    expect(save.status).toBe(200);
    const savedFile = await save.json();
    const privateSource = crypto.randomUUID();
    expect(
      (
        await source("write", {
          path: "owned-private.txt",
          content: Buffer.from(privateSource).toString("base64"),
        })
      ).status,
    ).toBe(200);
    expect(savedFile.version).toMatch(/^[a-f0-9]{64}$/);
    expect(
      (
        await source("write", {
          path: "owned-editor.txt",
          content: Buffer.from("stale").toString("base64"),
        })
      ).status,
    ).toBe(409);
    for (const path of ["../connector/trust.pem", ".git/config", "/etc/passwd"])
      expect((await source("read", { path })).status).toBe(403);
    const watchCancel = new AbortController();
    const watched = await source("events", undefined, watchCancel.signal);
    expect(watched.status).toBe(200);
    const reader = watched.body?.getReader();
    if (!reader) throw new Error("Actual Source watch body missing");
    let watchText = "";
    const watchObserved = (async () => {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) throw new Error("Source watch ended before the editor save");
        watchText += new TextDecoder().decode(chunk.value);
        if (watchText.includes('"path":"owned-editor.txt"')) return;
      }
    })();
    const watchDeadline = setTimeout(() => watchCancel.abort(), 10_000);
    try {
      expect(
        (
          await source("write", {
            path: "owned-editor.txt",
            content: Buffer.from("editor-atomic").toString("base64"),
            version: savedFile.version,
          })
        ).status,
      ).toBe(200);
      await watchObserved;
      expect(watchText).toContain("owned-editor.txt");
    } finally {
      clearTimeout(watchDeadline);
      watchCancel.abort();
      await reader.cancel().catch(() => {});
    }
    const search = await source("search", { search: { query: "editor-atomic" } });
    expect(search.status).toBe(200);
    expect(await search.text()).toContain("owned-editor.txt");
    expect(connections.some((c) => c.role === "parent")).toBe(true);
    expect(connections.some((c) => c.role === "child")).toBe(true);
    await eventually(
      () => app.runtimeController.get(started.id),
      (value) => Boolean(value?.appReadyAt?.["app"]),
      "Declared native App did not become healthy",
      30_000,
    );
    const parent = await app.runtimeHub.parentOperation(started.id, {
      operationId: crypto.randomUUID(),
      action: "workspace-git",
      data: JSON.stringify({ action: "status", branch: "main" }),
    });
    expect(parent.data).toBeTruthy();
    expect(JSON.parse(parent.data ?? "{}")).toMatchObject({ head: revision, branch: "main" });
    const appCookie = await runtimeAccessCookie(base, cookie, started.id, "app");
    expect(
      await (
        await fetch(`${base}/runtime/${started.id}/app/`, { headers: { cookie: appCookie } })
      ).text(),
    ).toBe("owned-native-ready");
    expect(
      await (
        await fetch(`${base}/runtime/${started.id}/app/editor`, { headers: { cookie: appCookie } })
      ).text(),
    ).toBe("editor-atomic");
    let privateState:
      | { hostname: string; rootfs: string; volume: string; createEffects: string }
      | undefined;
    const probeID = crypto.randomUUID();
    const probe = {
      id: probeID,
      dirtyPath: "server.mjs",
      stagedPath: "owned-staged.txt",
      untrackedPath: "owned-dirty.txt",
      appURL: "http://127.0.0.1:4300/",
      // Substrate mounts /tmp as tmpfs. Use /var/tmp outside the explicitly
      // durable /home/node and verify its actual backing mount below.
      rootfsPath: `/var/tmp/factory-starter-${probeID}.rootfs`,
    };
    const probeSchema = z.object({
      process: starterActiveObservationSchema.shape.process,
      rootfs: starterActiveObservationSchema.shape.rootfs.extend({
        path: z.literal(probe.rootfsPath),
      }),
      dirtySource: starterActiveObservationSchema.shape.dirtySource,
      stagedSource: starterActiveObservationSchema.shape.stagedSource,
      untrackedSource: starterActiveObservationSchema.shape.untrackedSource,
      appStatus: z.literal(200),
    });
    let beforeProbe: z.infer<typeof probeSchema> | undefined;
    let afterProbe: z.infer<typeof probeSchema> | undefined;
    let rootfsMount: { realPath: string; target: string; type: string } | undefined;
    const terminal = await ownedRuntimeTerminal(base, cookie, started.id, "native-source-before");
    try {
      expect(await terminal.evaluate<string>("return process.cwd()")).toBe("/workspace/project");
      expect(
        await terminal.evaluate(
          "const fs=require('fs');const stat=fs.statSync('owned-editor.txt');const content=fs.readFileSync('owned-editor.txt','utf8');fs.appendFileSync('owned-editor.txt','-terminal');return {uid:stat.uid,gid:stat.gid,content}",
        ),
      ).toEqual({ uid: 1000, gid: 1000, content: "editor-atomic" });
      const readEditor = await source("read", { path: "owned-editor.txt" });
      expect(readEditor.status).toBe(200);
      expect(Buffer.from((await readEditor.json()).content, "base64").toString()).toBe(
        "editor-atomic-terminal",
      );
      expect(
        await terminal.evaluate<boolean>(
          "require('fs').writeFileSync('owned-dirty.txt','private dirty Source');require('fs').appendFileSync('server.mjs','// owned uncommitted change\\n');return !process.env.FACTORY_SUBSTRATE_BOOTSTRAP && !process.env.FACTORY_CONNECTOR_TOKEN",
        ),
      ).toBe(true);
      rootfsMount = await terminal.evaluate(
        "const fs=require('fs');const realPath=fs.realpathSync('/var/tmp');const mounts=fs.readFileSync('/proc/self/mountinfo','utf8').trim().split('\\n').map(line=>{const [head,tail]=line.split(' - ');return {target:head.split(' ')[4],type:tail.split(' ')[0]};}).filter(m=>realPath===m.target||realPath.startsWith(m.target.endsWith('/')?m.target:m.target+'/')).sort((a,b)=>b.target.length-a.target.length);return {realPath,...mounts[0]}",
      );
      expect(rootfsMount?.realPath).toBe("/var/tmp");
      expect(rootfsMount?.target).toBe("/");
      expect(rootfsMount?.type).not.toBe("tmpfs");
      privateState = await terminal.evaluate(
        "const fs=require('fs');fs.writeFileSync('/var/tmp/owned-private-rootfs-state','retained rootfs');fs.writeFileSync('/home/node/owned-private-volume-state','retained volume');return {hostname:require('os').hostname(),rootfs:fs.readFileSync('/var/tmp/owned-private-rootfs-state','utf8'),volume:fs.readFileSync('/home/node/owned-private-volume-state','utf8'),createEffects:fs.readFileSync('/home/node/owned-create-effects','utf8')}",
      );
      expect(privateState?.createEffects).toBe("once\n");
      await terminal.evaluate(
        "require('fs').writeFileSync('owned-staged.txt','staged native Source\\n');require('child_process').execFileSync('git',['add','--','owned-staged.txt']);return true",
      );
      const observed = await starterNativeLifecycle(client).command({
        workspaceID,
        attemptID: started.id,
        command: starterProbeCommand(probe, "create"),
      });
      beforeProbe = probeSchema.parse(JSON.parse(observed.stdout));
      expect(
        await terminal.evaluate<boolean>(
          "return !require('fs').existsSync('/var/run/docker.sock') && !require('fs').existsSync('/var/run/secrets/kubernetes.io/serviceaccount/token')",
        ),
      ).toBe(true);
      const incompatibleMetadata = await terminal.evaluate<
        Array<{ path: string; uid: number; gid: number; mode: number }>
      >(
        "const fs=require('fs');const invalid=[];const walk=(path)=>{const s=fs.lstatSync(path);if(s.uid!==1000||s.gid!==1000||(s.mode&0o7000)!==0)invalid.push({path,uid:s.uid,gid:s.gid,mode:s.mode});if(s.isDirectory())for(const name of fs.readdirSync(path))walk(path+'/'+name);};walk('.');return invalid;",
      );
      expect(incompatibleMetadata).toEqual([]);
    } finally {
      terminal.close();
      await app.runtimeController.closeTerminal(started.id, "native-source-before");
    }
    const headers = {
      authorization: `Bearer ${runtimeConnectorTokens(process.env["FACTORY_AUTH_SECRET"] ?? "", started.id, 1).parent}`,
      "x-factory-runtime-attempt": started.id,
      "x-factory-runtime-generation": "1",
      "x-factory-connector-role": "parent",
      "x-factory-runtime-actor-uid": originalUID,
    };
    const denied = async (changed: Record<string, string>) =>
      (await fetch(`${base}/internal/runtime-connect`, { headers: { ...headers, ...changed } }))
        .status;
    expect(await denied({ "x-factory-runtime-actor-uid": crypto.randomUUID() })).toBe(401);
    expect(await denied({ "x-factory-runtime-generation": "2" })).toBe(401);
    expect(await denied({ "x-factory-connector-role": "child" })).toBe(401);
    await database.client`UPDATE factory.project_membership SET role='product-contributor' WHERE project_id=${projectID} AND user_id=${userID}`;
    expect(await denied({})).toBe(401);
    expect((await source("read", { path: "owned-editor.txt" })).status).toBe(403);
    await database.client`UPDATE factory.project_membership SET role='developer' WHERE project_id=${projectID} AND user_id=${userID}`;
    await expect(
      editor("DeleteActor", {
        actor: ref,
        options: { uid: crypto.randomUUID(), version: actor.metadata.version },
      }),
    ).rejects.toBeInstanceOf(SubstrateRPCError);
    await expect(
      editor("DeleteActor", {
        actor: ref,
        options: { uid: originalUID, version: String(BigInt(actor.metadata.version) + 100n) },
      }),
    ).rejects.toBeInstanceOf(SubstrateRPCError);
    const dirty = await app.runtimeHub.parentOperation(started.id, {
      operationId: crypto.randomUUID(),
      action: "workspace-git",
      data: JSON.stringify({ action: "status", branch: "main" }),
    });
    expect(dirty.data).toBeTruthy();
    const dirtyStatus = JSON.parse(dirty.data ?? "{}");
    expect(dirtyStatus).toMatchObject({ head: revision, branch: "main" });
    expect(dirtyStatus.files).toContainEqual({ path: "owned-dirty.txt", status: "??" });
    expect(dirtyStatus.files).toContainEqual({ path: "server.mjs", status: " M" });
    const originalProvision =
      await database.client`SELECT resources FROM factory.substrate_provision WHERE owner_id=${workspaceID} AND kind='workspace'`;
    const leaseBeforePause = await database.client`SELECT actor_uid,owner,writer_epoch,writable,
      generation,checkpoint_id,checkpoint,service_base,seed,seed_confirmed_at
      FROM factory.substrate_source WHERE workspace_id=${workspaceID}`;
    const pauseRequestID = crypto.randomUUID();
    const suspendsBeforePause = await suspendCount();
    await writeFile(pauseFaultFile, JSON.stringify({ name: ref.name }), { mode: 0o600 });
    const pausing = call(client, "pauseWorkspace", { workspaceID, requestID: pauseRequestID });
    const disconnectedPause = pausing.then(
      () => "unexpected acknowledged success",
      () => "caller disconnected; original outcome requires observation",
    );
    pending.push(disconnectedPause);
    await eventually(
      () => Bun.file(pauseHeldFile).exists(),
      Boolean,
      "Original native Suspend did not reach the owned response barrier",
      180_000,
    );
    const [pauseIntent] = await database.client`SELECT payload->>'action' AS action,
      payload->>'runtimeAttemptId' AS runtime_attempt_id,
      payload->>'dispatchAttemptedAt' AS dispatch_attempted_at,
      completed_at,result FROM factory.operation
      WHERE id=${pauseRequestID} AND kind='workspace.lifecycle'`;
    expect(pauseIntent).toMatchObject({
      action: "pause",
      runtime_attempt_id: started.id,
      completed_at: null,
      result: null,
    });
    expect(pauseIntent?.["dispatch_attempted_at"]).not.toBeNull();
    await client.close();
    expect(await disconnectedPause).not.toBe("unexpected acknowledged success");
    await rm(pauseFaultFile);
    await writeFile(pauseReleaseFile, "release original Suspend response", { mode: 0o600 });
    const recordedPause = await eventually(
      async () => {
        const [row] = await database.client`SELECT result,completed_at FROM factory.operation
          WHERE id=${pauseRequestID} AND kind='workspace.lifecycle'`;
        return row;
      },
      (row) => row?.["completed_at"] !== null && row?.["result"]?.state === "paused",
      "The original disconnected Pause did not settle in its durable command record",
      180_000,
    );
    client = await connect();
    expect(
      await call(client, "pauseWorkspace", { workspaceID, requestID: pauseRequestID }),
    ).toEqual(recordedPause?.["result"]);
    expect(await suspendCount()).toBe(suspendsBeforePause + 1);
    const paused = await app.runtimeController.get(started.id);
    expect(paused?.state).toBe("paused");
    expect(paused?.native?.portable).toBe(false);
    expect(await denied({})).toBe(401);
    const [saved] = await database.client`SELECT checkpoint FROM factory.runtime_attempt
      WHERE id=${started.id}`;
    const checkpoint = nativeSnapshot.parse(saved?.["checkpoint"]);
    expect(checkpoint.fidelity).toBe("SNAPSHOT_FIDELITY_ROOTFS");
    expect(checkpoint.durableSnapshot.state).toBe("SNAPSHOT_STORAGE_STATE_COMPLETED");
    const suspendedActor = await detached(ref, originalUID);
    expect(suspendedActor.metadata.uid).toBe(originalUID);
    expect(suspendedActor.status.snapshots).toContainEqual(expect.objectContaining(checkpoint));
    expect((await app.workspaceSources.get(workspaceID, userID)).state).toBe("paused");
    expect(
      await database.client`SELECT actor_uid,owner,writer_epoch,writable,generation,checkpoint_id,
      checkpoint,service_base,seed,seed_confirmed_at FROM factory.substrate_source
      WHERE workspace_id=${workspaceID}`,
    ).toEqual(leaseBeforePause);
    // Passive watch reconnect is not current-file demand and must not undo Pause.
    expect((await source("events", undefined, AbortSignal.timeout(2000))).status).toBe(503);
    expect(nativeActor.parse(await editor("GetActor", { actor: ref })).status.state).toBe(
      "ACTOR_STATE_SUSPENDED",
    );
    // Same Project, a different personal Workspace. Start it through the same
    // authenticated product command while A sleeps; never copy a Source tree.
    const otherDeveloper = await app.factoryAuth.createManagedUser({
      name: "Other native Developer",
      email: "native-other@factory.local",
      password: "owned-native-other-password",
    });
    const otherUserID = z.uuid().parse(otherDeveloper?.id);
    const otherWorkspaceID = personalWorkspaceIdentity(projectID, otherUserID).workspaceID;
    await database.client`INSERT INTO factory.project_membership(project_id,user_id,role,updated_by) VALUES(${projectID},${otherUserID},'developer',${userID})`;
    const otherLogin = await fetch(`${base}/api/auth/sign-in/email`, {
      method: "POST",
      headers: { origin: base, "content-type": "application/json" },
      body: JSON.stringify({
        email: "native-other@factory.local",
        password: "owned-native-other-password",
      }),
    });
    expect(otherLogin.status).toBe(200);
    const otherCookie = otherLogin.headers
      .getSetCookie()
      .map((value) => value.split(";")[0])
      .join("; ");
    const otherClient = await connect(
      ownedMCPAuthProvider(await ownedMCPAuthorization(base, otherCookie)),
    );
    const otherSource = (
      target: string,
      operation: string,
      input: unknown,
      asCookie = otherCookie,
    ) =>
      fetch(`${base}/api/workspaces/${target}/source/${operation}`, {
        method: "POST",
        headers: { cookie: asCookie, origin: base, "content-type": "application/json" },
        body: JSON.stringify(input),
      });
    const otherAttemptID = runtimeIdentity(otherWorkspaceID, 1).attemptID;
    extraAttemptIDs.push(otherAttemptID);
    const otherStarting = call(otherClient, "startWorkspace", {
      projectID,
      requestID: crypto.randomUUID(),
    });
    let otherStartFailure: unknown;
    pending.push(
      otherStarting.catch((cause: unknown) => {
        otherStartFailure = cause;
      }),
    );
    await eventually(
      async () => {
        if (otherStartFailure) throw otherStartFailure;
        return app.runtimeHub.sourceConnected(otherAttemptID);
      },
      Boolean,
      "Other personal Source remained blocked behind Project preparation",
      30_000,
    );
    expect(
      (
        await otherSource(otherWorkspaceID, "write", {
          path: "owned-prepare-release",
          content: Buffer.from(projectID).toString("base64"),
        })
      ).status,
    ).toBe(200);
    const otherAttempt = await otherStarting;
    expect(otherAttempt.id).toBe(otherAttemptID);
    expect(otherAttempt.id).not.toBe(started.id);
    await eventually(
      () => app.runtimeController.get(otherAttempt.id),
      (value) => value?.state === "ready" && app.runtimeHub.sourceConnected(otherAttempt.id),
      "Other personal Source did not become ready",
      180_000,
    );
    expect(
      (await otherSource(otherWorkspaceID, "read", { path: "owned-private.txt" })).status,
    ).toBe(404);
    expect(
      (await otherSource(otherWorkspaceID, "read", { path: "owned-before-compute.txt" })).status,
    ).toBe(404);
    expect((await otherSource(otherWorkspaceID, "read", { path: "owned-editor.txt" })).status).toBe(
      404,
    );
    expect(
      (await otherSource(otherWorkspaceID, "read", { path: "owned-private.txt" }, cookie)).status,
    ).toBe(404);
    expect((await otherSource(workspaceID, "read", { path: "owned-private.txt" })).status).toBe(
      404,
    );
    const otherPrivate = crypto.randomUUID();
    expect(
      (
        await otherSource(otherWorkspaceID, "write", {
          path: "owned-private.txt",
          content: Buffer.from(otherPrivate).toString("base64"),
        })
      ).status,
    ).toBe(200);
    const otherRead = await otherSource(otherWorkspaceID, "read", { path: "owned-private.txt" });
    expect(otherRead.status).toBe(200);
    expect(
      Buffer.from((await otherRead.json()).content, "base64").toString() === otherPrivate,
    ).toBe(true);
    expect(nativeActor.parse(await editor("GetActor", { actor: ref })).status.state).toBe(
      "ACTOR_STATE_SUSPENDED",
    );
    await expect(
      serverCall(
        callFactoryFunction(base, "stopRuntimeAttempt", [otherAttempt.id], { cookie: otherCookie }),
      ),
    ).rejects.toThrow("Use Pause compute");
    const otherPaused = await call(otherClient, "pauseWorkspace", {
      workspaceID: otherWorkspaceID,
      requestID: crypto.randomUUID(),
    });
    expect(otherPaused.id).toBe(otherAttempt.id);
    expect(otherPaused.state).toBe("paused");
    await detached(
      {
        atespace: `fa-${otherAttempt.id.replaceAll("-", "")}`,
        name: `runtime-${otherAttempt.id.replaceAll("-", "")}`,
      },
      z.uuid().parse(otherAttempt.native?.actorUID),
    );
    const resumeConnections = connections.length;
    // Current-file access deliberately wakes A's same Actor; B's private Source
    // and all passive metadata/watch observations above did not.
    const wakingRead = await source("read", { path: "owned-editor.txt" });
    expect(wakingRead.status).toBe(200);
    expect(Buffer.from((await wakingRead.json()).content, "base64").toString()).toBe(
      "editor-atomic-terminal",
    );
    expect((await app.runtimeController.get(started.id))?.native?.actorUID).toBe(originalUID);
    await eventually(
      () => app.runtimeController.get(started.id),
      (value) =>
        value?.state === "ready" &&
        app.runtimeHub.ready(started.id) &&
        ["parent", "child"].every((r) =>
          connections.slice(resumeConnections).some((c) => c.role === r),
        ),
      "Cold parent/child workflow did not reconnect",
      180_000,
    );
    const restoredGit = await app.runtimeHub.parentOperation(started.id, {
      operationId: crypto.randomUUID(),
      action: "workspace-git",
      data: JSON.stringify({ action: "status", branch: "main" }),
    });
    expect(restoredGit.data).toBeTruthy();
    expect(JSON.parse(restoredGit.data ?? "{}")).toEqual(dirtyStatus);
    expect(app.runtimeHub.sourceConnected(started.id)).toBe(true);
    const restoredSource = await source("read", { path: "owned-editor.txt" });
    expect(restoredSource.status).toBe(200);
    expect(Buffer.from((await restoredSource.json()).content, "base64").toString()).toBe(
      "editor-atomic-terminal",
    );
    const restoredPrivateSource = await source("read", { path: "owned-private.txt" });
    expect(restoredPrivateSource.status).toBe(200);
    expect(
      Buffer.from((await restoredPrivateSource.json()).content, "base64").toString() ===
        privateSource,
    ).toBe(true);
    const restoredAppCookie = await runtimeAccessCookie(base, cookie, started.id, "app");
    // Development Terminal readiness is intentionally independent of App health.
    // Probe the new App itself, not the retained first-ready timestamp or hello.
    const restoredApp = await eventually(
      async () => {
        const response = await fetch(`${base}/runtime/${started.id}/app/`, {
          headers: { cookie: restoredAppCookie },
        });
        const observation = {
          at: Date.now(),
          status: response.status,
          body: await response.text(),
        };
        return observation;
      },
      (value) => value.status === 200 && value.body === "owned-native-ready",
      "Restored declared App did not become healthy",
      30_000,
    );
    expect(restoredApp.status).toBe(200);
    expect(restoredApp.body).toBe("owned-native-ready");
    expect(
      await (
        await fetch(`${base}/runtime/${started.id}/app/editor`, {
          headers: { cookie: restoredAppCookie },
        })
      ).text(),
    ).toBe("editor-atomic-terminal");
    const [resumedLease] =
      await database.client`SELECT actor_uid,owner,writer_epoch,writable,generation,checkpoint_id,
        checkpoint,service_base,seed,seed_confirmed_at FROM factory.substrate_source
        WHERE workspace_id=${workspaceID}`;
    expect(resumedLease?.["owner"]).toBe("actor");
    expect(resumedLease).toEqual(leaseBeforePause[0]);
    expect(await denied({ "x-factory-runtime-actor-uid": crypto.randomUUID() })).toBe(401);
    expect(await denied({ "x-factory-runtime-generation": "2" })).toBe(401);
    expect(await denied({ "x-factory-connector-role": "child" })).toBe(401);
    const restoredTerminal = await ownedRuntimeTerminal(
      base,
      cookie,
      started.id,
      "native-source-after",
    );
    try {
      expect(
        await restoredTerminal.evaluate<string>(
          "return require('fs').readFileSync('owned-dirty.txt','utf8')",
        ),
      ).toBe("private dirty Source");
      expect(
        await restoredTerminal.evaluate(
          "const fs=require('fs');return {rootfs:fs.readFileSync('/var/tmp/owned-private-rootfs-state','utf8'),volume:fs.readFileSync('/home/node/owned-private-volume-state','utf8'),createEffects:fs.readFileSync('/home/node/owned-create-effects','utf8')}",
        ),
      ).toEqual({
        rootfs: privateState?.rootfs,
        volume: privateState?.volume,
        createEffects: privateState?.createEffects,
      });
      if (!beforeProbe) throw new Error("Initial live ROOTFS probe is unavailable");
      const observed = await starterNativeLifecycle(client).command({
        workspaceID,
        attemptID: started.id,
        command: starterProbeCommand({ ...probe, previousProcess: beforeProbe.process }, "restart"),
      });
      afterProbe = probeSchema.parse(JSON.parse(observed.stdout));
      expect(afterProbe.rootfs).toEqual(beforeProbe.rootfs);
      expect(afterProbe.process.bootID).not.toBe(beforeProbe.process.bootID);
      expect(afterProbe.process.memoryNonce).not.toBe(beforeProbe.process.memoryNonce);
      for (const kind of ["dirtySource", "stagedSource", "untrackedSource"] as const)
        expect(afterProbe[kind]).toEqual(beforeProbe[kind]);
      await writeFile(
        `${live.directory}/native-rootfs-proof-${projectID}.json`,
        JSON.stringify(
          {
            projectID,
            workspaceID,
            attemptID: started.id,
            actorUID: originalUID,
            runtime: live.runtime,
            snapshot: checkpoint,
            rootfsMount,
            before: beforeProbe,
            after: afterProbe,
            scope: "Same-node ROOTFS checkpoint; the complete native lane is not yet passed",
          },
          null,
          2,
        ),
        { flag: "wx", mode: 0o600 },
      );
      const disposed = await starterNativeLifecycle(client).command({
        workspaceID,
        attemptID: started.id,
        command: starterProbeCommand(probe, "dispose"),
      });
      expect(JSON.parse(disposed.stdout)).toEqual({ disposed: true });
      expect(
        await restoredTerminal.evaluate<boolean>(
          "return !process.env.FACTORY_SUBSTRATE_BOOTSTRAP && !process.env.FACTORY_CONNECTOR_TOKEN && !require('fs').existsSync('/var/run/docker.sock') && !require('fs').existsSync('/var/run/secrets/kubernetes.io/serviceaccount/token')",
        ),
      ).toBe(true);
    } finally {
      restoredTerminal.close();
      await app.runtimeController.closeTerminal(started.id, "native-source-after");
    }
    expect([
      ...(await database.client`SELECT to_regclass('factory.factorybox_worker') AS worker`),
    ]).toEqual([{ worker: null }]);
    expect(
      await database.client`SELECT resources FROM factory.substrate_provision WHERE owner_id=${workspaceID} AND kind='workspace'`,
    ).toEqual(originalProvision);
    expect(
      await database.client`SELECT id FROM factory.runtime_attempt WHERE workspace_id=${workspaceID}`,
    ).toHaveLength(1);
    expect(await database.client`SELECT id FROM factory.runtime_attempt`).toHaveLength(2);
    if (live.qualification === "lifecycle-and-git") {
      // Native Parent regression, not a Ticket/approval/Delivery substitute. The
      // real HTTPS CGI remote shares only this owned ingress's exact pinned origin.
      const remoteRoot = `${live.directory}/native-git-${projectID}`;
      await Bun.$`mkdir -p ${remoteRoot}`.quiet();
      await Bun.$`git clone --bare --no-hardlinks ${repository} ${remoteRoot}/remote.git`.quiet();
      await Bun.$`git -C ${remoteRoot}/remote.git config http.receivepack true`.quiet();
      const remote = nativeGitHTTP(remoteRoot);
      const staticAssets = app.staticAssets;
      app.staticAssets = async (request) => (await remote.fetch(request)) ?? staticAssets(request);
      const commit = await app.runtimeHub.parentOperation(started.id, {
        operationId: crypto.randomUUID(),
        action: "git-prepare-commit",
        expectedSha: revision,
        commitMessage: "Owned native Git checkpoint",
        authorName: "Factory",
        authorEmail: "owned@example.invalid",
      });
      const committed = z
        .string()
        .regex(/^[a-f0-9]{40}$/)
        .parse(commit.commitSHA);
      await writeFile(`${repository}/native-upstream.txt`, "owned native upstream\n");
      await Bun.$`git -C ${repository} add native-upstream.txt`.quiet();
      await Bun.$`git -C ${repository} -c user.name=Owned -c user.email=owned@example.invalid commit -m upstream`.quiet();
      const upstream = (await Bun.$`git -C ${repository} rev-parse HEAD`.text()).trim();
      await Bun.$`git -C ${repository} push ${remoteRoot}/remote.git main:upstream`.quiet();
      await Bun.$`git -C ${remoteRoot}/remote.git update-ref refs/heads/ticket ${revision}`.quiet();
      const integration = {
        operationId: crypto.randomUUID(),
        action: "git-prepare-integration",
        expectedSha: committed,
        mergeParentSha: upstream,
        repositoryUrl: `https://${live.factoryHostname}${remote.prefix}/remote.git`,
        username: remote.username,
        password: remote.password,
        branch: "ticket",
        commitMessage: "Owned native integration",
        authorName: "Factory",
        authorEmail: "owned@example.invalid",
      };
      // Bun's pending .rejects matcher re-enters WebSocket callbacks. Await
      // the real operation first, then assert its unchanged denial.
      const refusedIntegration = await app.runtimeHub
        .parentOperation(started.id, {
          ...integration,
          operationId: crypto.randomUUID(),
          repositoryUrl: `https://${live.factoryHostname}${remote.prefix}/redirect.git`,
        })
        .catch((error: unknown) => error);
      expect(refusedIntegration).toBeInstanceOf(Error);
      expect((refusedIntegration as Error).message).toContain(
        "integration source could not be fetched",
      );
      expect(remote.observations.redirects).toBeGreaterThan(0);
      expect(remote.observations.authenticated).toBe(0);
      const integrated = await app.runtimeHub.parentOperation(started.id, integration);
      const integratedSHA = z
        .string()
        .regex(/^[a-f0-9]{40}$/)
        .parse(integrated.commitSHA);
      const observed = await app.runtimeHub.parentOperation(started.id, {
        ...integration,
        action: "git-observe-commit",
      });
      expect(observed.commitSHA).toBe(integratedSHA);
      const push = {
        ...integration,
        operationId: crypto.randomUUID(),
        action: "git-push",
        expectedSha: revision,
        commitSha: integratedSHA,
      };
      const authenticatedBeforeRedirect = remote.observations.authenticated;
      const redirectsBeforePush = remote.observations.redirects;
      const refusedPush = await app.runtimeHub
        .parentOperation(started.id, {
          ...push,
          operationId: crypto.randomUUID(),
          repositoryUrl: `https://${live.factoryHostname}${remote.prefix}/redirect.git`,
        })
        .catch((error: unknown) => error);
      expect(refusedPush).toBeInstanceOf(Error);
      expect((refusedPush as Error).message).toContain("remote branch could not be observed");
      expect(remote.observations.redirects).toBeGreaterThan(redirectsBeforePush);
      expect(remote.observations.authenticated).toBe(authenticatedBeforeRedirect);
      expect(remote.observations.pushes).toBe(0);
      expect((await app.runtimeHub.parentOperation(started.id, push)).remoteSHA).toBe(
        integratedSHA,
      );
      const pushed = remote.observations.pushes;
      expect(pushed).toBe(1);
      expect((await app.runtimeHub.parentOperation(started.id, push)).remoteSHA).toBe(
        integratedSHA,
      );
      expect(remote.observations.pushes).toBe(pushed);
      expect(remote.observations.authenticated).toBeGreaterThan(0);
      const gitPause = await app.runtimeController.pause(started.id);
      expect(gitPause?.state).toBe("paused");
      await detached(ref, originalUID);
      expect((await app.workspaceSources.get(workspaceID, userID)).state).toBe("paused");
      const archivedUpstream = await source("read", { path: "native-upstream.txt" });
      expect(archivedUpstream.status).toBe(200);
      expect(Buffer.from((await archivedUpstream.json()).content, "base64").toString()).toBe(
        "owned native upstream\n",
      );
    }
    // Concurrent, deliberate Starts serialize onto the same retained Actor,
    // not replacement Runtime Attempts or a transferred checkout.
    const beforeConcurrent = await call(client, "pauseWorkspace", {
      workspaceID,
      requestID: crypto.randomUUID(),
    });
    expect(beforeConcurrent.id).toBe(started.id);
    await detached(ref, originalUID);
    const resumesBeforeConcurrent = (await rpcCalls()).filter(
      (row) => row.method === "ResumeActor" && row.phase === "dispatch" && row.name === ref.name,
    ).length;
    const concurrentStarts = await Promise.all(
      [0, 1].map(() =>
        call(client, "startWorkspace", {
          workspaceID,
          requestID: crypto.randomUUID(),
        }),
      ),
    );
    for (const result of concurrentStarts) {
      expect(result.id).toBe(started.id);
      expect(result.native?.actorUID).toBe(originalUID);
    }
    await eventually(
      () => app.runtimeController.get(started.id),
      (value) => value?.state === "ready" && app.runtimeHub.ready(started.id),
      "Concurrent Starts did not restore the original Work container",
      180_000,
    );
    expect(
      (await rpcCalls()).filter(
        (row) => row.method === "ResumeActor" && row.phase === "dispatch" && row.name === ref.name,
      ),
    ).toHaveLength(resumesBeforeConcurrent + 1);
    // The obsolete public destructive alias must never delete a Workspace.
    const deletesBeforeRefusal = (await rpcCalls()).filter(
      (row) => row.method === "DeleteActor" && row.phase === "dispatch",
    ).length;
    await expect(
      serverCall(callFactoryFunction(base, "stopRuntimeAttempt", [started.id], { cookie })),
    ).rejects.toThrow("Use Pause compute");
    expect(nativeActor.parse(await editor("GetActor", { actor: ref })).metadata.uid).toBe(
      originalUID,
    );
    const finalPauseRequestID = crypto.randomUUID();
    const finalPaused = await call(client, "pauseWorkspace", {
      workspaceID,
      requestID: finalPauseRequestID,
    });
    expect(finalPaused.id).toBe(started.id);
    expect(finalPaused.state).toBe("paused");
    await detached(ref, originalUID);
    const finalSuspends = await suspendCount();
    expect(
      await call(client, "pauseWorkspace", { workspaceID, requestID: finalPauseRequestID }),
    ).toEqual(finalPaused);
    expect(await suspendCount()).toBe(finalSuspends);
    await expect(
      serverCall(callFactoryFunction(base, "stopRuntimeAttempt", [started.id], { cookie })),
    ).rejects.toThrow("Use Pause compute");
    expect(
      (await rpcCalls()).filter((row) => row.method === "DeleteActor" && row.phase === "dispatch"),
    ).toHaveLength(deletesBeforeRefusal);
    expect((await app.workspaceSources.get(workspaceID, userID)).state).toBe("paused");
    expect(nativeActor.parse(await editor("GetActor", { actor: ref })).status.state).toBe(
      "ACTOR_STATE_SUSPENDED",
    );
    const finalSource =
      await database.client`SELECT actor_uid,owner,writer_epoch,writable,generation,
      checkpoint_id,checkpoint,service_base,seed,seed_confirmed_at FROM factory.substrate_source
      WHERE workspace_id=${workspaceID}`;
    expect(finalSource).toEqual(leaseBeforePause);
    const [retained] = await database.client`SELECT stop_intended_at,actor_uid,delete_intended_at,
      deleted_at FROM factory.runtime_attempt
      WHERE id=${started.id}`;
    expect(retained).toEqual({
      stop_intended_at: null,
      actor_uid: originalUID,
      delete_intended_at: null,
      deleted_at: null,
    });
    const generations = await database.client`SELECT generation FROM factory.runtime_attempt
      WHERE workspace_id=${workspaceID} ORDER BY generation`;
    expect(generations.map((row) => Number(row["generation"]))).toEqual([1]);
    const creates = (await rpcCalls()).filter(
      (row) => row.method === "CreateActor" && row.phase === "dispatch" && row.name === ref.name,
    );
    expect(creates).toHaveLength(1);
    expect(
      await database.client`SELECT id FROM factory.agent_turn WHERE project_id=${projectID}`,
    ).toHaveLength(0);
    expect(
      await database.client`SELECT id FROM factory.usage_operation WHERE project_id=${projectID}`,
    ).toHaveLength(0);
    if (!beforeProbe || !afterProbe) throw new Error("Actual cold process evidence is incomplete");
    await writeFile(
      `${live.directory}/lifecycle-evidence-${projectID}.json`,
      JSON.stringify(
        {
          projectID,
          workspaceID,
          originalUID,
          otherWorkspaceID,
          qualification: live.qualification,
          workloadImage: live.workloadImage,
          runtime: live.runtime,
          startRequestID,
          pauseRequestID,
          finalPauseRequestID,
          rpcLog,
          rootfs: { mount: rootfsMount, before: beforeProbe, after: afterProbe },
          sourceBefore: leaseBeforePause,
          sourceAfter: finalSource,
          inference: { agentTurns: 0, modelOperations: 0 },
          scope:
            "Owned native Workspace ROOTFS retention and authenticated MCP command proof; not MEMORY or full Starter/release acceptance",
          checks: [
            "Source before native execution",
            "Source before Project preparation",
            "same Actor/Attempt/canonical Source on ROOTFS Pause and read wake",
            "durable snapshot and worker detach",
            "actual process/RAM cold restart",
            "dirty, staged and ignored Source retention",
            "private personal Workspaces",
            "lost caller reply observed through the original Pause command",
            "concurrent Starts retain one Actor",
            "public destructive Stop refused",
            "final retained Pause",
            ...(live.qualification === "lifecycle-and-git" ? ["native Parent Git"] : []),
          ],
        },
        null,
        2,
      ),
      { flag: "wx", mode: 0o600 },
    );
  } catch (error) {
    failure = error;
    await writeFile(`${live.directory}/native-workspace-failure-${projectID}.log`, String(error), {
      mode: 0o600,
    });
  } finally {
    await writeFile(pauseReleaseFile, "release original response", { mode: 0o600 });
    await rm(pauseFaultFile, { force: true });
    for (const client of clients) await client.close().catch(() => undefined);
    await Promise.allSettled(pending);
    allowBackground = false;
    for (const server of servers) await server.stop(true);
    await closeRelay?.();
    ingress.close();
    await closeBackground?.();
    await application?.workspaceSources.close();
    let cleanupFailure: unknown;
    async function cleanupOwnedScopes() {
      if (unconfirmedPermissionProbe)
        throw new Error("Unconfirmed permission-probe create retains the qualification data");
      const ownedNames = new Set(
        [attemptID, ...extraAttemptIDs]
          .filter(Boolean)
          .map((id) => `fa-${id?.replaceAll("-", "")}`),
      );
      const scopes =
        await database.client`SELECT resources->'atespace'->'value' AS atespace,resources#>>'{atespace,attemptedAt}' AS atespace_attempted_at,resources->'template'->'value' AS template,resources#>>'{template,attemptedAt}' AS template_attempted_at FROM factory.substrate_provision WHERE kind='workspace'`;
      const control = createSubstrateControl(configuration.provisioner);
      for (const scope of scopes) {
        const savedSpace = scope["atespace"] as { metadata: { name: string; uid: string } } | null;
        if (!savedSpace) {
          if (scope["atespace_attempted_at"])
            throw new Error("Unconfirmed native create retains the owned qualification database");
          continue;
        }
        if (!ownedNames.has(savedSpace.metadata.name))
          throw new Error("Native cleanup found a scope outside this qualification's Attempts");
        const current = (await control("GetAtespace", {
          atespace: { name: savedSpace.metadata.name },
        })) as { metadata: { uid: string } };
        if (current.metadata.uid !== savedSpace.metadata.uid)
          throw new Error("Original qualification Atespace UID changed");
        const savedTemplate = scope["template"] as {
          metadata: { name: string; uid: string };
        } | null;
        if (!savedTemplate && scope["template_attempted_at"])
          throw new Error("Unconfirmed template create retains the owned qualification database");
        // Explicit disposal of this fresh, owned qualification fixture is not
        // ordinary Workspace Stop. Do not export Source or run a replacement
        // generation just to remove disposable test data.
        const bindings = await database.client`SELECT actor_name,actor_uid,create_attempted_at
          FROM factory.runtime_attempt WHERE atespace=${savedSpace.metadata.name}`;
        for (const binding of bindings) {
          if (!binding["actor_uid"]) {
            if (binding["create_attempted_at"])
              throw new Error("Unconfirmed Actor create retains the qualification data");
            continue;
          }
          const ref = { atespace: savedSpace.metadata.name, name: String(binding["actor_name"]) };
          let actor: z.output<typeof nativeActor>;
          try {
            actor = nativeActor.parse(await control("GetActor", { actor: ref }));
          } catch (cause) {
            if (cause instanceof SubstrateRPCError && cause.code === "NotFound") continue;
            throw cause;
          }
          if (
            actor.metadata.uid !== binding["actor_uid"] ||
            actor.actorTemplate.atespace !== savedSpace.metadata.name ||
            actor.actorTemplate.name !== savedTemplate?.metadata.name
          )
            throw new Error("Owned fixture Actor identity changed; no resource was deleted");
          await control("DeleteActor", {
            actor: ref,
            options: { uid: actor.metadata.uid, version: actor.metadata.version },
          });
          await expect(control("GetActor", { actor: ref })).rejects.toMatchObject({
            code: "NotFound",
          });
        }
        if (savedTemplate) {
          const ref = { atespace: savedSpace.metadata.name, name: savedTemplate.metadata.name };
          const currentTemplate = (await control("GetActorTemplate", { actorTemplate: ref })) as {
            metadata: { uid: string };
          };
          if (currentTemplate.metadata.uid !== savedTemplate.metadata.uid)
            throw new Error("Original qualification ActorTemplate UID changed");
          const deletion = Bun.spawn(
            [
              live.cli,
              "--kubeconfig",
              live.kubeconfig,
              "--context",
              live.context,
              "--token-file",
              live.provisionerTokenFile,
              "delete",
              "actor-template",
              savedTemplate.metadata.name,
              "--atespace",
              savedSpace.metadata.name,
            ],
            { stdout: "ignore", stderr: "pipe" },
          );
          const error = await new Response(deletion.stderr).text();
          if (await deletion.exited)
            throw new Error(`Owned template cleanup failed: ${error.slice(-1000)}`);
          await expect(control("GetActorTemplate", { actorTemplate: ref })).rejects.toMatchObject({
            code: "NotFound",
          });
        }
        const deletion = Bun.spawn(
          [
            live.cli,
            "--kubeconfig",
            live.kubeconfig,
            "--context",
            live.context,
            "--token-file",
            live.provisionerTokenFile,
            "delete",
            "atespace",
            savedSpace.metadata.name,
          ],
          { stdout: "ignore", stderr: "pipe" },
        );
        const error = await new Response(deletion.stderr).text();
        if (await deletion.exited)
          throw new Error(`Owned native scope cleanup failed: ${error.slice(-1000)}`);
        await expect(
          control("GetAtespace", { atespace: { name: savedSpace.metadata.name } }),
        ).rejects.toMatchObject({ code: "NotFound" });
      }
    }
    await cleanupOwnedScopes().catch((error: unknown) => {
      cleanupFailure = error;
    });
    await application?.database.client.end({ timeout: 1 });
    await database.client.end({ timeout: 1 });
    for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key];
    Object.assign(process.env, previous);
    if (cleanupFailure) {
      console.error(
        "Owned PostgreSQL, Source and S3 qualification data retained because native cleanup is unconfirmed",
      );
      failure ??= cleanupFailure;
    } else {
      if (attemptID) await removeRuntimeRepository(attemptID);
      for (const id of extraAttemptIDs) await removeRuntimeRepository(id);
      await target.dispose();
      await owner.dispose();
      await objectStore.dispose();
    }
  }
  if (failure) throw failure;
}, 1_200_000);
