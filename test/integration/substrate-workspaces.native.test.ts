import { expect, test } from "bun:test";
import { readFile, writeFile } from "node:fs/promises";
import { createConnection } from "node:net";
import { createServer } from "node:tls";
import { z } from "zod";
import { removeRuntimeRepository } from "../../apps/factory/src/runtime/git-http";
import type { SubstrateWorkspaceConfiguration } from "../../apps/factory/src/runtime/substrate-workspaces";
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
  runtime: nativeRuntime,
});

test("fresh Workspace through authenticated FactoryApplication command: native provisioning, real checkout, parent/child readiness and cold lifecycle", async () => {
  const file = process.env["FACTORY_SUBSTRATE_WORKSPACES_NATIVE_FIXTURE"];
  if (!file) throw new Error("Explicit owned FACTORY_SUBSTRATE_WORKSPACES_NATIVE_FIXTURE required");
  const live = liveSchema.parse(await Bun.file(file).json());
  const owner = await ownedPostgresServer();
  const target = await ownedTestDatabase(owner.identity, crypto.randomUUID());
  const previous = { ...process.env };
  const objectStore = await ownedAttachmentS3();
  const projectID = crypto.randomUUID();
  const reserve = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
  const port = reserve.port;
  if (!port) throw new Error("Owned Factory listener address missing");
  await reserve.stop(true);
  const base = `http://127.0.0.1:${port}`;
  const configuration: SubstrateWorkspaceConfiguration = {
    deployment: "owned-test",
    database: new URL(target.url).pathname.slice(1),
    projectID,
    connection: {
      bridge: live.bridge,
      endpoint: live.endpoint,
      serverName: "api.ate-system.svc",
      caFile: live.caFile,
      tokenFile: live.tokenFile,
    },
    provisioner: {
      bridge: live.bridge,
      endpoint: live.endpoint,
      serverName: "api.ate-system.svc",
      caFile: live.caFile,
      tokenFile: live.provisionerTokenFile,
    },
    editorPrincipal: `user:system:serviceaccount:${live.owner}:factory-substrate-control`,
    connectorURL: `wss://${live.factoryHostname}/internal/runtime-connect`,
    factoryCAFile: live.certFile,
    workloadImage: live.workloadImage,
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
    FACTORY_EXECUTION_RESERVE_TARGET: "0",
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
  let servers: ReturnType<typeof startFactoryTransport> = [];
  let closeRelay: (() => Promise<void>) | undefined;
  let attemptID: string | undefined;
  const extraAttemptIDs: string[] = [];
  const connections: Array<{ role: string; at: number }> = [];
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
  await new Promise<void>((resolve, reject) => {
    ingress.once("error", reject);
    ingress.listen(0, "127.0.0.1", resolve);
  });
  const address = ingress.address();
  if (!address || typeof address === "string") throw new Error("Owned ingress address missing");
  try {
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
    const start = app.runtimeController.start.bind(app.runtimeController);
    app.runtimeController.start = async (projectID, userID) => {
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
    closeBackground = startFactoryLifecycle(app);
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
          "node:24.21.0-alpine3.23@sha256:9ec4a2e289874ed0d722e1772ec2de45d2801541db8612f3638b26f128c69ac2",
        remoteUser: "node",
        workspaceFolder: "/workspace/project",
        workspaceMount: "source=${localWorkspaceFolder},target=/workspace/project,type=bind",
        runArgs: ["--cap-drop=NET_RAW", "--cap-drop=SYS_PTRACE"],
        mounts: ["source=owned-native-home,target=/home/node,type=volume"],
        postCreateCommand: [
          "node",
          "-e",
          "require('fs').appendFileSync('/home/node/owned-create-effects','once\\n')",
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
    const source = (operation: string, input: unknown, signal?: AbortSignal) =>
      fetch(`${base}/api/workspaces/${workspaceID}/source/${operation}`, {
        method: operation === "events" ? "GET" : "POST",
        headers: { cookie, origin: base, "content-type": "application/json" },
        ...(operation === "events" ? {} : { body: JSON.stringify(input) }),
        ...(signal ? { signal } : {}),
      });
    const sourceView = await app.workspaceSources.ensurePersonal(projectID, userID);
    expect(sourceView.state).toBe("ready");
    expect(sourceView.workspaceID).toBe(workspaceID);
    expect(await database.client`SELECT workspace_id FROM factory.workspace_source`).toHaveLength(
      0,
    );
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
    expect(await database.client`SELECT id FROM factory.factorybox_worker`).toHaveLength(0);
    expect(
      await database.client`SELECT atespace,policy,template,atespace_attempted_at,policy_attempted_at,template_attempted_at FROM factory.substrate_workspace WHERE workspace_id=${workspaceID}`,
    ).toEqual(originalProvision);
    expect(
      await database.client`SELECT id FROM factory.runtime_attempt WHERE workspace_id=${workspaceID}`,
    ).toHaveLength(1);
    expect(await database.client`SELECT id FROM factory.runtime_attempt`).toHaveLength(2);
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
    await expect(
      app.runtimeHub.parentOperation(started.id, {
        ...integration,
        operationId: crypto.randomUUID(),
        repositoryUrl: `https://${live.factoryHostname}${remote.prefix}/redirect.git`,
      }),
    ).rejects.toThrow("integration source could not be fetched");
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
    await expect(
      app.runtimeHub.parentOperation(started.id, {
        ...push,
        operationId: crypto.randomUUID(),
        repositoryUrl: `https://${live.factoryHostname}${remote.prefix}/redirect.git`,
      }),
    ).rejects.toThrow("remote branch could not be observed");
    expect(remote.observations.redirects).toBeGreaterThan(redirectsBeforePush);
    expect(remote.observations.authenticated).toBe(authenticatedBeforeRedirect);
    expect(remote.observations.pushes).toBe(0);
    expect((await app.runtimeHub.parentOperation(started.id, push)).remoteSHA).toBe(integratedSHA);
    const pushed = remote.observations.pushes;
    expect(pushed).toBe(1);
    expect((await app.runtimeHub.parentOperation(started.id, push)).remoteSHA).toBe(integratedSHA);
    expect(remote.observations.pushes).toBe(pushed);
    expect(remote.observations.authenticated).toBeGreaterThan(0);
    const gitPause = await app.runtimeController.pause(started.id);
    expect(gitPause?.native?.sourceHandoff).toBe("confirmed-same-node");
    const archivedUpstream = await source("read", { path: "native-upstream.txt" });
    expect(archivedUpstream.status).toBe(200);
    expect(Buffer.from((await archivedUpstream.json()).content, "base64").toString()).toBe(
      "owned native upstream\n",
    );
    await serverCall(callFactoryFunction(base, "stopRuntimeAttempt", [started.id], { cookie }));
    expect((await app.runtimeController.get(started.id))?.state).toBe("stopped");
  } finally {
    for (const id of extraAttemptIDs)
      await application?.runtimeController.stop(id).catch(() => undefined);
    if (attemptID && application)
      await application.runtimeController.stop(attemptID).catch(() => undefined);
    for (const server of servers) await server.stop(true);
    await closeRelay?.();
    ingress.close();
    await closeBackground?.();
    await application?.database.client.end({ timeout: 1 });
    await database.client.end({ timeout: 1 });
    if (attemptID) await removeRuntimeRepository(attemptID);
    for (const id of extraAttemptIDs) await removeRuntimeRepository(id);
    for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key];
    Object.assign(process.env, previous);
    await target.dispose();
    await owner.dispose();
    await objectStore.dispose();
  }
}, 600_000);
