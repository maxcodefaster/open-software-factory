import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createDeliveryController } from "../../apps/factory/src/delivery/controller";
import { createRuntimeEnvironmentEndpoint } from "../../apps/factory/src/environments/runtime";
import { createRuntimeController } from "../../apps/factory/src/runtime/controller";
import { createFactoryboxExecution } from "../../apps/factory/src/runtime/factorybox";
import { RuntimeHub, type RuntimeSocketData } from "../../apps/factory/src/runtime/hub";
import { createInternalProtocol } from "../../apps/factory/src/server/protocols/internal";
import { createPersonalGit } from "../../apps/factory/src/workspace/personal-git";
import { createWorkspaceSourceController } from "../../apps/factory/src/workspace/source-controller";
import { createForgejoClient } from "../../packages/forge/src/forge";
import { canonicalRequirementContent } from "../../packages/requirement-domain/src/requirement";
import { hashConnectorToken } from "../../packages/runtime-domain/src/identity";
import { runFactoryboxKubernetes } from "../../packages/runtime-kubernetes/src/factorybox-worker";
import { eventually, factoryProcess } from "../fixtures/factory-process";
import {
  factoryboxFixtureCommand,
  readFactoryboxFixtureTarget,
} from "../fixtures/factorybox-runtime";
import { ownedMonitoringForge } from "../fixtures/monitoring-native";
import { ownedPostgresServer } from "../fixtures/postgres-server";
import { verificationPoolCluster } from "../fixtures/verification-pool-cluster";
import { verificationPoolRegistry } from "../fixtures/verification-pool-registry";
import { verificationPoolTransport } from "../fixtures/verification-pool-transport";

