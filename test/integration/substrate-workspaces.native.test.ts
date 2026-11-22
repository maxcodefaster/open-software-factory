import { expect, test } from "bun:test";
import { readFile, rm, writeFile } from "node:fs/promises";
import { createConnection } from "node:net";
import { createServer } from "node:tls";
import { z } from "zod";
import { removeRuntimeRepository } from "../../apps/factory/src/runtime/git-http";
import type { SubstrateInstallationConfiguration } from "../../apps/factory/src/runtime/substrate-workspaces";
import { createFactoryApplication } from "../../apps/factory/src/server/application";
import { startFactoryLifecycle } from "../../apps/factory/src/server/lifecycle";
import { startFactoryTransport } from "../../apps/factory/src/server/transport";
import { serverCall } from "../../apps/factory/src/server-functions/result";
import { createDatabase } from "../../packages/db/src/client";
import {
  runtimeConnectorTokens,
  runtimeIdentity,
} from "../../packages/runtime-domain/src/identity";
import {
  createSubstrateControl,
  nativeActor,
  nativeRuntime,
  nativeSnapshot,
  SubstrateRPCError,
} from "../../packages/runtime-kubernetes/src/substrate-control";
import { personalWorkspaceIdentity } from "../../packages/workspace-domain/src/workspace";
import { ownedAttachmentS3 } from "../fixtures/attachment-s3";
import { eventually } from "../fixtures/factory-process";
import { nativeGitHTTP } from "../fixtures/native-git-http";
import { ownedPostgresServer, ownedTestDatabase } from "../fixtures/postgres-server";
import { ownedRuntimeTerminal, runtimeAccessCookie } from "../fixtures/runtime-access";
import { ownedRuntimeConfiguration } from "../fixtures/runtime-configuration";
import { callFactoryFunction } from "../fixtures/server-functions";
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
  if (process.platform !== "linux" || process.getuid?.() !== 1000 || process.getgid?.() !== 1000)
    throw new Error("Independent Source qualification requires Linux UID/GID 1000");
  if (live.context !== `kind-${live.owner}`)
    throw new Error("Native Workspace fixture context ownership mismatch");
  const owner = await ownedPostgresServer();
  const target = await ownedTestDatabase(owner.identity, crypto.randomUUID());
  const previous = { ...process.env };
  const objectStore = await ownedAttachmentS3();
  const projectID = crypto.randomUUID();
  const rpcLog = `${live.directory}/native-rpcs-${projectID}.jsonl`;
  const recordedBridge = `${live.directory}/recorded-bridge-${projectID}`;
  const sourceFailureFile = `${live.directory}/source-failure-${projectID}`;
  const deleteFaultFile = `${live.directory}/delete-fault-${projectID}.json`;
  const deleteHeldFile = `${live.directory}/delete-held-${projectID}`;
  const deleteReleaseFile = `${live.directory}/delete-release-${projectID}`;
  await writeFile(
    recordedBridge,
    `#!${process.execPath}
import { appendFileSync } from "node:fs";
const input = await Bun.stdin.text();
const request = JSON.parse(input);
const name = request.request?.actor?.name ?? request.request?.actor?.metadata?.name;
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
const fault = Bun.file(${JSON.stringify(deleteFaultFile)});
if (request.method === "DeleteActor" && exit === 0 && !result?.error && await fault.exists()) {
  const expected = await fault.json();
  if (name === expected.name) {
    await Bun.write(${JSON.stringify(deleteHeldFile)}, name);
    while (!(await Bun.file(${JSON.stringify(deleteReleaseFile)}).exists())) await Bun.sleep(20);
    appendFileSync(${JSON.stringify(rpcLog)}, JSON.stringify({ at: Date.now(), method: request.method, name, phase: "lost-reply" }) + "\\n", { mode: 0o600 });
    process.stdout.write(JSON.stringify({ error: { code: "Unavailable", message: "Owned lost Delete reply" } }));
    process.exit(0);
  }
}
if (err) process.stderr.write(err);
process.stdout.write(out);
process.exit(exit);
`,
    { mode: 0o700 },
  );
  const suspendCount = async () =>
    (await readFile(rpcLog, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { method: string; phase: string })
      .filter((call) => call.method === "SuspendActor" && call.phase === "dispatch").length;
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
  const configFile = `${live.directory}/workspace-configuration.json`;
  await writeFile(configFile, JSON.stringify(configuration), { mode: 0o600 });
  Object.assign(process.env, ownedRuntimeConfiguration, {
    DATABASE_URL: target.url,
    KUBECONFIG: live.kubeconfig,
    FACTORY_KUBERNETES_CONTEXT: live.context,
    FACTORY_HOST: "127.0.0.1",
    FACTORY_PORT: String(port),
    FACTORY_BASE_URL: base,
    FACTORY_STATE_DIRECTORY: `${live.directory}/factory-state`,
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
  let startsObserved = 0;
  let servers: ReturnType<typeof startFactoryTransport> = [];
  let closeRelay: (() => Promise<void>) | undefined;
  let attemptID: string | undefined;
  const extraAttemptIDs: string[] = [];
  const pending: Promise<unknown>[] = [];
  const connections: Array<{ role: string; at: number }> = [];
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
    const sourceWrapper = `${sourceBinary}-owned-process`;
    await writeFile(
      sourceWrapper,
      `#!${process.execPath}
if (process.argv[2] === "source-host" && await Bun.file(${JSON.stringify(sourceFailureFile)}).exists()) {
  process.stderr.write("Owned Source service launch failure\\n");
  process.exit(1);
}
const child = Bun.spawn([${JSON.stringify(sourceBinary)}, ...process.argv.slice(2)], { stdin: "inherit", stdout: "inherit", stderr: "inherit" });
process.on("SIGTERM", () => child.kill("SIGTERM"));
process.exitCode = await child.exited;
`,
      { mode: 0o700 },
    );
    process.env["FACTORY_SOURCE_SERVICE_BINARY"] = sourceWrapper;
    application = await createFactoryApplication();
    const app = application;
    const start = app.runtimeController.start.bind(app.runtimeController);
    app.runtimeController.start = async (projectID, userID) => {
      startsObserved++;
      try {
        return await start(projectID, userID);
      } catch (error) {
        await writeFile(`${live.directory}/native-start-failure-${projectID}.log`, String(error), {
          mode: 0o600,
        });
        throw error;
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
    await Bun.$`mkdir -p ${repository}/.factory ${repository}/.devcontainer`.quiet();
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
    await writeFile(
      `${repository}/.devcontainer/devcontainer.json`,
      JSON.stringify({
        image:
          "node:24.22.3-alpine3.23@sha256:3946fb783fdce8a2812136ea694bc95c698c4f4096f3fd18568dc27a8ac389dc",
        remoteUser: "node",
        workspaceFolder: "/workspace/project",
        // biome-ignore lint/suspicious/noTemplateCurlyInString: The Dev Containers CLI resolves this variable.
        workspaceMount: "source=${localWorkspaceFolder},target=/workspace/project,type=bind",
        runArgs: ["--cap-drop=NET_RAW", "--cap-drop=SYS_PTRACE"],
        mounts: ["source=owned-native-home,target=/home/node,type=volume"],
        postCreateCommand: [
          "node",
          "-e",
          // Give early Source a deterministic observation window while the
          // actual Dev Container is still completing its normal setup hook.
          "setTimeout(()=>require('fs').appendFileSync('/home/node/owned-create-effects','once\\n'),5000)",
        ],
      }),
    );
    await writeFile(
      `${repository}/server.mjs`,
      "import http from 'node:http';import fs from 'node:fs';http.createServer((q,s)=>s.end(q.url==='/editor' ? fs.readFileSync('owned-editor.txt','utf8') : 'owned-native-ready')).listen(4300,'127.0.0.1');\n",
    );
    await writeFile(`${repository}/.gitignore`, "owned-private.txt\n");
    await Bun.$`git -C ${repository} init -b main`.quiet();
    await Bun.$`git -C ${repository} add .`.quiet();
    await Bun.$`git -C ${repository} -c user.name=Owned -c user.email=owned@example.invalid commit -m initial`.quiet();
    const revision = (await Bun.$`git -C ${repository} rev-parse HEAD`.text()).trim();
    await database.client.begin(async (sql) => {
      await sql`INSERT INTO factory.project(id,slug,name,repository_url,default_branch,devcontainer_path,created_by) VALUES(${projectID},${`native-${projectID}`},'Owned native Project',${`file://${repository}`},'main','.devcontainer/devcontainer.json',${userID})`;
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
    await expect(
      serverCall(callFactoryFunction(base, "ensurePersonalSource", [projectID], { cookie })),
    ).rejects.toThrow("Start this fresh native Workspace once to initialize Source");
    expect(await database.client`SELECT id FROM factory.development_workspace`).toHaveLength(0);
    const editor = createSubstrateControl(configuration.connection);
    await expect(
      editor("CreateAtespace", {
        atespace: { metadata: { name: `fa-${crypto.randomUUID().replaceAll("-", "")}` } },
      }),
    ).rejects.toBeInstanceOf(SubstrateRPCError);
    const wrong = createSubstrateControl({
      ...configuration.connection,
      tokenFile: live.wrongAudienceFile,
    });
    await expect(wrong("GetAtespace", { atespace: { name: ref.atespace } })).rejects.toBeInstanceOf(
      SubstrateRPCError,
    );
    const started = await serverCall(
      callFactoryFunction(
        base,
        "startPersonalWorkspace",
        [projectID],
        { cookie },
        AbortSignal.timeout(300_000),
      ),
    );
    expect(started.id).toBe(attemptID);
    expect(started.native?.state).toBe("ACTOR_STATE_RUNNING");
    const actor = nativeActor.parse(await editor("GetActor", { actor: ref }));
    expect(actor.status.workerAssignment?.sandboxRuntime).toEqual(live.runtime);
    const originalUID = actor.metadata.uid;
    const source = (operation: string, input: unknown, signal?: AbortSignal) =>
      fetch(`${base}/api/workspaces/${workspaceID}/source/${operation}`, {
        method: operation === "events" ? "GET" : "POST",
        headers: { cookie, origin: base, "content-type": "application/json" },
        ...(operation === "events" ? {} : { body: JSON.stringify(input) }),
        ...(signal ? { signal } : {}),
      });
    await eventually(
      async () => app.runtimeHub.sourceConnected(started.id),
      Boolean,
      "Initialized native Source remained blocked behind Dev Container setup",
      30_000,
    );
    expect(app.runtimeHub.ready(started.id)).toBe(false);
    const earlyRead = await source("read", { path: "server.mjs" });
    expect(earlyRead.status).toBe(200);
    expect(Buffer.from((await earlyRead.json()).content, "base64").toString()).toContain(
      "owned-native-ready",
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
      privateState = await terminal.evaluate(
        "const fs=require('fs');fs.writeFileSync('/tmp/owned-private-rootfs-state','retained rootfs');fs.writeFileSync('/home/node/owned-private-volume-state','retained volume');return {hostname:require('os').hostname(),rootfs:fs.readFileSync('/tmp/owned-private-rootfs-state','utf8'),volume:fs.readFileSync('/home/node/owned-private-volume-state','utf8'),createEffects:fs.readFileSync('/home/node/owned-create-effects','utf8')}",
      );
      expect(privateState?.createEffects).toBe("once\n");
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
      await database.client`SELECT atespace,policy,template,atespace_attempted_at,policy_attempted_at,template_attempted_at FROM factory.substrate_workspace WHERE workspace_id=${workspaceID}`;
    const paused = await app.runtimeController.pause(started.id);
    expect(paused?.state).toBe("paused");
    expect(paused?.native?.portable).toBe(false);
    expect(await denied({})).toBe(401);
    const [saved] =
      await database.client`SELECT checkpoint FROM factory.substrate_binding WHERE runtime_attempt_id=${started.id}`;
    expect(saved?.["checkpoint"].fidelity).toBe("SNAPSHOT_FIDELITY_ROOTFS");
    expect(saved?.["checkpoint"].durableSnapshot.state).toBe("SNAPSHOT_STORAGE_STATE_COMPLETED");
    const suspendedActor = nativeActor.parse(await editor("GetActor", { actor: ref }));
    expect(suspendedActor.status.state).toBe("ACTOR_STATE_SUSPENDED");
    expect((await source("read", { path: "owned-editor.txt" })).status).toBe(200);
    expect(nativeActor.parse(await editor("GetActor", { actor: ref })).status.state).toBe(
      "ACTOR_STATE_SUSPENDED",
    );
    const [sleepLease] =
      await database.client`SELECT owner,writer_epoch,generation,checkpoint FROM factory.substrate_source WHERE workspace_id=${workspaceID}`;
    expect(sleepLease?.["owner"]).toBe("service");
    expect(Number(sleepLease?.["generation"])).toBe(1);
    expect(sleepLease?.["checkpoint"].bundle.bytes).toBeGreaterThan(0);
    const offlineRead = await source("read", { path: "owned-editor.txt" });
    const offlineFile = await offlineRead.json();
    const offlineAbort = new AbortController();
    const offlineWatch = await source("events", undefined, offlineAbort.signal);
    expect(offlineWatch.status).toBe(200);
    const offlineReader = offlineWatch.body?.getReader();
    if (!offlineReader) throw new Error("Sleeping Source watch unavailable");
    const offlineObserved = (async () => {
      let text = "";
      for (;;) {
        const chunk = await offlineReader.read();
        if (chunk.done) throw new Error("Sleeping Source watch ended");
        text += new TextDecoder().decode(chunk.value);
        if (text.includes('"path":"owned-editor.txt"')) return;
      }
    })();
    const offlineDeadline = setTimeout(() => offlineAbort.abort(), 10_000);
    try {
      expect(
        (
          await source("write", {
            path: "owned-editor.txt",
            content: Buffer.from("offline-confirmed-editor").toString("base64"),
            version: offlineFile.version,
          })
        ).status,
      ).toBe(200);
      await offlineObserved;
    } finally {
      clearTimeout(offlineDeadline);
      offlineAbort.abort();
      await offlineReader.cancel().catch(() => {});
    }
    const offlineSearch = await source("search", { search: { query: "offline-confirmed-editor" } });
    expect(offlineSearch.status).toBe(200);
    expect(await offlineSearch.text()).toContain("owned-editor.txt");
    expect(nativeActor.parse(await editor("GetActor", { actor: ref })).status.state).toBe(
      "ACTOR_STATE_SUSPENDED",
    );
    expect((await app.workspaceSources.get(workspaceID, userID)).state).toBe("ready");
    expect(suspendedActor.metadata.uid).toBe(originalUID);
    expect(suspendedActor.status.snapshots).toContainEqual(
      expect.objectContaining(nativeSnapshot.parse(saved?.["checkpoint"])),
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
    extraAttemptIDs.push(runtimeIdentity(otherWorkspaceID, 1).attemptID);
    const otherAttempt = await serverCall(
      callFactoryFunction(
        base,
        "startPersonalWorkspace",
        [projectID],
        { cookie: otherCookie },
        AbortSignal.timeout(300_000),
      ),
    );
    expect(otherAttempt.id).not.toBe(started.id);
    await eventually(
      () => app.runtimeController.get(otherAttempt.id),
      (value) => value?.state === "ready" && app.runtimeHub.sourceConnected(otherAttempt.id),
      "Other personal Source did not become ready",
      180_000,
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
    expect(
      (await otherSource(otherWorkspaceID, "read", { path: "owned-private.txt" })).status,
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
    await serverCall(
      callFactoryFunction(base, "stopRuntimeAttempt", [otherAttempt.id], { cookie: otherCookie }),
    );
    expect((await app.runtimeController.get(otherAttempt.id))?.state).toBe("stopped");
    const resumeConnections = connections.length;
    const resumed = await serverCall(
      callFactoryFunction(
        base,
        "startPersonalWorkspace",
        [projectID],
        { cookie },
        AbortSignal.timeout(300_000),
      ),
    );
    expect(resumed.native?.actorUID).toBe(originalUID);
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
      "offline-confirmed-editor",
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
    ).toBe("offline-confirmed-editor");
    const [resumedLease] =
      await database.client`SELECT owner,writer_epoch,generation FROM factory.substrate_source WHERE workspace_id=${workspaceID}`;
    expect(resumedLease?.["owner"]).toBe("actor");
    expect(Number(resumedLease?.["generation"])).toBe(2);
    expect(Number(resumedLease?.["writer_epoch"])).toBeGreaterThan(
      Number(sleepLease?.["writer_epoch"]),
    );
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
          "const fs=require('fs');return {hostname:require('os').hostname(),rootfs:fs.readFileSync('/tmp/owned-private-rootfs-state','utf8'),volume:fs.readFileSync('/home/node/owned-private-volume-state','utf8'),createEffects:fs.readFileSync('/home/node/owned-create-effects','utf8')}",
        ),
      ).toEqual(privateState);
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
      await database.client`SELECT atespace,policy,template,atespace_attempted_at,policy_attempted_at,template_attempted_at FROM factory.substrate_workspace WHERE workspace_id=${workspaceID}`,
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
      expect(gitPause?.native?.sourceHandoff).toBe("confirmed-same-node");
      const archivedUpstream = await source("read", { path: "native-upstream.txt" });
      expect(archivedUpstream.status).toBe(200);
      expect(Buffer.from((await archivedUpstream.json()).content, "base64").toString()).toBe(
        "owned native upstream\n",
      );
    }
    const [beforeFinalStop] =
      await database.client`SELECT checkpoint FROM factory.substrate_binding WHERE runtime_attempt_id=${started.id}`;
    const suspendsBeforeStop = await suspendCount();
    await serverCall(callFactoryFunction(base, "stopRuntimeAttempt", [started.id], { cookie }));
    expect(await suspendCount()).toBe(suspendsBeforeStop);
    expect((await app.runtimeController.get(started.id))?.state).toBe("stopped");
    await expect(editor("GetActor", { actor: ref })).rejects.toMatchObject({ code: "NotFound" });
    const [retired] = await database.client`
      SELECT a.stop_intended_at,b.actor_uid,b.deleted_at,b.checkpoint
      FROM factory.runtime_attempt a JOIN factory.substrate_binding b ON b.runtime_attempt_id=a.id
      WHERE a.id=${started.id}`;
    expect(retired?.["stop_intended_at"]).not.toBeNull();
    expect(retired?.["actor_uid"]).toBe(originalUID);
    expect(retired?.["deleted_at"]).not.toBeNull();
    expect(retired?.["checkpoint"]).toEqual(beforeFinalStop?.["checkpoint"]);
    const stoppedFile = await (await source("read", { path: "owned-editor.txt" })).json();
    expect(
      (
        await source("write", {
          path: "owned-editor.txt",
          content: Buffer.from("saved-after-final-stop").toString("base64"),
          version: stoppedFile.version,
        })
      ).status,
    ).toBe(200);
    const successorID = runtimeIdentity(workspaceID, 2).attemptID;
    extraAttemptIDs.push(successorID);
    const successor = await serverCall(
      callFactoryFunction(
        base,
        "startPersonalWorkspace",
        [projectID],
        { cookie },
        AbortSignal.timeout(300_000),
      ),
    );
    expect(successor.id).toBe(successorID);
    expect(successor.native?.actorUID).not.toBe(originalUID);
    await eventually(
      () => app.runtimeController.get(successorID),
      (value) =>
        value?.state === "ready" &&
        app.runtimeHub.ready(successorID) &&
        app.runtimeHub.sourceConnected(successorID),
      "Successor Actor did not consume independent Source",
      180_000,
    );
    const successorTerminal = await ownedRuntimeTerminal(
      base,
      cookie,
      successorID,
      "native-successor",
    );
    try {
      expect(
        await successorTerminal.evaluate(
          "const fs=require('fs');const s=fs.statSync('owned-editor.txt');return {content:fs.readFileSync('owned-editor.txt','utf8'),uid:s.uid,gid:s.gid,privateFile:fs.readFileSync('owned-private.txt','utf8'),rootfs:fs.existsSync('/tmp/owned-private-rootfs-state'),volume:fs.existsSync('/home/node/owned-private-volume-state'),hooks:fs.readFileSync('/home/node/owned-create-effects','utf8')}",
        ),
      ).toEqual({
        content: "saved-after-final-stop",
        uid: 1000,
        gid: 1000,
        privateFile: privateSource,
        rootfs: false,
        volume: false,
        hooks: "once\n",
      });
    } finally {
      successorTerminal.close();
      await app.runtimeController.closeTerminal(successorID, "native-successor");
    }
    const [freshBinding] =
      await database.client`SELECT checkpoint FROM factory.substrate_binding WHERE runtime_attempt_id=${successorID}`;
    expect(freshBinding?.["checkpoint"]).toBeNull();
    const suspendsBeforeSuccessorStop = await suspendCount();
    await serverCall(callFactoryFunction(base, "stopRuntimeAttempt", [successorID], { cookie }));
    expect(await suspendCount()).toBe(suspendsBeforeSuccessorStop);
    expect((await app.runtimeController.get(successorID))?.state).toBe("stopped");
    const [finalBinding] =
      await database.client`SELECT checkpoint,deleted_at FROM factory.substrate_binding WHERE runtime_attempt_id=${successorID}`;
    expect(finalBinding?.["checkpoint"]).toBeNull();
    expect(finalBinding?.["deleted_at"]).not.toBeNull();
    // Hold only owned processes and replies. Native metadata and Factory
    // approval/lifecycle records continue through their normal commands.
    allowBackground = false;
    const interruptedID = runtimeIdentity(workspaceID, 3).attemptID;
    extraAttemptIDs.push(interruptedID);
    const interrupted = await serverCall(
      callFactoryFunction(
        base,
        "startPersonalWorkspace",
        [projectID],
        { cookie },
        AbortSignal.timeout(300_000),
      ),
    );
    expect(interrupted.id).toBe(interruptedID);
    await eventually(
      () => app.runtimeController.get(interruptedID),
      (value) =>
        value?.state === "ready" &&
        app.runtimeHub.ready(interruptedID) &&
        app.runtimeHub.sourceConnected(interruptedID),
      "Failure-probe Actor did not become ready",
      180_000,
    );
    const interruptedRef = {
      atespace: `fa-${interruptedID.replaceAll("-", "")}`,
      name: `runtime-${interruptedID.replaceAll("-", "")}`,
    };
    const interruptedActor = nativeActor.parse(await editor("GetActor", { actor: interruptedRef }));
    const sourceBeforeFailure = await (await source("read", { path: "owned-editor.txt" })).json();
    expect(Buffer.from(sourceBeforeFailure.content, "base64").toString()).toBe(
      "saved-after-final-stop",
    );
    await writeFile(sourceFailureFile, "owned launch failure", { mode: 0o600 });
    const suspendBeforeFailure = await suspendCount();
    await expect(
      serverCall(
        callFactoryFunction(
          base,
          "stopRuntimeAttempt",
          [interruptedID],
          { cookie },
          AbortSignal.timeout(60_000),
        ),
      ),
    ).rejects.toThrow("Independent Source process exited");
    const [blockedStop] = await database.client`
      SELECT a.state,a.stop_intended_at,b.delete_intended_at,b.deleted_at,b.checkpoint
      FROM factory.runtime_attempt a JOIN factory.substrate_binding b ON b.runtime_attempt_id=a.id
      WHERE a.id=${interruptedID}`;
    expect(blockedStop?.["state"]).toBe("stopping");
    expect(blockedStop?.["stop_intended_at"]).not.toBeNull();
    expect(blockedStop?.["delete_intended_at"]).toBeNull();
    expect(blockedStop?.["deleted_at"]).toBeNull();
    expect(blockedStop?.["checkpoint"]).toBeNull();
    expect(
      nativeActor.parse(await editor("GetActor", { actor: interruptedRef })).metadata.uid,
    ).toBe(interruptedActor.metadata.uid);
    expect(await suspendCount()).toBe(suspendBeforeFailure);
    await expect(
      serverCall(
        callFactoryFunction(
          base,
          "startPersonalWorkspace",
          [projectID],
          { cookie },
          AbortSignal.timeout(30_000),
        ),
      ),
    ).rejects.toThrow();
    await rm(sourceFailureFile);
    await writeFile(deleteFaultFile, JSON.stringify({ name: interruptedRef.name }), {
      mode: 0o600,
    });
    const stopping = serverCall(
      callFactoryFunction(
        base,
        "stopRuntimeAttempt",
        [interruptedID],
        { cookie },
        AbortSignal.timeout(120_000),
      ),
    ).then(
      () => "unexpected success",
      (error) => String(error),
    );
    pending.push(stopping);
    await eventually(
      () => Bun.file(deleteHeldFile).exists(),
      (value) => value,
      "Original UID-bound Delete did not reach the owned lost-reply probe",
      60_000,
    );
    const beforeRacingStart = startsObserved;
    const racingStart = serverCall(
      callFactoryFunction(
        base,
        "startPersonalWorkspace",
        [projectID],
        { cookie },
        AbortSignal.timeout(60_000),
      ),
    ).then(
      () => "unexpected restart",
      (error) => String(error),
    );
    pending.push(racingStart);
    await eventually(
      async () => startsObserved,
      (value) => value > beforeRacingStart,
      "Authenticated concurrent Start did not enter the lifecycle owner",
      10_000,
    );
    await writeFile(deleteReleaseFile, "release owned response", { mode: 0o600 });
    expect(await stopping).not.toBe("unexpected success");
    expect(await racingStart).not.toBe("unexpected restart");
    expect(
      await readFile(`${live.directory}/native-start-failure-${projectID}.log`, "utf8"),
    ).toContain("retired");
    const [lostStop] = await database.client`
      SELECT a.state,b.deleted_at FROM factory.runtime_attempt a
      JOIN factory.substrate_binding b ON b.runtime_attempt_id=a.id WHERE a.id=${interruptedID}`;
    expect(lostStop?.["state"]).toBe("stopping");
    expect(lostStop?.["deleted_at"]).toBeNull();
    await expect(editor("GetActor", { actor: interruptedRef })).rejects.toMatchObject({
      code: "NotFound",
    });
    const recovered = await app.runtimeController.recover();
    recovered();
    await eventually(
      async () => {
        const [row] =
          await database.client`SELECT state FROM factory.runtime_attempt WHERE id=${interruptedID}`;
        return row?.["state"];
      },
      (value) => value === "stopped",
      "Startup recovery did not complete the original lost Delete",
      30_000,
    );
    expect((await app.runtimeController.get(interruptedID))?.native?.state).toBe("deleted");
    const [recoveredStop] = await database.client`
      SELECT a.stop_intended_at,b.actor_uid,b.delete_intended_at,b.deleted_at,b.checkpoint
      FROM factory.runtime_attempt a JOIN factory.substrate_binding b ON b.runtime_attempt_id=a.id
      WHERE a.id=${interruptedID}`;
    expect(recoveredStop?.["stop_intended_at"]).toEqual(blockedStop?.["stop_intended_at"]);
    expect(recoveredStop?.["actor_uid"]).toBe(interruptedActor.metadata.uid);
    expect(recoveredStop?.["deleted_at"]).not.toBeNull();
    expect(recoveredStop?.["checkpoint"]).toBeNull();
    expect(await suspendCount()).toBe(suspendBeforeFailure);
    const calls = (await readFile(rpcLog, "utf8"))
      .trim()
      .split("\n")
      .map(
        (line) =>
          JSON.parse(line) as {
            method: string;
            name: string;
            phase: string;
            uid?: string;
            version?: string;
          },
      );
    const dispatchedDeletes = calls.filter(
      (call) =>
        call.name === interruptedRef.name &&
        call.phase === "dispatch" &&
        call.method === "DeleteActor",
    );
    expect(dispatchedDeletes).toHaveLength(1);
    expect(dispatchedDeletes[0]?.uid).toBe(interruptedActor.metadata.uid);
    expect(dispatchedDeletes[0]?.version).toMatch(/^[1-9][0-9]*$/);
    expect(
      calls.filter((call) => call.name === interruptedRef.name && call.phase === "lost-reply"),
    ).toHaveLength(1);
    expect(
      calls.filter(
        (call) =>
          call.name === interruptedRef.name &&
          call.phase === "dispatch" &&
          call.method === "ResumeActor",
      ),
    ).toHaveLength(1);
    const retainedSource = await source("read", { path: "owned-editor.txt" });
    expect(retainedSource.status).toBe(200);
    expect(Buffer.from((await retainedSource.json()).content, "base64").toString()).toBe(
      "saved-after-final-stop",
    );
    const generations =
      await database.client`SELECT generation FROM factory.runtime_attempt WHERE workspace_id=${workspaceID} ORDER BY generation`;
    expect(generations.map((row) => Number(row["generation"]))).toEqual([1, 2, 3]);
    const pausedStopID = runtimeIdentity(workspaceID, 4).attemptID;
    extraAttemptIDs.push(pausedStopID);
    const pausedStart = await serverCall(
      callFactoryFunction(
        base,
        "startPersonalWorkspace",
        [projectID],
        { cookie },
        AbortSignal.timeout(300_000),
      ),
    );
    expect(pausedStart.id).toBe(pausedStopID);
    await eventually(
      () => app.runtimeController.get(pausedStopID),
      (value) =>
        value?.state === "ready" &&
        app.runtimeHub.ready(pausedStopID) &&
        app.runtimeHub.sourceConnected(pausedStopID),
      "Paused-Stop successor did not become ready",
      180_000,
    );
    const pausedForStop = await app.runtimeController.pause(pausedStopID);
    expect(pausedForStop?.state).toBe("paused");
    const [pausedBinding] =
      await database.client`SELECT checkpoint FROM factory.substrate_binding WHERE runtime_attempt_id=${pausedStopID}`;
    expect(pausedBinding?.["checkpoint"].fidelity).toBe("SNAPSHOT_FIDELITY_ROOTFS");
    const pausedFile = await (await source("read", { path: "owned-editor.txt" })).json();
    expect(
      (
        await source("write", {
          path: "owned-editor.txt",
          content: Buffer.from("saved-during-final-pause").toString("base64"),
          version: pausedFile.version,
        })
      ).status,
    ).toBe(200);
    const pausedRef = {
      atespace: `fa-${pausedStopID.replaceAll("-", "")}`,
      name: `runtime-${pausedStopID.replaceAll("-", "")}`,
    };
    expect(nativeActor.parse(await editor("GetActor", { actor: pausedRef })).status.state).toBe(
      "ACTOR_STATE_SUSPENDED",
    );
    const suspendsBeforePausedStop = await suspendCount();
    await serverCall(callFactoryFunction(base, "stopRuntimeAttempt", [pausedStopID], { cookie }));
    expect(await suspendCount()).toBe(suspendsBeforePausedStop);
    const [pausedStoppedBinding] =
      await database.client`SELECT checkpoint,deleted_at FROM factory.substrate_binding WHERE runtime_attempt_id=${pausedStopID}`;
    expect(pausedStoppedBinding?.["checkpoint"]).toEqual(pausedBinding?.["checkpoint"]);
    expect(pausedStoppedBinding?.["deleted_at"]).not.toBeNull();
    await expect(editor("GetActor", { actor: pausedRef })).rejects.toMatchObject({
      code: "NotFound",
    });
    const pausedStoppedFile = await source("read", { path: "owned-editor.txt" });
    expect(pausedStoppedFile.status).toBe(200);
    expect(Buffer.from((await pausedStoppedFile.json()).content, "base64").toString()).toBe(
      "saved-during-final-pause",
    );
    await writeFile(
      `${live.directory}/lifecycle-evidence-${projectID}.json`,
      JSON.stringify(
        {
          projectID,
          workspaceID,
          originalUID,
          successorID,
          interruptedID,
          pausedStopID,
          qualification: live.qualification,
          workloadImage: live.workloadImage,
          runtime: live.runtime,
          rpcLog,
          sourceFailureStop: blockedStop,
          recoveredStop,
          checks: [
            "ROOTFS Pause/Resume",
            "offline dirty and ignored Source",
            "final Stop without Suspend",
            "fresh Docker generation",
            "failed independent Source retains Actor",
            "concurrent Start fenced",
            "lost Delete reply",
            "startup cleanup recovery",
            "paused final Stop preserves offline edits without another snapshot",
          ],
        },
        null,
        2,
      ),
      { mode: 0o600 },
    );
  } catch (error) {
    failure = error;
    await writeFile(`${live.directory}/native-workspace-failure-${projectID}.log`, String(error), {
      mode: 0o600,
    });
  } finally {
    await writeFile(deleteReleaseFile, "release owned response", { mode: 0o600 });
    await rm(sourceFailureFile, { force: true });
    await Promise.allSettled(pending);
    for (const id of extraAttemptIDs)
      await application?.runtimeController.stop(id).catch(() => undefined);
    if (attemptID && application)
      await application.runtimeController.stop(attemptID).catch(() => undefined);
    for (const server of servers) await server.stop(true);
    await closeRelay?.();
    ingress.close();
    await closeBackground?.();
    await application?.workspaceSources.close();
    let cleanupFailure: unknown;
    async function cleanupOwnedScopes() {
      const ownedNames = new Set(
        [attemptID, ...extraAttemptIDs]
          .filter(Boolean)
          .map((id) => `fa-${id?.replaceAll("-", "")}`),
      );
      const scopes =
        await database.client`SELECT atespace,atespace_attempted_at,template,template_attempted_at FROM factory.substrate_workspace`;
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
    if (attemptID) await removeRuntimeRepository(attemptID);
    for (const id of extraAttemptIDs) await removeRuntimeRepository(id);
    for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key];
    Object.assign(process.env, previous);
    if (cleanupFailure) {
      console.error(
        "Owned PostgreSQL, Source and S3 qualification data retained because native cleanup is unconfirmed",
      );
      failure ??= cleanupFailure;
    } else {
      await target.dispose();
      await owner.dispose();
      await objectStore.dispose();
    }
  }
  if (failure) throw failure;
}, 1_200_000);