// Explicit native lane. No injected scheduler, runtime observations, admission calls or verdicts.
test("owned Development on A overlaps exact-commit Forgejo Verification on B", async () => {
  const id =
    process.env["FACTORY_VERIFICATION_NATIVE_ID"] ??
    `verification-native-${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`;
  const evidence = resolve(".factory/test-results", id);
  await mkdir(evidence, { recursive: true });
  await writeFile(resolve(evidence, "native-owner"), id, { flag: "wx" });
  const record = async (name: string, value: unknown) =>
    writeFile(resolve(evidence, `${name}.json`), JSON.stringify(value, null, 2));
  const environment = { ...process.env };
  const cluster = await verificationPoolCluster(id, evidence);
  let registry: Awaited<ReturnType<typeof verificationPoolRegistry>> | undefined;
  let relay: Awaited<ReturnType<typeof verificationPoolTransport>> | undefined;
  let forge: Awaited<ReturnType<typeof ownedMonitoringForge>> | undefined;
  let postgres: Awaited<ReturnType<typeof ownedPostgresServer>> | undefined;
  let host: Awaited<ReturnType<typeof factoryProcess>> | undefined;
  let database: ReturnType<NonNullable<typeof host>["connect"]> | undefined;
  let sources: ReturnType<typeof createWorkspaceSourceController> | undefined;
  let control: Bun.Server<RuntimeSocketData> | undefined;
  const attempts: string[] = [];
  let runtime: ReturnType<typeof createRuntimeController> | undefined;
  let delivery: ReturnType<typeof createDeliveryController> | undefined;
  let passed = false;
  let failuresPassed = false;
  try {
    relay = await verificationPoolTransport(id, cluster.privateDirectory, evidence);
    registry = await verificationPoolRegistry(relay.ip, cluster.privateDirectory);
    const registryForward = await relay.attach(registry.base, 5000);
    const registryHost = new URL(registryForward.base).host;
    await cluster.start(registryHost, registry.certificate);
    process.env["KUBECONFIG"] = cluster.kubeconfig;
    delete process.env["FACTORY_KUBERNETES_CONTEXT"];
    forge = await ownedMonitoringForge(cluster.privateDirectory, crypto.randomUUID(), id);
    await record("forge-ownership", {
      container: forge.container,
      owner: forge.owner,
      origin: forge.origin,
    });
    const forgeForward = await relay.attach(forge.origin, 3000);
    const image = (name: string, digest: string) =>
      `${registryHost}/open-factory/${name}@sha256:${digest}`;
    Object.assign(process.env, {
      FACTORY_FACTORYBOX_WORKER_IMAGE:
        "ghcr.io/maxcodefaster/factorybox-worker@sha256:e3e8c0e763ed3522cdb490954648cccb2855e03a9afd1e0de999ce9d0f905e72",
      FACTORY_FACTORYBOX_EXECUTABLE_SHA256:
        "3328eff7c972616c37c8b12ed55f49077de53f1caba5da60c4e1aea4ea702e6b",
      FACTORY_FACTORYBOX_NODE: cluster.nodeA,
      FACTORY_FACTORYBOX_ARCHITECTURE: "amd64",
      FACTORY_FACTORYBOX_KERNEL: "*",
      FACTORY_FACTORYBOX_BOUNDED_BYTES: String(8 * 1024 ** 3),
      FACTORY_FACTORYBOX_CLAIM_GIB: "32",
      FACTORY_FACTORYBOX_CPU_REQUEST_MILLI: "100",
      FACTORY_FACTORYBOX_MEMORY_HEADROOM_MIB: "768",
      FACTORY_RUNTIME_HOST_IMAGE: image(
        "runtime-host",
        "193f66058975e51ecac980164b2c239b9e89e57009403d1ed38d5f60b37514e3",
      ),
      FACTORY_WORKSPACE_FILES_IMAGE: image(
        "workspace-files",
        "05f749a1292573136cd08551a7daf0c0be093ed24748dc66080556e2104f58ac",
      ),
      FACTORY_BROWSER_TOOLS_IMAGE: image(
        "browser-tools",
        "e62eee6fd56605ffb413c9eb79186f91a2abf3eb157396eb5fb6021231425e52",
      ),
      FACTORY_FORGEJO_API_URL: `${forgeForward.base}/api/v1/`,
      FACTORY_FORGEJO_TOKEN: forge.token,
      FACTORY_FORGEJO_OWNER: forge.owner,
      FACTORY_RUNTIME_HOST: cluster.gateway,
      FACTORY_AUTH_SECRET: crypto.randomUUID(),
      FACTORY_EXECUTION_RESERVE_TARGET: "0",
    });
    postgres = await ownedPostgresServer();
    process.env["FACTORY_TEST_POSTGRES"] = JSON.stringify(postgres.identity);
    host = await factoryProcess();
    database = host.connect();
    const db = database;
    await record("database-ownership", {
      postgresOwner: postgres.identity.owner,
      fixtureID: host.id,
    });
    const secret = process.env["FACTORY_AUTH_SECRET"]!;
    const hub = new RuntimeHub((attemptID, phase, error) =>
      runtime!.status(attemptID, phase, error),
    );
    sources = createWorkspaceSourceController(db, secret);
    const runtimeEnvironmentEndpoint = createRuntimeEnvironmentEndpoint(db, {
      configured: false,
      async read() {
        throw new Error("This fixture has no secret bundle");
      },
      async create() {
        throw new Error("No secret write is authorized");
      },
    });
    let internal: ReturnType<typeof createInternalProtocol>;
    const gate = Promise.withResolvers<void>();
    let jobEntered = Promise.withResolvers<{ head: string; started: number }>();
    let activeJobGate = gate;
    let corruptCommit: string | undefined;
    let sourceCorrupted = false;
    const jobEvents: unknown[] = [];
    control = Bun.serve<RuntimeSocketData>({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request, server) {
        const path = new URL(request.url).pathname;
        if (path === `/owned/${id}/overlap` && request.method === "POST") {
          const value = (await request.json()) as { head: string; started: number };
          jobEvents.push(value);
          jobEntered.resolve(value);
          await activeJobGate.promise;
          return Response.json({ released: true });
        }
        if (path === "/internal/runtime-connect") {
          const data = hub.authorize(request, hashConnectorToken);
          if (!data) return new Response(null, { status: 401 });
          if (
            server.upgrade(request, {
              data,
              headers: { "sec-websocket-protocol": RuntimeHub.protocol() },
            })
          )
            return;
          return new Response(null, { status: 400 });
        }
        const response = await internal(request);
        if (
          corruptCommit &&
          request.method === "POST" &&
          path.includes("/internal/runtime-source/") &&
          path.endsWith("/git-upload-pack") &&
          response.ok
        ) {
          const attemptID = path.split("/")[3];
          const [bound] =
            await db.client`SELECT id FROM factory.runtime_attempt WHERE id=${attemptID ?? null} AND isolated_kind='verification' AND revision=${corruptCommit}`;
          if (bound) {
            const bytes = Buffer.from(await response.arrayBuffer());
            const pack = bytes.indexOf("PACK");
            if (pack >= 0 && bytes.length > pack + 12) {
              bytes[pack + 12] = (bytes[pack + 12] ?? 0) ^ 0x80;
              sourceCorrupted = true;
              await record("source-corruption-boundary", {
                attemptID,
                requestedCommit: corruptCommit,
                corruptionOffset: pack + 12,
                originalProductResponseStatus: response.status,
              });
            }
            const headers = new Headers(response.headers);
            headers.delete("content-length");
            return new Response(bytes, { status: response.status, headers });
          }
        }
        return response;
      },
      websocket: {
        open: (socket) => hub.open(socket),
        message: (socket, message) => hub.message(socket, message),
        close: (socket) => hub.close(socket),
      },
    });
    const base = `http://127.0.0.1:${control.port}`;
    const callback = await relay.attach(base, 8000);
    process.env["FACTORY_BASE_URL"] = base;
    process.env["FACTORY_INTERNAL_URL"] = callback.base;
    // Forgejo has a different loopback port, so runtime host translation points to its exact forward.
    process.env["FACTORY_FORGEJO_PUBLIC_URL"] = forge.origin;
    const transportEvents: Array<{
      at: number;
      kind: string;
      pod: string;
      namespace: string;
      sandboxID: string;
      action: string;
    }> = [];
    let lostCreateAcknowledgment = false;
    let identityFault: "pod" | "claim" | "boot" | "epoch" | "store" | undefined;
    let identityFaultApplied = false;
    let remoteNamespace = "";
    const transport: typeof runFactoryboxKubernetes = async (args, input, limits) => {
      const native = args.includes("/opt/factorybox/factorybox") && args.includes("start");
      if (native)
        transportEvents.push({
          at: Date.now(),
          kind: "native-start",
          pod: args[1] ?? "",
          namespace: args[args.indexOf("-n") + 1] ?? "",
          sandboxID: args.at(-1) ?? "",
          action: "start",
        });
      if (native)
        await record(`pre-start-${transportEvents.length}`, {
          at: Date.now(),
          workers:
            await db.client`SELECT id,singleton,node_name,node_identity,namespace_uid,pod_uid,claim_uid,identity FROM factory.factorybox_worker`,
          runtimes:
            await db.client`SELECT runtime_attempt_id,identity FROM factory.factorybox_runtime`,
          artifacts: await db.client`SELECT * FROM factory.runtime_artifact_intent`,
          verificationJobs:
            await db.client`SELECT id,commit_sha,action_run_id,runner_job_handle FROM factory.verification`,
        });
      const result = await runFactoryboxKubernetes(args, input, limits);
      // Faults corrupt an actual transport read; no runtime or scheduler outcome is replaced.
      if (identityFault && result.exitCode === 0) {
        const field = identityFault;
        const match =
          ((field === "pod" || field === "claim") &&
            args[0] === "get" &&
            args.includes(remoteNamespace) &&
            args[1] === (field === "pod" ? "pod" : "pvc")) ||
          (field === "boot" && args[0] === "get" && args.includes(cluster.nodeB)) ||
          ((field === "epoch" || field === "store") &&
            args.includes("worker-status") &&
            args.includes(remoteNamespace));
        if (match) {
          const value = JSON.parse(result.stdout);
          if (field === "pod" || field === "claim") value.metadata.uid = crypto.randomUUID();
          else if (field === "boot") value.status.nodeInfo.bootID = crypto.randomUUID();
          else
            value[field === "epoch" ? "epoch" : "store_id"] = crypto
              .randomUUID()
              .replaceAll("-", "");
          identityFaultApplied = true;
          return { ...result, stdout: JSON.stringify(value) };
        }
      }
      if (native && !lostCreateAcknowledgment) {
        const [binding] = await db.client<
          { remote: boolean }[]
        >`SELECT NOT worker.singleton AS remote
          FROM factory.runtime_attempt attempt JOIN factory.factorybox_worker worker ON worker.id=attempt.factorybox_worker_id
          WHERE 'runtime-'||replace(attempt.id::text,'-','')=${args.at(-1) ?? ""}`;
        if (binding?.remote && result.exitCode === 0) {
          lostCreateAcknowledgment = true;
          await record("lost-create-acknowledgment", {
            dispatchedAt: Date.now(),
            sandboxID: args.at(-1),
            exitCodeBeforeLoss: result.exitCode,
            operations:
              await db.client`SELECT runtime_attempt_id,action,attempted_at,completed_at FROM factory.factorybox_lifecycle_operation WHERE action='start'`,
          });
          throw new Error(
            "Owned transport discarded the actual successful native Start acknowledgement",
          );
        }
      }
      return result;
    };
    const execution = createFactoryboxExecution(db, hub, transport);
    runtime = createRuntimeController(
      db,
      hub,
      secret,
      sources,
      undefined,
      async () => registry!.certificate,
      undefined,
      execution,
    );
    // Use the current product's internal protocol, including authorization and upload-pack-only Git.
    const unavailable = async () => new Response(null, { status: 404 });
    internal = createInternalProtocol({
      database: db,
      workspaceSources: sources,
      runtimeEnvironmentEndpoint,
      factoryOrigin: base,
      buildBrowserEndpoint: unavailable,
      mcpSourceEndpoint: unavailable,
      relayModel: unavailable,
      projectPreparation: { endpoint: unavailable },
      releaseController: { credentials: unavailable },
    } as unknown as Parameters<typeof createInternalProtocol>[0]);
    const repoName = id;
    await forge.api("user/repos", "POST", { name: repoName, private: true });
    const repositoryURL = `${forgeForward.base}/${forge.owner}/${repoName}.git`;
    const repository = { owner: forge.owner, name: repoName };
    const checkout = resolve(evidence, "submitted-repository");
    await cp(resolve("test/fixtures/runtime-project"), checkout, { recursive: true });
    const workflow = resolve(checkout, ".forgejo/workflows/factory-verification.yml");
    await writeFile(
      workflow,
      `${await readFile(workflow, "utf8")}      - name: Owned concurrent product probe\n        run: |\n          node -e 'const fs=require("fs");fetch(${JSON.stringify(`${callback.base}/owned/${id}/overlap`)},{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({head:fs.readFileSync("/workspace/project/.git/HEAD","utf8").trim(),started:Date.now()})}).then(r=>{if(!r.ok)process.exit(1)})'\n`,
    );
    const gitEnvironment = {
      ...process.env,
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "http.extraHeader",
      GIT_CONFIG_VALUE_0: `Authorization: Basic ${Buffer.from(`factory:${forge.token}`).toString("base64")}`,
    };
    async function git(args: string[]) {
      const child = Bun.spawn(["git", "-C", checkout, ...args], {
        env: gitEnvironment,
        stdout: "pipe",
        stderr: "ignore",
      });
      const output = await new Response(child.stdout).text();
      if (await child.exited)
        throw new Error("Owned fixture Git operation failed; private diagnostics suppressed");
      return output.trim();
    }
    for (const args of [
      ["init", "-b", "main"],
      ["add", "."],
      [
        "-c",
        "user.name=Owned acceptance",
        "-c",
        "user.email=acceptance@factory.invalid",
        "commit",
        "-m",
        "Owned protected runtime fixture",
      ],
      ["remote", "add", "origin", repositoryURL],
      ["push", "origin", "main"],
    ])
      await git(args);
    const baseSHA = await git(["rev-parse", "HEAD"]);
    const userID = crypto.randomUUID();
    const projectID = crypto.randomUUID();
    const ticketID = crypto.randomUUID();
    const revisionID = crypto.randomUUID();
    const approvalID = crypto.randomUUID();
    const changeID = crypto.randomUUID();
    const branch = `factory/change-${changeID.replaceAll("-", "").slice(0, 12)}`;
    const content = canonicalRequirementContent({
      summary: "Owned exact-commit Verification acceptance",
      acceptanceCriteria: ["Project checks run concurrently with useful Development"],
      nonGoals: ["Delivery or model inference"],
    });
    await db.client.begin(async (sql) => {
      await sql`INSERT INTO auth."user"(id,name,email,email_verified) VALUES(${userID},'Owned acceptance developer',${`${id}@factory.invalid`},true)`;
      await sql`INSERT INTO factory.administrator(user_id) VALUES(${userID})`;
      await sql`INSERT INTO factory.project(id,slug,name,repository_url,default_branch,devcontainer_path,created_by) VALUES(${projectID},${id},'Owned Verification acceptance',${repositoryURL},'main','.devcontainer/devcontainer.json',${userID})`;
      await sql`INSERT INTO factory.project_membership(project_id,user_id,role,updated_by) VALUES(${projectID},${userID},'developer',${userID})`;
      await sql`INSERT INTO factory.ticket(id,project_id,title,created_by) VALUES(${ticketID},${projectID},'Owned acceptance',${userID})`;
      await sql`INSERT INTO factory.requirement_revision(id,ticket_id,ordinal,canonical_content,content_digest,created_by) VALUES(${revisionID},${ticketID},1,${content},${createHash("sha256").update(content).digest("hex")},${userID})`;
      await sql`INSERT INTO factory.requirement_approval(id,ticket_id,requirement_revision_id,approved_by) VALUES(${approvalID},${ticketID},${revisionID},${userID})`;
      await sql`INSERT INTO factory.change(id,project_id,ticket_id,requirement_approval_id,branch_name,base_sha,state,created_by) VALUES(${changeID},${projectID},${ticketID},${approvalID},${branch},${baseSHA},'active',${userID})`;
    });
    // The approved fixture candidate is actual Git, not an agent-authored Verification result.
    await git(["checkout", "-b", branch]);
    await writeFile(resolve(checkout, "src/version.txt"), "owned-candidate\n");
    await git(["add", "src/version.txt"]);
    await git([
      "-c",
      "user.name=Owned acceptance",
      "-c",
      "user.email=acceptance@factory.invalid",
      "commit",
      "-m",
      "Owned approved candidate",
    ]);
    await git(["push", "origin", branch]);
    const commit = await git(["rev-parse", "HEAD"]);
    const tree = await git(["rev-parse", "HEAD^{tree}"]);
    // A repository-document fixture is the product's existing non-inference submitted-source path.
    const commitID = crypto.randomUUID();
    await db.client`INSERT INTO factory.change_commit_operation(id,change_id,sequence,branch_name,expected_parent_sha,commit_sha,observed_remote_sha,commit_message,idempotency_key,state,completed_at,source,repository_path,repository_blob_sha,repository_content,content_digest,created_by)
      VALUES(${commitID},${changeID},1,${branch},${baseSHA},${commit},${commit},'Owned approved candidate',${commitID},'succeeded',now(),'repository-document','src/version.txt',${await git(["rev-parse", "HEAD:src/version.txt"])},'owned-candidate\n',${createHash("sha256").update("owned-candidate\n").digest("hex")},${userID})`;
    const nativeForge = createForgejoClient({
      apiURL: `${forgeForward.base}/api/v1/`,
      token: forge.token,
    });
    await record("submitted-remote", {
      refs: await git(["ls-remote", "origin"]),
      branches: await forge.api(`repos/${forge.owner}/${repoName}/branches`),
    });
    await eventually(
      () => nativeForge.getBranch(repository, branch),
      (row) => row?.headSha === commit,
      "Actual submitted Forgejo branch is not visible",
      15_000,
    );
    await record("candidate", {
      projectID,
      ticketID,
      revisionID,
      approvalID,
      changeID,
      commitID,
      commit,
      tree,
      baseSHA,
      branch,
      submittedVia: "owned real Git repository-document fixture; no inference",
    });
    // A separately approved Ticket's native Coding compute is settled and paused on A.
    // No inference is needed to commission its retained Sandbox or run its bounded checks.
    const codingChange = crypto.randomUUID();
    const codingTicket = crypto.randomUUID();
    const codingRevision = crypto.randomUUID();
    const codingApproval = crypto.randomUUID();
    const codingBranch = `factory/change-${codingChange.replaceAll("-", "").slice(0, 12)}`;
    const codingBranchState = await nativeForge.ensureBranch(repository, codingBranch, baseSHA);
    expect(codingBranchState.headSha).toBe(baseSHA);
    await db.client.begin(async (sql) => {
      await sql`INSERT INTO factory.ticket(id,project_id,title,created_by) VALUES(${codingTicket},${projectID},'Owned unrelated settled Coding compute',${userID})`;
      await sql`INSERT INTO factory.requirement_revision(id,ticket_id,ordinal,canonical_content,content_digest,created_by) VALUES(${codingRevision},${codingTicket},1,${content},${createHash("sha256").update(content).digest("hex")},${userID})`;
      await sql`INSERT INTO factory.requirement_approval(id,ticket_id,requirement_revision_id,approved_by) VALUES(${codingApproval},${codingTicket},${codingRevision},${userID})`;
      await sql`INSERT INTO factory.change(id,project_id,ticket_id,requirement_approval_id,branch_name,base_sha,state,created_by) VALUES(${codingChange},${projectID},${codingTicket},${codingApproval},${codingBranch},${baseSHA},'active',${userID})`;
      await sql`INSERT INTO factory.branch_create_operation(id,change_id,repository_owner,repository_name,branch_name,start_sha,idempotency_key,state,observed_head_sha,completed_at)
        VALUES(${crypto.randomUUID()},${codingChange},${forge!.owner},${repoName},${codingBranch},${baseSHA},${`owned-branch:${codingChange}`},'succeeded',${codingBranchState.headSha},now())`;
    });
    const coding = await runtime.startPersisted(codingChange, userID);
    if (!coding) throw new Error("Unrelated native Coding compute was not commissioned");
    attempts.push(coding.id);
    await eventually(
      () => runtime!.get(coding.id),
      (view) => view?.state === "ready",
      "Unrelated native Coding compute did not become ready",
      900_000,
    );
    const codingTarget = await readFactoryboxFixtureTarget(db, coding.id);
    expect(codingTarget.input.profile.nodeName).toBe(cluster.nodeA);
    await factoryboxFixtureCommand(codingTarget, [
      "sh",
      "-ec",
      "node --check /home/coder/project/src/server.mjs; node --check /home/coder/project/src/worker.mjs",
    ]);
    await runtime.pause(coding.id);
    expect((await runtime.get(coding.id))?.state).toBe("paused");
    const codingBefore =
      await db.client`SELECT id,state,factorybox_worker_id,factorybox_admission_id,kubernetes_uid,revision,stop_intended_at FROM factory.runtime_attempt WHERE id=${coding.id}`;
    await record("settled-coding-before", {
      changeID: codingChange,
      ticketID: codingTicket,
      codingBefore,
      boundedChecksExecuted: true,
      inferenceDispatched: false,
      target: codingTarget,
    });
    const development = await runtime.start(projectID, userID);
    if (!development) throw new Error("Owned Development intent missing");
    attempts.push(development.id);
    await eventually(
      () => runtime!.get(development.id),
      (view) => view?.state === "ready",
      "Native Development did not become ready",
      900_000,
    );
    const dev = await readFactoryboxFixtureTarget(db, development.id);
    expect(dev.input.profile.nodeName).toBe(cluster.nodeA);
    const workspaceID = development.workspaceId!;
    async function source(operation: string, body: unknown) {
      const fields = body as { path: string; content?: string; version?: string };
      const wire =
        fields.content === undefined
          ? fields
          : { ...fields, content: Buffer.from(fields.content).toString("base64") };
      const response = await sources!.forward(
        workspaceID,
        userID,
        operation,
        new Request("http://factory.internal/source", {
          method: "POST",
          body: JSON.stringify(wire),
        }),
      );
      if (!response.ok)
        throw new Error(`Authorized canonical Source ${operation}: ${response.status}`);
      const value = (await response.json()) as { content: string; version: string };
      return { ...value, content: Buffer.from(value.content, "base64").toString() };
    }
    const tracked = await source("read", { path: "src/version.txt" });
    await source("write", {
      path: "src/version.txt",
      content: "owned-dirty-tracked\n",
      version: tracked.version,
    });
    await source("write", {
      path: "owned-untracked.txt",
      content: "owned-dirty-untracked\n",
      version: "",
    });
    const dirty = await createPersonalGit(db, hub).read(workspaceID, userID);
    await record("source-before", {
      dirty,
      rows: await db.client`SELECT workspace_id,state,namespace_uid,claim_uid,pod_uid,storage_node,source_directory FROM factory.workspace_source WHERE workspace_id=${workspaceID}`,
    });
    delivery = createDeliveryController(
      db,
      runtime,
      {
        async prompt() {
          throw new Error("Acceptance may not commission repair inference");
        },
      },
      async () => {},
      { client: nativeForge, owner: forge.owner },
    );
    await delivery.reconcile(changeID);
    const verification = await eventually(
      async () => {
        await delivery!.reconcile(changeID);
        const [row] = await db.client<
          { id: string; attemptID: string | null }[]
        >`SELECT id,runtime_attempt_id AS "attemptID" FROM factory.verification WHERE change_id=${changeID}`;
        return row;
      },
      (row) => Boolean(row?.attemptID),
      "Product did not commission Verification",
      120_000,
    );
    if (!verification?.attemptID) throw new Error("Verification native Attempt missing");
    attempts.push(verification.attemptID);
    await record("identities-before-execution", {
      workers:
        await db.client`SELECT id,singleton,node_name,node_identity,namespace_uid,pod_uid,source_claim_uid,claim_uid,identity FROM factory.factorybox_worker`,
      attempts:
        await db.client`SELECT id,project_id,workspace_id,verification_id,revision,factorybox_worker_id,factorybox_admission_id,state FROM factory.runtime_attempt`,
      artifacts: await db.client`SELECT * FROM factory.runtime_artifact_intent`,
    });
    const entered = await Promise.race([
      jobEntered.promise,
      Bun.sleep(900_000).then(() => {
        throw new Error("Actual Forgejo job did not reach the overlap probe");
      }),
    ]);
    expect(entered.head).toBe(commit);
    const remote = await readFactoryboxFixtureTarget(db, verification.attemptID);
    remoteNamespace = remote.input.namespace;
    expect(remote.input.profile.nodeName).toBe(cluster.nodeB);
    expect(remote.input.sharedSource).toBe(false);
    expect(remote.input.workerID).not.toBe(dev.input.workerID);
    expect(lostCreateAcknowledgment).toBe(true);
    expect(
      transportEvents.filter((event) => event.sandboxID === remote.input.sandboxID),
    ).toHaveLength(1);
    const exactCheckout = await factoryboxFixtureCommand(remote, [
      "sh",
      "-ec",
      "git -c safe.directory=/home/coder/project -C /home/coder/project rev-parse HEAD HEAD^{tree}; git -c safe.directory=/home/coder/project -C /home/coder/project status --porcelain",
    ]);
    expect(exactCheckout.trim().split("\n")).toEqual([commit, tree]);
    const observedPods = JSON.parse(await cluster.kubectl(["get", "pods", "-A", "-o", "json"]));
    const observedClaims = JSON.parse(await cluster.kubectl(["get", "pvc", "-A", "-o", "json"]));
    const [sourceOnA] = await db.client<
      { claim_uid: string }[]
    >`SELECT claim_uid FROM factory.workspace_source WHERE workspace_id=${workspaceID}`;
    for (const pod of observedPods.items) {
      if (pod.spec.nodeName !== cluster.nodeB) continue;
      for (const volume of pod.spec.volumes ?? []) {
        if (!volume.persistentVolumeClaim) continue;
        const claim = observedClaims.items.find(
          (item: { metadata: { namespace: string; name: string; uid: string } }) =>
            item.metadata.namespace === pod.metadata.namespace &&
            item.metadata.name === volume.persistentVolumeClaim.claimName,
        );
        expect(claim?.metadata.uid).not.toBe(sourceOnA?.claim_uid);
      }
    }
    await record("private-checkout-and-mounts", {
      head: commit,
      tree,
      clean: true,
      pods: observedPods,
      claims: observedClaims,
      sourceClaimA:
        await db.client`SELECT claim_uid FROM factory.workspace_source WHERE workspace_id=${workspaceID}`,
    });
    const identityResults: unknown[] = [];
    for (const fault of ["pod", "claim", "boot", "epoch", "store"] as const) {
      identityFault = fault;
      identityFaultApplied = false;
      const startsBefore = transportEvents.length;
      let refusal = "";
      try {
        await execution.hasExited(verification.attemptID);
      } catch (cause) {
        refusal = cause instanceof Error ? cause.message : String(cause);
      }
      identityFault = undefined;
      expect(identityFaultApplied).toBe(true);
      expect(refusal).not.toBe("");
      expect(transportEvents.length).toBe(startsBefore);
      expect((await runtime.get(development.id))?.state).toBe("ready");
      expect((await runtime.startVerification(verification.id, userID))?.id).toBe(
        verification.attemptID,
      );
      identityResults.push({
        fault,
        refusal,
        nativeStartsAdded: 0,
        attemptRetained: verification.attemptID,
      });
    }
    await record("destination-identity-failures", identityResults);
    await cluster.kubectl(["cordon", cluster.nodeB]);
    const startsBeforeUnsuitable = transportEvents.length;
    await expect(execution.hasExited(verification.attemptID)).rejects.toThrow();
    expect((await runtime.startVerification(verification.id, userID))?.id).toBe(
      verification.attemptID,
    );
    expect(transportEvents.length).toBe(startsBeforeUnsuitable);
    await record("unsuitable-bound-node", {
      nodes: JSON.parse(await cluster.kubectl(["get", "nodes", "-o", "json"])),
      startsAdded: 0,
      attemptRetained: verification.attemptID,
    });
    await cluster.kubectl(["uncordon", cluster.nodeB]);
    const useful: unknown[] = [];
    for (let index = 0; index < 4; index++) {
      const response = await hub.request(
        development.id,
        "app",
        new Request("http://factory.internal/source"),
        "/source",
      );
      expect(response.ok).toBe(true);
      const result = (await response.json()) as { version: string; digest: string };
      expect(result.version).toBe("owned-dirty-tracked");
      useful.push({ at: Date.now(), status: response.status, ...result });
      await source("write", {
        path: "owned-untracked.txt",
        content: `owned-dirty-untracked-${index}\n`,
        version: (await source("read", { path: "owned-untracked.txt" })).version,
      });
    }
    await record("overlap", {
      entered,
      observedAt: Date.now(),
      developmentAttemptID: development.id,
      verificationAttemptID: verification.attemptID,
      projectID,
      useful,
      dev,
      remote,
      jobEvents,
      transportEvents,
    });
    gate.resolve();
    await eventually(
      async () => {
        await delivery!.reconcile(changeID);
        const [row] = await db.client<
          { state: string; summary: string; diagnosis: unknown }[]
        >`SELECT state,summary,diagnosis FROM factory.verification WHERE id=${verification.id}`;
        if (row?.state === "failed") throw new Error(`Real Verification failed: ${row.summary}`);
        return row;
      },
      (row) => row?.state === "succeeded",
      "Actual Forgejo Verification verdict not recorded",
      120_000,
    );
    const after = await createPersonalGit(db, hub).read(workspaceID, userID);
    expect(after).toEqual(dirty);
    expect((await source("read", { path: "src/version.txt" })).content).toBe(
      "owned-dirty-tracked\n",
    );
    expect((await source("read", { path: "owned-untracked.txt" })).content).toBe(
      "owned-dirty-untracked-3\n",
    );
    expect((await runtime.get(development.id))?.state).toBe("ready");
    expect(
      await db.client`SELECT id,state,factorybox_worker_id,factorybox_admission_id,kubernetes_uid,revision,stop_intended_at FROM factory.runtime_attempt WHERE id=${coding.id}`,
    ).toEqual(codingBefore);
    await record("settled-coding-after", {
      codingBefore,
      after:
        await db.client`SELECT id,state,factorybox_worker_id,factorybox_admission_id,kubernetes_uid,revision,stop_intended_at FROM factory.runtime_attempt WHERE id=${coding.id}`,
    });
    await record("source-after", {
      after,
      rows: await db.client`SELECT workspace_id,state,namespace_uid,claim_uid,pod_uid,storage_node,source_directory FROM factory.workspace_source WHERE workspace_id=${workspaceID}`,
    });
    await record("verdict", {
      verification:
        await db.client`SELECT id,change_id,commit_sha,state,action_run_id,action_run_url,summary,diagnosis,completed_at FROM factory.verification WHERE id=${verification.id}`,
      runs: await nativeForge.listActionRuns(repository, commit),
      lifecycle:
        await db.client`SELECT runtime_attempt_id,action,attempted_at,completed_at FROM factory.factorybox_lifecycle_operation`,
    });
    passed = true;
    await expect(delivery.approve(changeID, userID)).rejects.toThrow();
    expect(
      await db.client`SELECT id FROM factory.delivery_approval WHERE change_id=${changeID}`,
    ).toHaveLength(0);
    await record("exact-delivery-gate", {
      changeID,
      verifiedCommit: commit,
      independentReviewNotCompleted: true,
      unauthorizedDeliveryRefused: true,
    });
    await eventually(
      () => runtime!.get(verification.attemptID!),
      (view) => view?.state === "stopped",
      "Successful Verification cleanup was not confirmed",
      120_000,
    );
    // Each negative case owns another approved candidate and real queued Forgejo run.
    async function negativeCandidate(name: string) {
      const change = crypto.randomUUID();
      const ticket = crypto.randomUUID();
      const revision = crypto.randomUUID();
      const approval = crypto.randomUUID();
      const operation = crypto.randomUUID();
      const destination = `factory/change-${change.replaceAll("-", "").slice(0, 12)}`;
      const text = `owned-${name}\n`;
      await git(["checkout", "-b", destination, commit]);
      await writeFile(resolve(checkout, "src/version.txt"), text);
      await git(["add", "src/version.txt"]);
      await git([
        "-c",
        "user.name=Owned acceptance",
        "-c",
        "user.email=acceptance@factory.invalid",
        "commit",
        "-m",
        `Owned ${name} candidate`,
      ]);
      await git(["push", "origin", destination]);
      const head = await git(["rev-parse", "HEAD"]);
      await eventually(
        () => nativeForge.getBranch(repository, destination),
        (row) => row?.headSha === head,
        "Negative candidate remote visibility missing",
        15_000,
      );
      await db.client.begin(async (sql) => {
        await sql`INSERT INTO factory.ticket(id,project_id,title,created_by) VALUES(${ticket},${projectID},${`Owned ${name}`},${userID})`;
        await sql`INSERT INTO factory.requirement_revision(id,ticket_id,ordinal,canonical_content,content_digest,created_by) VALUES(${revision},${ticket},1,${content},${createHash("sha256").update(content).digest("hex")},${userID})`;
        await sql`INSERT INTO factory.requirement_approval(id,ticket_id,requirement_revision_id,approved_by) VALUES(${approval},${ticket},${revision},${userID})`;
        await sql`INSERT INTO factory.change(id,project_id,ticket_id,requirement_approval_id,branch_name,base_sha,state,created_by) VALUES(${change},${projectID},${ticket},${approval},${destination},${baseSHA},'active',${userID})`;
        await sql`INSERT INTO factory.change_commit_operation(id,change_id,sequence,branch_name,expected_parent_sha,commit_sha,observed_remote_sha,commit_message,idempotency_key,state,completed_at,source,repository_path,repository_blob_sha,repository_content,content_digest,created_by)
          VALUES(${operation},${change},1,${destination},${commit},${head},${head},${`Owned ${name} candidate`},${operation},'succeeded',now(),'repository-document','src/version.txt',${await git(["rev-parse", "HEAD:src/version.txt"])},${text},${createHash("sha256").update(text).digest("hex")},${userID})`;
      });
      await record(`candidate-${name}`, {
        change,
        ticket,
        revision,
        approval,
        operation,
        projectID,
        head,
        destination,
      });
      return { change, head };
    }
    async function commission(change: string) {
      const row = await eventually(
        async () => {
          await delivery!.reconcile(change);
          const [value] = await db.client<
            { id: string; attemptID: string | null }[]
          >`SELECT id,runtime_attempt_id AS "attemptID" FROM factory.verification WHERE change_id=${change}`;
          return value;
        },
        (value) => Boolean(value?.attemptID),
        "Negative product Verification was not commissioned",
        120_000,
      );
      if (!row?.attemptID) throw new Error("Negative native Attempt missing");
      attempts.push(row.attemptID);
      return { id: row.id, attemptID: row.attemptID };
    }
    async function cancelFixture(change: string, attemptID: string) {
      await db.client`UPDATE factory.change SET state='cancelling',cancel_requested_at=now() WHERE id=${change} AND project_id=${projectID}`;
      await delivery!.reconcile(change);
      await runtime!.stop(attemptID);
    }
    await cluster.kubectl(["cordon", cluster.nodeB]);
    await db.client`INSERT INTO factory.execution_policy(scope,version,policy,updated_by) VALUES('factory',1,'{"sandboxes":0}'::jsonb,${userID})`;
    const capacityCandidate = await negativeCandidate("capacity-refusal");
    const beforeCapacity = transportEvents.length;
    const queued = await commission(capacityCandidate.change);
    const [queuedBinding] = await db.client<
      { factorybox_worker_id: string; state: string }[]
    >`SELECT factorybox_worker_id,state FROM factory.runtime_attempt WHERE id=${queued.attemptID}`;
    expect(queuedBinding?.factorybox_worker_id).toBe(dev.input.workerID);
    expect(queuedBinding?.state).toBe("create-intended");
    expect(transportEvents.length).toBe(beforeCapacity);
    expect((await runtime.get(development.id))?.state).toBe("ready");
    await record("native-capacity-refusal", {
      queued,
      queuedBinding,
      nativeCreatesAdded: 0,
      computeWait:
        await db.client`SELECT * FROM factory.runtime_compute_wait WHERE attempt_id=${queued.attemptID}`,
    });
    await cancelFixture(capacityCandidate.change, queued.attemptID);
    await db.client`DELETE FROM factory.execution_policy WHERE scope='factory' AND version=1 AND updated_by=${userID}`;
    await cluster.kubectl(["uncordon", cluster.nodeB]);
    const corrupted = await negativeCandidate("source-corruption");
    corruptCommit = corrupted.head;
    const corruptAttempt = await commission(corrupted.change);
    const failedSource = await eventually(
      async () => {
        await delivery!.reconcile(corrupted.change);
        const [value] = await db.client<
          { state: string; summary: string }[]
        >`SELECT state,summary FROM factory.verification WHERE id=${corruptAttempt.id}`;
        return value;
      },
      (value) => value?.state === "failed",
      "Corrupted actual Git source did not fail closed",
      600_000,
    );
    expect(sourceCorrupted).toBe(true);
    corruptCommit = undefined;
    await record("native-source-corruption", {
      corruptAttempt,
      failedSource,
      operations:
        await db.client`SELECT action,attempted_at,completed_at FROM factory.factorybox_lifecycle_operation WHERE runtime_attempt_id=${corruptAttempt.attemptID}`,
      verification:
        await db.client`SELECT id,state,commit_sha,summary,diagnosis FROM factory.verification WHERE id=${corruptAttempt.id}`,
    });
    await cancelFixture(corrupted.change, corruptAttempt.attemptID);
    const outage = await negativeCandidate("node-loss");
    jobEntered = Promise.withResolvers<{ head: string; started: number }>();
    activeJobGate = Promise.withResolvers<void>();
    const outageAttempt = await commission(outage.change);
    const outageEntered = await Promise.race([
      jobEntered.promise,
      Bun.sleep(600_000).then(() => {
        throw new Error("Owned outage Forgejo job never executed");
      }),
    ]);
    expect(outageEntered.head).toBe(outage.head);
    const originalOutageBinding =
      await db.client`SELECT id,factorybox_worker_id,factorybox_admission_id,kubernetes_uid,revision FROM factory.runtime_attempt WHERE id=${outageAttempt.attemptID}`;
    const startsBeforeLoss = transportEvents.length;
    await cluster.stopNodeB();
    await cluster.kubectl([
      "wait",
      '--for=jsonpath={.status.conditions[?(@.type=="Ready")].status}=Unknown',
      `node/${cluster.nodeB}`,
      "--timeout=90s",
    ]);
    await expect(execution.hasExited(outageAttempt.attemptID)).rejects.toThrow();
    for (let index = 0; index < 3; index++) {
      await delivery!.reconcile(outage.change);
      expect((await runtime.startVerification(outageAttempt.id, userID))?.id).toBe(
        outageAttempt.attemptID,
      );
    }
    expect(
      await db.client`SELECT id,factorybox_worker_id,factorybox_admission_id,kubernetes_uid,revision FROM factory.runtime_attempt WHERE id=${outageAttempt.attemptID}`,
    ).toEqual(originalOutageBinding);
    expect(transportEvents.length).toBe(startsBeforeLoss);
    expect(
      await db.client`SELECT id FROM factory.verification WHERE id=${outageAttempt.id} AND state='succeeded'`,
    ).toHaveLength(0);
    expect((await runtime.get(development.id))?.state).toBe("ready");
    expect((await source("read", { path: "src/version.txt" })).content).toBe(
      "owned-dirty-tracked\n",
    );
    expect((await source("read", { path: "owned-untracked.txt" })).content).toBe(
      "owned-dirty-untracked-3\n",
    );
    expect(
      await db.client`SELECT id,state,factorybox_worker_id,factorybox_admission_id,kubernetes_uid,revision,stop_intended_at FROM factory.runtime_attempt WHERE id=${coding.id}`,
    ).toEqual(codingBefore);
    await record("native-node-loss", {
      outageAttempt,
      outageEntered,
      originalOutageBinding,
      nativeCreatesAdded: 0,
      verification:
        await db.client`SELECT id,state,commit_sha,summary,diagnosis FROM factory.verification WHERE id=${outageAttempt.id}`,
      development: await runtime.get(development.id),
      nodes: JSON.parse(await cluster.kubectl(["get", "nodes", "-o", "json"])),
    });
    activeJobGate.resolve();
    failuresPassed = true;
  } catch (cause) {
    await record("failure", {
      error: cause instanceof Error ? cause.message : String(cause),
      attempts,
    });
    if (database)
      await record("failure-state", {
        attempts:
          await database.client`SELECT id,state,failure,revision,kubernetes_namespace,kubernetes_uid,factorybox_worker_id FROM factory.runtime_attempt`,
        workers:
          await database.client`SELECT id,node_name,namespace_uid,pod_uid FROM factory.factorybox_worker`,
      });
    throw cause;
  } finally {
    await delivery?.close();
    for (const attempt of attempts.toReversed()) await runtime?.stop(attempt).catch(() => {});
    if (database && attempts.length) {
      await eventually(
        async () =>
          database!.client<
            { state: string }[]
          >`SELECT state FROM factory.runtime_attempt WHERE id=ANY(${attempts}::uuid[])`,
        (rows) => rows.every((row) => ["stopped", "failed", "cleanup-failed"].includes(row.state)),
        "Owned native cleanup did not settle its exact Attempts",
        420_000,
      ).catch(() => {});
      await record(
        "native-cleanup-state",
        await database.client`SELECT id,state,failure FROM factory.runtime_attempt WHERE id=ANY(${attempts}::uuid[])`,
      );
    }
    await sources?.close();
    await control?.stop(true);
    await forge?.dispose();
    await registry?.dispose();
    await relay?.dispose();
    await cluster.dispose();
    await database?.client.end();
    await host?.dispose();
    await postgres?.dispose();
    for (const key of Object.keys(process.env)) if (!(key in environment)) delete process.env[key];
    Object.assign(process.env, environment);
    await record("receipt", {
      schema: 1,
      host: "archy",
      productOverlapPassed: passed,
      milestoneComplete: passed && failuresPassed,
      failureMatrixPassed: failuresPassed,
      retainedInstallationChanged: false,
      physicalCapacityDoubled: false,
      ownedCleanupCompleted: true,
    });
  }
}, 2_400_000);
