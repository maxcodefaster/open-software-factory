import { expect } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, open, readFile, writeFile } from "node:fs/promises";
import { isAbsolute, join, normalize } from "node:path";
import { type Browser, expect as visible } from "@playwright/test";
import { z } from "zod";
import type { createDatabase } from "#db/client";
import { nativeLifecycleWindowMS } from "#runtime-domain/timing";
import {
  nativeActor,
  nativeSnapshot,
  type SubstrateCall,
} from "#runtime-kubernetes/substrate-control";
import { parseSubstrateProjectTemplate } from "#runtime-kubernetes/substrate-project-template";
import { appRuntimeOrigin } from "../../apps/factory/src/runtime-origins";
import { serverCall } from "../../apps/factory/src/server-functions/result";
import type { RuntimeArtifacts } from "../../scripts/factory/artifacts";
import { eventually } from "./factory-process";
import { readNativeWorkspaceObservation } from "./native-workspace-observation";
import {
  ownedRuntimeTerminal,
  ownedRuntimeTerminalURL,
  runtimeAccessCookie,
} from "./runtime-access";
import { callFactoryFunction } from "./server-functions";
import { starterDelivery } from "./starter-delivery";
import {
  connectStarterNativeLifecycle,
  requireStarterNativeContract,
  requireStarterRetainedLifecycleEvidence,
  type StarterActiveObservation,
  type StarterRetainedObservation,
  starterActiveObservationSchema,
  type starterNativeLifecycle,
  starterRetainedObservationSchema,
} from "./starter-native-lifecycle";
import { starterSetupDesktop } from "./starter-setup-desktop";

// The caller confirms the original installation/resource ownership, supplies
// its authenticated session and matching compiled Factory function manifest,
// and owns retention/cleanup. Updated identities survive a failed journey so
// that the caller can retain or clean up only this fixture's Project/setup.
export type StarterRuntimeJourneyOwnership = {
  factoryID: string;
  databaseName: string;
  slug: string;
  projectID: string;
  setupID: string;
};

export type StarterRuntimeJourneyInput = {
  base: string;
  cookie: string;
  database: ReturnType<typeof createDatabase>;
  artifacts: RuntimeArtifacts;
  artifactDirectory: string;
  nativeRead: SubstrateCall;
  browser: Browser;
  evidenceDirectory: string;
  ownership: StarterRuntimeJourneyOwnership;
  // Each owned Project admits one immutable native preference before first Start.
  // Run separate Projects to qualify both paths; a second MEMORY Pause is not ROOTFS.
  restoreFidelity?: "SNAPSHOT_FIDELITY_MEMORY" | "SNAPSHOT_FIDELITY_ROOTFS";
  desktopProof?: boolean;
  restartPreview?: boolean;
  delivery?: "only" | "after-journey";
};

export type StarterLifecycleBinding = {
  projectID: string;
  workspaceID: string;
  attemptID: string;
  actorUID: string;
  atespace: string;
  actorName: string;
  generation: string;
  templateUID: string;
};

export function starterSnapshotPreference(
  content: string,
  fidelity: "SNAPSHOT_FIDELITY_MEMORY" | "SNAPSHOT_FIDELITY_ROOTFS",
) {
  const project = parseSubstrateProjectTemplate(content);
  const declared = project.snapshotConfig?.preferredFidelity ?? "SNAPSHOT_FIDELITY_MEMORY";
  if (declared === fidelity) return content;
  if (fidelity !== "SNAPSHOT_FIDELITY_ROOTFS")
    throw Error("Owned Starter template declares a different snapshot preference");
  return `${JSON.stringify({ ...project, snapshotConfig: { preferredFidelity: fidelity } }, null, 2)}\n`;
}

const requestScope = z.object({
  factoryID: z.string().min(1),
  databaseName: z.string().min(1),
  projectID: z.uuid(),
  workspaceID: z.uuid(),
  phase: z.enum(["initial-start", "memory-pause", "memory-start", "rootfs-pause"]),
  action: z.enum(["start", "pause"]),
});

// Fixture evidence only, not a second product journal. Persist the caller's ID
// before dispatch and recover that exact identity after an interrupted observer.
export async function starterLifecycleRequest(
  directory: string,
  selection: z.infer<typeof requestScope>,
) {
  const scope = requestScope.parse(selection);
  if (scope.action !== (scope.phase.endsWith("pause") ? "pause" : "start"))
    throw Error("Starter lifecycle phase does not match its deliberate action");
  const path = join(directory, `lifecycle-${scope.phase}.json`);
  const record = { ...scope, requestID: crypto.randomUUID() };
  await mkdir(directory, { recursive: true });
  try {
    const file = await open(path, "wx", 0o600);
    try {
      await file.writeFile(JSON.stringify(record, null, 2));
      await file.sync();
    } finally {
      await file.close();
    }
    const parent = await open(directory, "r");
    try {
      await parent.sync();
    } finally {
      await parent.close();
    }
  } catch (cause) {
    if (!(cause instanceof Error && "code" in cause && cause.code === "EEXIST")) throw cause;
  }
  const saved = requestScope
    .extend({ requestID: z.uuid() })
    .parse(JSON.parse(await readFile(path, "utf8")));
  expect(saved).toMatchObject(scope);
  return saved.requestID;
}

// Existing caller inputs provide real read-only SQL and native observations.
// Missing Source rows/permissions are failures, never a synthesized epoch.
export async function readStarterRetainedObservation(
  database: ReturnType<typeof createDatabase>,
  nativeRead: SubstrateCall,
  binding: StarterLifecycleBinding,
): Promise<StarterRetainedObservation> {
  const [row] = await database.client`
    SELECT attempt.id AS "attemptID",attempt.project_id AS "projectID",
      attempt.workspace_id AS "workspaceID",attempt.generation::text AS generation,attempt.state,
      attempt.actor_uid AS "actorUID",attempt.binding_intent->>'templateUID' AS "templateUID",
      jsonb_build_object('workspaceID',source.workspace_id,'actorUID',source.actor_uid,
        'owner',source.owner,'writerEpoch',source.writer_epoch,'generation',source.generation,
        'writable',source.writable,'checkpointID',source.checkpoint_id,'checkpoint',source.checkpoint,
        'serviceBase',source.service_base,'seed',source.seed,'seedConfirmedAt',source.seed_confirmed_at) AS source,
      jsonb_build_object(
        'agentTurns',(SELECT count(*)::int FROM factory.agent_turn WHERE project_id=attempt.project_id),
        'agentSessions',(SELECT count(*)::int FROM factory.change_agent_session session
          JOIN factory.change change ON change.id=session.change_id WHERE change.project_id=attempt.project_id),
        'modelOperations',(SELECT count(*)::int FROM factory.usage_operation WHERE project_id=attempt.project_id),
        'modelUsageEntries',(SELECT count(*)::int FROM factory.usage_entry entry
          JOIN factory.usage_operation operation ON operation.id=entry.operation_id
          WHERE operation.project_id=attempt.project_id)) AS inference
    FROM factory.runtime_attempt attempt
    JOIN factory.substrate_source source ON source.workspace_id=attempt.workspace_id
    WHERE attempt.id=${binding.attemptID} AND attempt.project_id=${binding.projectID}
      AND attempt.workspace_id=${binding.workspaceID} AND attempt.generation=${binding.generation}::bigint
      AND attempt.actor_uid=${binding.actorUID} AND attempt.atespace=${binding.atespace}
      AND attempt.actor_name=${binding.actorName} AND attempt.binding_intent->>'templateUID'=${binding.templateUID}
      AND attempt.stop_intended_at IS NULL
      AND attempt.delete_intended_at IS NULL AND attempt.deleted_at IS NULL`;
  if (!row) throw Error("Original Starter Actor/Source observation is unavailable");
  expect(row["actorUID"]).toBe(binding.actorUID);
  expect(row["templateUID"]).toBe(binding.templateUID);
  const actor = nativeActor.parse(
    await nativeRead("GetActor", {
      actor: { atespace: binding.atespace, name: binding.actorName },
    }),
  );
  expect(actor.metadata.uid).toBe(binding.actorUID);
  return starterRetainedObservationSchema.parse({ ...row, actor });
}

type LifecycleTools = Pick<
  ReturnType<typeof starterNativeLifecycle>,
  "pause" | "start" | "workspace" | "currentFile"
>;

// One maintained qualification flow, using only existing product commands.
// Observation/inspection callbacks collect receipts; they grant no lifecycle authority.
export async function starterRetainedCycle(input: {
  binding: StarterLifecycleBinding;
  tools: LifecycleTools;
  before: StarterActiveObservation;
  fidelity: "SNAPSHOT_FIDELITY_MEMORY" | "SNAPSHOT_FIDELITY_ROOTFS";
  observe(): Promise<StarterRetainedObservation>;
  inspect(mode: "observe" | "restart"): Promise<StarterActiveObservation>;
  ready(): Promise<unknown>;
  request(
    phase: "memory-pause" | "memory-start" | "rootfs-pause",
    action: "start" | "pause",
  ): Promise<string>;
  sourcePath: string;
  sourceContent: string;
  evidenceDirectory: string;
}) {
  const { binding, tools, before, fidelity } = input;
  const memory = fidelity === "SNAPSHOT_FIDELITY_MEMORY";
  const phase = memory ? "memory" : "rootfs";
  const requestID = await input.request(memory ? "memory-pause" : "rootfs-pause", "pause");
  expect(await tools.pause(binding.workspaceID, requestID)).toMatchObject({
    id: binding.attemptID,
  });
  const paused = await eventually(
    input.observe,
    (row) =>
      row.state === "paused" &&
      row.actor.status.state === "ACTOR_STATE_SUSPENDED" &&
      row.actor.status.assignedNode === undefined &&
      row.actor.status.workerAssignment === undefined,
    "Starter native Pause/detach was not confirmed",
    nativeLifecycleWindowMS,
  );
  expect(paused.source).toEqual(before.source);
  expect((await tools.workspace(binding.workspaceID)).runtime).toMatchObject({
    id: binding.attemptID,
    state: "paused",
    native: { actorUID: binding.actorUID },
  });
  const candidates = (paused.actor.status.snapshots ?? []).filter(
    (item) =>
      z.object({ generation: z.number() }).parse(item).generation ===
      paused.actor.status.lastAssignedGeneration,
  );
  expect(candidates).toHaveLength(1);
  const snapshot = nativeSnapshot.parse(candidates[0]);
  // This journey qualifies an explicitly declared preference. Automatic native
  // cross-runtime fallback needs a separate rollout fixture and restore witness.
  await writeFile(
    join(input.evidenceDirectory, `native-${phase}-paused.json`),
    JSON.stringify({ expectedFidelity: fidelity, snapshot, paused }, null, 2),
    { mode: 0o600 },
  );
  if (snapshot.fidelity !== fidelity)
    throw Error(
      `Required Starter ${phase.toUpperCase()} proof unavailable: observed ${snapshot.fidelity}`,
    );
  if (memory) {
    const resumeID = await input.request("memory-start", "start");
    expect(await tools.start(binding.workspaceID, resumeID)).toMatchObject({
      id: binding.attemptID,
    });
  } else {
    // This authenticated current-file demand wakes the original Actor, not a
    // successor. Passive Source/context observation above did not wake it.
    expect(
      (await tools.currentFile(binding.workspaceID, `/workspace/project/${input.sourcePath}`))
        .content,
    ).toBe(input.sourceContent);
  }
  await input.ready();
  const after = await input.inspect(memory ? "observe" : "restart");
  const evidence = requireStarterRetainedLifecycleEvidence({
    before,
    paused,
    after,
    templateUID: binding.templateUID,
    fidelity,
  });
  await writeFile(
    join(input.evidenceDirectory, `native-${phase}-lifecycle.json`),
    JSON.stringify(evidence, null, 2),
    { mode: 0o600 },
  );
  return evidence;
}

function nodeCommand(source: string) {
  return `node -e 'eval(Buffer.from("${Buffer.from(source).toString("base64")}","base64").toString())'`;
}

type StarterProbe = {
  id: string;
  dirtyPath: string;
  stagedPath: string;
  untrackedPath: string;
  appURL?: string;
  // Local producer tests use their own image-free temporary directory. Native
  // qualification still requires the /home/node path checked by its evidence guard.
  rootfsPath?: string;
  previousProcess?: { pid: number; instanceID: string };
};

// Only an owned Work process runs this script. Its random nonce stays in the
// server's RAM (never a saved file); the Unix socket identifies the owned probe.
export function starterProbeCommand(
  probe: StarterProbe,
  mode: "create" | "observe" | "restart" | "dispose",
) {
  z.uuid().parse(probe.id);
  if (mode === "restart")
    z.object({ pid: z.number().int().positive(), instanceID: z.uuid() }).parse(
      probe.previousProcess,
    );
  const appURL = new URL(probe.appURL ?? "http://127.0.0.1:4300/health");
  if (
    appURL.protocol !== "http:" ||
    appURL.hostname !== "127.0.0.1" ||
    appURL.username ||
    appURL.password ||
    appURL.search ||
    appURL.hash
  )
    throw Error("Starter probe App must be an owned loopback endpoint");
  for (const path of [probe.dirtyPath, probe.stagedPath, probe.untrackedPath])
    if (!/^[a-zA-Z0-9_./-]+$/.test(path) || path.split("/").includes("..") || path.startsWith("/"))
      throw Error("Starter probe paths must stay inside its owned checkout");
  const socket = `/tmp/factory-starter-${probe.id}.sock`;
  const rootfsPath = probe.rootfsPath ?? `/home/node/factory-starter-${probe.id}.rootfs`;
  if (
    !isAbsolute(rootfsPath) ||
    normalize(rootfsPath) !== rootfsPath ||
    rootfsPath.includes("\0") ||
    !rootfsPath.endsWith(`/factory-starter-${probe.id}.rootfs`)
  )
    throw Error("Starter rootfs witness must have its exact owned absolute filename");
  const child = `const http=require("node:http"),crypto=require("node:crypto"),fs=require("node:fs");
const nonce=crypto.randomUUID();let counter=0;
const server=http.createServer((request,response)=>{
 const url=new URL(request.url,"http://probe");
 if(url.searchParams.get("key")!==${JSON.stringify(probe.id)}){response.writeHead(403).end();return}
 if(request.method==="DELETE"){response.end('{"disposed":true}');server.close(()=>process.exit(0));return}
 response.setHeader("content-type","application/json");
 response.end(JSON.stringify({pid:process.pid,instanceID:process.argv[1],memoryNonce:nonce,challenge:url.searchParams.get("challenge"),counter:++counter}));
});
server.listen(${JSON.stringify(socket)});setTimeout(()=>server.close(()=>process.exit(0)),1800000).unref();`;
  return nodeCommand(`(async()=>{
const fs=require("node:fs"),http=require("node:http"),crypto=require("node:crypto"),cp=require("node:child_process");
const socket=${JSON.stringify(socket)},key=${JSON.stringify(probe.id)},mode=${JSON.stringify(mode)},previous=${JSON.stringify(probe.previousProcess ?? null)};
const rootfsPath=${JSON.stringify(rootfsPath)},rootfsContent="factory-starter-rootfs:"+key+"\\n";
if(mode==="create")fs.writeFileSync(rootfsPath,rootfsContent,{flag:"wx",mode:0o600});
function rootfs(){
 const stat=fs.lstatSync(rootfsPath,{bigint:true});
 if(!stat.isFile()||stat.nlink!==1n||fs.readFileSync(rootfsPath,"utf8")!==rootfsContent)
  throw Error("Owned image-backed rootfs witness changed");
 return {path:rootfsPath,sha256:crypto.createHash("sha256").update(rootfsContent).digest("hex"),mtimeNs:stat.mtimeNs.toString()};
}
// Observe/restart must never recreate missing ROOTFS state or reset its mtime.
const rootfsEvidence=mode==="dispose"&&!fs.existsSync(rootfsPath)?undefined:rootfs();
if(mode==="restart"){
 let args="";
 try{args=process.platform==="linux"?fs.readFileSync("/proc/"+previous.pid+"/cmdline","utf8"):
  cp.execFileSync("ps",["-p",String(previous.pid),"-o","args="],{encoding:"utf8",stdio:["ignore","pipe","ignore"]});
 }catch(error){if(process.platform==="linux"&&error.code!=="ENOENT")throw error;
  if(process.platform!=="linux"&&error.status!==1)throw error}
 if(args.includes(previous.instanceID))throw Error("ROOTFS retained the old probe process; restart is not proven");
}
function request(method,challenge){return new Promise((resolve,reject)=>{
 const q=http.request({socketPath:socket,method,path:"/?"+new URLSearchParams({key,challenge})},r=>{
 let text="";r.on("data",c=>{text+=c;if(text.length>4096)q.destroy(Error("Probe response exceeds bound"))});
 r.on("end",()=>{try{if(r.statusCode!==200)throw Error("Probe refused request");resolve(JSON.parse(text))}catch(e){reject(e)}});
 });q.setTimeout(1000,()=>q.destroy(Error("Probe timed out")));q.on("error",reject);q.end();
})}
const challenge=crypto.randomUUID();let processEvidence;
try{processEvidence=await request(mode==="dispose"?"DELETE":"GET",challenge);
 if(mode==="restart")throw Error("ROOTFS retained the old probe process; restart is not proven");
}catch(error){
 if(!["ENOENT","ECONNREFUSED"].includes(error.code))throw error;
 if(mode==="observe")throw Error("MEMORY probe did not continue");
 if(mode!=="dispose"){
  if(fs.existsSync(socket)){if(!fs.lstatSync(socket).isSocket())throw Error("Owned probe path is not a socket");fs.unlinkSync(socket)}
  cp.spawn(process.execPath,["-e",${JSON.stringify(child)},crypto.randomUUID()],{detached:true,stdio:"ignore",env:{PATH:process.env.PATH||"/usr/bin:/bin"}}).unref();
  for(let tries=0;tries<100;tries++){try{processEvidence=await request("GET",challenge);break}catch(e){
   if(!["ENOENT","ECONNREFUSED"].includes(e.code))throw e;await new Promise(r=>setTimeout(r,50));
  }}
  if(!processEvidence)throw Error("Owned probe did not start");
 }
}
if(mode==="dispose"){if(rootfsEvidence)fs.unlinkSync(rootfsPath);console.log(JSON.stringify({disposed:true}));return}
function file(path){return {path,sha256:crypto.createHash("sha256").update(fs.readFileSync(path)).digest("hex"),
 gitStatus:cp.execFileSync("git",["status","--porcelain","--untracked-files=all","--",path],{encoding:"utf8"}).trimEnd()}}
let appStatus=0;const until=Date.now()+30000;
while(Date.now()<until){try{appStatus=(await fetch(${JSON.stringify(appURL.href)},{signal:AbortSignal.timeout(1000)})).status}catch{}
 if(appStatus===200)break;await new Promise(r=>setTimeout(r,250))}
if(appStatus!==200)throw Error("Starter App did not become healthy");
const bootID=(process.platform==="linux"?fs.readFileSync("/proc/sys/kernel/random/boot_id","utf8"):
 cp.execFileSync("sysctl",["-n","kern.bootsessionuuid"],{encoding:"utf8"})).trim().toLowerCase();
console.log(JSON.stringify({process:{...processEvidence,bootID},rootfs:rootfsEvidence,appStatus,
 dirtySource:file(${JSON.stringify(probe.dirtyPath)}),stagedSource:file(${JSON.stringify(probe.stagedPath)}),
 untrackedSource:file(${JSON.stringify(probe.untrackedPath)})}));
})().catch(error=>{console.error(error);process.exitCode=1})`);
}

export function starterRuntimeTerminalURL(base: string, attemptID: string) {
  return ownedRuntimeTerminalURL(base, attemptID);
}

const starterRuntimeTerminal = ownedRuntimeTerminal;

async function starterRuntimePreview(input: {
  browser: Browser;
  base: string;
  cookie: string;
  previewID: string;
  heading: string;
  screenshot: string;
  initialScreenshot?: string;
}) {
  const { browser, base, cookie, previewID, heading, screenshot, initialScreenshot } = input;
  const appOrigin = appRuntimeOrigin(base, previewID, "app");
  const runtimeCookie = await runtimeAccessCookie(base, cookie, previewID, "app");
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  try {
    if (initialScreenshot) {
      const clientResponse = await fetch(`${appOrigin}/@vite/client`, {
        headers: { cookie: runtimeCookie },
        signal: AbortSignal.timeout(10_000),
      });
      expect(clientResponse.status).toBe(200);
      expect(await clientResponse.text()).toContain("WebSocket");
    }
    await context.addCookies(
      runtimeCookie.split("; ").map((part) => ({
        name: part.slice(0, part.indexOf("=")),
        value: part.slice(part.indexOf("=") + 1),
        url: appOrigin,
      })),
    );
    const page = await context.newPage();
    const errors: string[] = [];
    let hmrConnected = false;
    const hmrEvents: string[] = [];
    page.on("websocket", (socket) => {
      if (hmrEvents.length < 12) hmrEvents.push(`open ${new URL(socket.url()).pathname}`);
      socket.on("socketerror", (error) => {
        if (hmrEvents.length < 12) hmrEvents.push(`error ${String(error).slice(0, 200)}`);
      });
      socket.on("close", () => {
        if (hmrEvents.length < 12) hmrEvents.push("closed");
      });
      socket.on("framereceived", ({ payload }) => {
        if (String(payload) === '{"type":"connected"}') hmrConnected = true;
      });
    });
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("response", (response) => {
      if (response.status() >= 400 && !response.url().includes("/api/session"))
        errors.push(`HTTP ${response.status()} ${new URL(response.url()).pathname}`);
    });
    expect((await page.goto(`${appOrigin}/`))?.status()).toBe(200);
    if (initialScreenshot) {
      try {
        await visible.poll(() => hmrConnected, { timeout: 10000 }).toBe(true);
      } catch {
        throw new Error(`Starter HMR did not connect: ${JSON.stringify(hmrEvents)}`);
      }
      await page.screenshot({ path: initialScreenshot, animations: "disabled" });
    }
    await page.getByRole("button", { name: "Create an account", exact: true }).click();
    await page
      .getByLabel("Name", { exact: true })
      .fill(initialScreenshot ? "Starter member" : "Delivered Starter member");
    await page.getByLabel("Email", { exact: true }).fill(`${crypto.randomUUID()}@starter.test`);
    await page.getByLabel("Password", { exact: true }).fill(crypto.randomUUID());
    await page.getByRole("button", { name: "Create account", exact: true }).click();
    await visible(page.getByRole("heading", { name: heading, exact: true })).toBeVisible();
    await page.reload();
    await visible(page.getByRole("heading", { name: heading, exact: true })).toBeVisible();
    await page.screenshot({ path: screenshot, animations: "disabled" });
    await page.getByRole("button", { name: "Sign out", exact: true }).click();
    await visible(page.getByRole("button", { name: "Sign in", exact: true })).toBeVisible();
    expect(errors).toEqual([]);
  } finally {
    await context.close();
  }
}

// No listener, Forgejo, database, browser or native installation is created
// here. Only the normal authenticated product commands admit Project work.
export async function starterRuntimeJourney(input: StarterRuntimeJourneyInput) {
  const {
    base,
    cookie,
    database,
    artifacts,
    artifactDirectory,
    nativeRead,
    browser,
    evidenceDirectory,
    ownership,
  } = input;
  const restoreFidelity = z
    .enum(["SNAPSHOT_FIDELITY_MEMORY", "SNAPSHOT_FIDELITY_ROOTFS"])
    .parse(input.restoreFidelity ?? "SNAPSHOT_FIDELITY_MEMORY");
  z.string().min(1).parse(ownership.factoryID);
  z.string().min(1).parse(ownership.databaseName);
  z.string()
    .regex(/^owned-starter-[a-f0-9]{8}$/)
    .parse(ownership.slug);
  let { projectID, setupID } = ownership;
  const retained = Boolean(projectID);
  if (retained) {
    z.uuid().parse(projectID);
    z.uuid().parse(setupID);
  } else if (setupID) {
    throw Error("A new Starter journey requires an unused setup identity");
  }
  if (input.restartPreview && !retained)
    throw Error("Preview recovery requires the exact retained installation");
  const slug = ownership.slug;
  const [scope] = await database.client<{ name: string }[]>`SELECT current_database() AS name`;
  expect(scope?.name).toBe(ownership.databaseName);
  const timings: Record<string, number> = {};
  let terminal: Awaited<ReturnType<typeof starterRuntimeTerminal>> | undefined;
  let lifecycle: Awaited<ReturnType<typeof connectStarterNativeLifecycle>> | undefined;
  let cleanupProbe: (() => Promise<void>) | undefined;
  const attempts = () =>
    database.client<
      { id: string; state: string; failure: string | null }[]
    >`SELECT id,state,failure FROM factory.runtime_attempt WHERE project_id=${projectID}`;
  async function ready(id: string) {
    return eventually(
      async () => {
        const row = (await attempts()).find((row) => row.id === id);
        if (row && ["failed", "cleanup-failed"].includes(row.state))
          throw new Error(row.failure ?? "Starter runtime failed");
        return row;
      },
      (row) => row?.state === "ready",
      "Starter runtime not ready",
      900_000,
    );
  }
  try {
    await mkdir(evidenceDirectory, { recursive: true });
    const started = performance.now();
    if (!retained) {
      const draft = await serverCall(callFactoryFunction(base, "beginSetupDraft", [], { cookie }));
      if (!draft) throw new Error("Owned Starter setup draft missing");
      setupID = ownership.setupID = draft.id;
      const saved = await serverCall(
        callFactoryFunction(
          base,
          "saveSetupDraft",
          [
            {
              id: setupID,
              version: draft.version,
              name: "Turnkey Starter",
              slug,
              kind: "starter",
              sourceURL: "",
            },
          ],
          { cookie },
        ),
      );
      const created = await serverCall(
        callFactoryFunction(
          base,
          "createSetupProject",
          [
            {
              id: setupID,
              version: saved.version,
              commandID: crypto.randomUUID(),
            },
          ],
          { cookie },
        ),
      );
      expect(created.state).toBe("created");
      if (!created.projectID) throw new Error("Created Starter Project identity missing");
      projectID = ownership.projectID = created.projectID;
    }
    const [ownedProject] = await database.client<{ actorTemplatePath: string }[]>`
    SELECT project.actor_template_path AS "actorTemplatePath"
    FROM factory.project project
    JOIN factory.operation intent
      ON intent.kind='projects.repository_intent'
     AND intent.scope_type='project'
     AND intent.scope_id=project.id::text
    WHERE project.id=${projectID} AND project.slug=${slug} AND intent.payload->>'setupId'=${setupID}`;
    if (!ownedProject) throw Error("Retained Starter Project/setup ownership differs");
    expect(ownedProject.actorTemplatePath).toBe(".factory/actor-template.json");
    if (input.desktopProof)
      await starterSetupDesktop({ browser, base, cookie, projectID, database });
    if (input.restartPreview) {
      if (!retained) throw new Error("Preview recovery requires the exact retained installation");
      const [preview] = await database.client<{ id: string; state: string }[]>`
      SELECT attempt.id,attempt.state FROM factory.operation preview
      JOIN factory.runtime_attempt attempt ON attempt.id::text=preview.payload->>'runtimeAttemptId'
      WHERE preview.kind='delivery.staging_preview' AND preview.scope_type='project'
        AND preview.scope_id=${projectID} AND attempt.project_id=${projectID}
        AND attempt.workspace_id IS NULL AND attempt.isolated_kind='staging'`;
      if (!preview || preview.state === "ready")
        throw new Error("Preview recovery requires an unavailable owned Main-Preview");
      expect(
        await database.client`SELECT id FROM factory.agent_turn WHERE project_id=${projectID} AND change_id IS NOT NULL`,
      ).toHaveLength(0);
      // Isolated Main Preview cleanup is not the retained Workspace halt path.
      await serverCall(
        callFactoryFunction(
          base,
          "stopRuntimeAttempt",
          [preview.id],
          { cookie, origin: base, "content-type": "application/json" },
          AbortSignal.timeout(180_000),
        ),
      );
      await eventually(
        async () => (await attempts()).find((row) => row.id === preview.id)?.state,
        (state) => state === "stopped",
        "Owned unavailable Preview did not Stop",
        150_000,
      );
      await serverCall(
        callFactoryFunction(base, "retrySetupTask", [projectID, "main-preview"], {
          cookie,
        }),
      );
      console.log(
        JSON.stringify({ recoveredOwnedPreview: preview.id, operation: "Stop and setup retry" }),
      );
    }
    if (input.delivery === "only") {
      await eventually(
        () => serverCall(callFactoryFunction(base, "getSetupReadiness", [projectID], { cookie })),
        (rows) =>
          ["protection", "development-secrets"].every((task) =>
            rows.some(
              (row: { task: string; state: string }) => row.task === task && row.state === "ready",
            ),
          ),
        "Starter delivery prerequisites not ready",
        60000,
      );
      const delivered = await starterDelivery({
        database,
        projectID,
        base,
        cookie,
      });
      if (!delivered.previewID) throw new Error("Delivered preview missing");
      await starterRuntimePreview({
        browser,
        base,
        cookie,
        previewID: delivered.previewID,
        heading: "Welcome home.",
        screenshot: join(evidenceDirectory, "starter-delivered-home.png"),
      });
      console.log(JSON.stringify({ journey: "Starter native", scope: "explicit-delivery-only" }));
      return {
        journey: "Starter native",
        scope: "explicit-delivery-only",
        factoryID: ownership.factoryID,
        base,
        databaseName: ownership.databaseName,
        projectID,
        setupID,
        previewID: delivered.previewID,
      };
    }
    // Setup may start a separate Main Preview. Independent personal Source
    // must be usable without waiting for that App or starting personal compute.
    const sourceStarted = performance.now();
    const source = await serverCall(
      callFactoryFunction(base, "ensurePersonalSource", [projectID], { cookie }),
    );
    await eventually(
      () =>
        serverCall(
          callFactoryFunction(base, "getWorkspaceSource", [source.workspaceID], {
            cookie,
          }),
        ),
      (row) => row.state === "ready",
      "Starter source not ready",
      120_000,
    );
    timings["sourceMS"] = Math.round(performance.now() - sourceStarted);
    lifecycle = await connectStarterNativeLifecycle(base, cookie);
    const sourceOnly = await lifecycle.workspace(source.workspaceID);
    expect(sourceOnly.workspaceID).toBe(source.workspaceID);
    if (sourceOnly.runtime && sourceOnly.runtime.state !== "stopped")
      throw Error(
        "Saved-Source-before-compute proof requires an unstarted or explicitly stopped owned personal Workspace; active retained compute was not changed",
      );
    let templateFile = await lifecycle.file(source.workspaceID, ownedProject.actorTemplatePath);
    const selectedTemplate = starterSnapshotPreference(templateFile.content, restoreFidelity);
    if (selectedTemplate !== templateFile.content) {
      if (sourceOnly.runtime)
        throw Error(
          "Snapshot preference must be declared before the owned Workspace's first Start",
        );
      await writeFile(
        join(evidenceDirectory, "template-preference-intent.json"),
        JSON.stringify({
          projectID,
          workspaceID: source.workspaceID,
          path: ownedProject.actorTemplatePath,
          observedVersion: templateFile.version,
          restoreFidelity,
          intendedAt: new Date().toISOString(),
        }),
        { flag: "wx", mode: 0o600 },
      );
      await lifecycle.save(
        source.workspaceID,
        ownedProject.actorTemplatePath,
        selectedTemplate,
        templateFile.version,
      );
      templateFile = await lifecycle.file(source.workspaceID, ownedProject.actorTemplatePath);
      expect(templateFile.content).toBe(selectedTemplate);
    }
    requireStarterNativeContract(templateFile.content, artifacts);
    const sourcePath = "src/db/schema.ts";
    const original = await lifecycle.file(source.workspaceID, sourcePath);
    const savedContent = `${original.content}\n// Owned Starter Source ${crypto.randomUUID()}\n`;
    await lifecycle.save(source.workspaceID, sourcePath, savedContent, original.version);
    const savedSource = await lifecycle.file(source.workspaceID, sourcePath);
    expect(savedSource.content).toBe(savedContent);
    expect(savedSource.version).not.toBe(original.version);
    expect((await lifecycle.workspace(source.workspaceID)).runtime).toEqual(sourceOnly.runtime);
    timings["savedSourceMS"] = Math.round(performance.now() - sourceStarted);
    const readinessAtSource = await serverCall(
      callFactoryFunction(base, "getSetupReadiness", [projectID], { cookie }),
    );
    const mainPreviewStateAtSource = readinessAtSource.find(
      (row) => row.task === "main-preview",
    )?.state;
    await writeFile(
      join(evidenceDirectory, "source-first.json"),
      JSON.stringify({
        factoryID: ownership.factoryID,
        base,
        databaseName: ownership.databaseName,
        projectID,
        workspaceID: source.workspaceID,
        sourceReadyMS: timings["sourceMS"],
        savedSourceMS: timings["savedSourceMS"],
        personalComputeState: sourceOnly.runtime?.state ?? "not-started",
        actorTemplateSHA256: createHash("sha256").update(templateFile.content).digest("hex"),
        savedSourceSHA256: createHash("sha256").update(savedContent).digest("hex"),
        mainPreviewStateAtSource: mainPreviewStateAtSource ?? "unknown",
        waitedForMainPreview: false,
      }),
    );
    await eventually(
      () => serverCall(callFactoryFunction(base, "getSetupReadiness", [projectID], { cookie })),
      (rows) =>
        rows.some(
          (row: { task: string; state: string }) =>
            row.task === "main-preview" && row.state === "ready",
        ),
      "Starter setup preview did not become ready",
      // Native image acquisition, Work preparation and PostgreSQL readiness
      // have distinct outcomes; the runtime owns its bounded startup failure.
      900_000,
    );
    timings["initialPreviewMS"] = Math.round(performance.now() - started);
    const [preview] = await database.client<
      { id: string }[]
    >`SELECT payload->>'runtimeAttemptId' AS id FROM factory.operation
      WHERE kind='delivery.staging_preview' AND scope_type='project' AND scope_id=${projectID}`;
    if (!preview) throw new Error("Starter preview missing");
    await starterRuntimePreview({
      browser,
      base,
      cookie,
      previewID: preview.id,
      heading: "You're home.",
      initialScreenshot: join(evidenceDirectory, "starter-native-initial.png"),
      screenshot: join(evidenceDirectory, "starter-native-home.png"),
    });
    const runtimeStarted = performance.now();
    const request = (phase: z.infer<typeof requestScope>["phase"], action: "start" | "pause") =>
      starterLifecycleRequest(evidenceDirectory, {
        factoryID: ownership.factoryID,
        databaseName: ownership.databaseName,
        projectID,
        workspaceID: source.workspaceID,
        phase,
        action,
      });
    const initialRequestID = await request("initial-start", "start");
    const runtime = await lifecycle.start(source.workspaceID, initialRequestID);
    await ready(runtime.id);
    const running = (await lifecycle.workspace(source.workspaceID)).runtime;
    expect(running).toMatchObject({
      id: runtime.id,
      projectId: projectID,
      workspaceId: source.workspaceID,
      workspaceKind: "personal",
      state: "ready",
      native: { engine: "substrate", state: "ACTOR_STATE_RUNNING" },
    });
    const initialBinding = await readNativeWorkspaceObservation(database, {
      attemptID: runtime.id,
      projectID,
      workspaceID: source.workspaceID,
      actorUID: z.uuid().parse(running?.native?.actorUID),
    });
    const [admittedTemplate] = await database.client<{ template: unknown; templateUID: string }[]>`
    SELECT intent->'projectTemplate' AS template,
      (SELECT binding_intent->>'templateUID' FROM factory.runtime_attempt
        WHERE id=${runtime.id}) AS "templateUID"
    FROM factory.substrate_provision
    WHERE owner_id=${source.workspaceID} AND kind='workspace' AND generation=${initialBinding.generation}`;
    expect(admittedTemplate?.template).toMatchObject({
      path: ownedProject.actorTemplatePath,
      content: templateFile.content,
      sha256: createHash("sha256").update(templateFile.content).digest("hex"),
    });
    const binding: StarterLifecycleBinding = {
      ...initialBinding,
      templateUID: z.uuid().parse(admittedTemplate?.templateUID),
    };
    terminal = await starterRuntimeTerminal(base, cookie, runtime.id);
    timings["terminalMS"] = Math.round(performance.now() - runtimeStarted);
    expect(await terminal.evaluate<string>("return process.cwd()")).toBe("/workspace/project");
    expect(
      await terminal.evaluate<string>(
        "return require('node:child_process').execFileSync('git',['--version'],{encoding:'utf8'}).trim()",
      ),
    ).toMatch(/^git version /);
    expect(
      await terminal.evaluate<boolean>(
        "return !!process.env.DATABASE_URL && !!process.env.BETTER_AUTH_SECRET",
      ),
    ).toBe(true);
    const activeTerminal = terminal;
    await eventually(
      () =>
        activeTerminal.evaluate<number>(
          "try{return (await fetch('http://127.0.0.1:4300/health',{signal:AbortSignal.timeout(1000)})).status}catch{return 0}",
        ),
      (status) => status === 200,
      "Starter development App did not become healthy",
      30_000,
    );
    expect(
      await terminal.evaluate<boolean>("return require('fs').existsSync('src/db/schema.ts')"),
    ).toBe(true);
    const [settings] =
      await database.client`SELECT payload->'manifest' AS manifest FROM factory.operation
        WHERE kind='environments.environment' AND scope_type='project' AND scope_id=${projectID}
          AND idempotency_key=${`environments.environment:${projectID}:development`}`;
    expect(settings?.["manifest"].variables).toHaveLength(3);
    const assertSource = (content: string) => {
      const script = `const assert=require("node:assert/strict"),fs=require("node:fs");
assert.equal(fs.readFileSync(${JSON.stringify(sourcePath)},"utf8"),${JSON.stringify(content)});
assert.equal(fs.readFileSync(${JSON.stringify(ownedProject.actorTemplatePath)},"utf8"),${JSON.stringify(templateFile.content)});
console.log("saved-source-confirmed");`;
      return `node -e 'eval(Buffer.from("${Buffer.from(script).toString("base64")}","base64").toString())'`;
    };
    const imported = await lifecycle.command({
      workspaceID: source.workspaceID,
      attemptID: runtime.id,
      command: assertSource(savedContent),
    });
    expect(imported.stdout).toContain("saved-source-confirmed");
    terminal.close();
    terminal = undefined;
    const tools = lifecycle;
    const commands = [imported];
    const probe: StarterProbe = {
      id: initialRequestID,
      dirtyPath: sourcePath,
      stagedPath: `owned-starter-${initialRequestID}-staged.txt`,
      untrackedPath: `owned-starter-${initialRequestID}-untracked.txt`,
    };
    cleanupProbe = async () => {
      const observed = (await tools.workspace(binding.workspaceID)).runtime;
      if (observed?.id !== binding.attemptID)
        throw Error("Owned Starter probe cleanup requires the original Attempt");
      if (observed.state === "paused") {
        // Never wake retained compute just to clean up a proof process. Its
        // deadline and exact socket remain owned by this retained fixture.
        await writeFile(
          join(evidenceDirectory, "probe-cleanup-deferred.json"),
          JSON.stringify({ binding, probe, reason: "original Actor remains paused" }, null, 2),
          { mode: 0o600 },
        );
        return;
      }
      if (observed.state !== "ready") throw Error("Owned Starter probe cleanup is unconfirmed");
      await tools.command({
        workspaceID: binding.workspaceID,
        attemptID: binding.attemptID,
        command: starterProbeCommand(probe, "dispose"),
      });
    };
    commands.push(
      await tools.command({
        workspaceID: binding.workspaceID,
        attemptID: binding.attemptID,
        command:
          nodeCommand(`const fs=require("node:fs"),assert=require("node:assert/strict"),cp=require("node:child_process");
for(const path of ${JSON.stringify([probe.stagedPath, probe.untrackedPath])}){
 const content="Owned Starter "+path+"\\n";
 try{fs.writeFileSync(path,content,{flag:"wx"})}catch(e){if(e.code!=="EEXIST")throw e;assert.equal(fs.readFileSync(path,"utf8"),content)}
}
cp.execFileSync("git",["add","--",${JSON.stringify(probe.stagedPath)}]);`),
      }),
    );
    const observe = () => readStarterRetainedObservation(database, nativeRead, binding);
    let previousProcess: StarterProbe["previousProcess"];
    const inspect = async (mode: "create" | "observe" | "restart") => {
      const retained = await tools.command({
        workspaceID: binding.workspaceID,
        attemptID: binding.attemptID,
        command: assertSource(savedContent),
      });
      expect(retained.stdout).toContain("saved-source-confirmed");
      const checked = await tools.command({
        workspaceID: binding.workspaceID,
        attemptID: binding.attemptID,
        command: "npm run check",
      });
      expect(checked.stdout).toContain("fail 0");
      expect(checked.stdout).toContain("tsc --noEmit");
      timings["compilerTestsMS"] ??= checked.elapsedMS;
      const inspected = await tools.command({
        workspaceID: binding.workspaceID,
        attemptID: binding.attemptID,
        command: starterProbeCommand(
          {
            ...probe,
            ...(previousProcess ? { previousProcess } : {}),
          },
          mode,
        ),
      });
      commands.push(retained, checked, inspected);
      const observed = starterActiveObservationSchema.parse({
        ...(await observe()),
        ...JSON.parse(inspected.stdout),
        compiler: checked,
      });
      previousProcess = { pid: observed.process.pid, instanceID: observed.process.instanceID };
      return observed;
    };
    const before = await inspect("create");
    const cycle = {
      binding,
      tools,
      observe,
      inspect,
      request,
      ready: () => ready(binding.attemptID),
      sourcePath,
      sourceContent: savedContent,
      evidenceDirectory,
    };
    const restored = await starterRetainedCycle({
      ...cycle,
      before,
      fidelity: restoreFidelity,
    });
    const retainedBinding = await readNativeWorkspaceObservation(database, binding);
    expect(retainedBinding.actorUID).toBe(initialBinding.actorUID);
    expect(retainedBinding.attemptID).toBe(initialBinding.attemptID);
    expect(retainedBinding.generation).toBe(initialBinding.generation);
    const disposeProbe = cleanupProbe;
    cleanupProbe = undefined;
    await disposeProbe();
    const receipt = {
      journey: "Starter native",
      scope: "authenticated-starter-product-live",
      factoryID: ownership.factoryID,
      base,
      databaseName: ownership.databaseName,
      projectID,
      workspaceID: source.workspaceID,
      artifactDirectory,
      artifacts,
      initialBinding,
      retainedBinding,
      actorTemplateSHA256: createHash("sha256").update(templateFile.content).digest("hex"),
      retainedSourceSHA256: createHash("sha256").update(savedContent).digest("hex"),
      savedSourceBeforeCompute: true,
      mainPreviewStateAtSource: mainPreviewStateAtSource ?? "unknown",
      pauseResume: true,
      passiveObservationWithoutWake: true,
      wakeOnCurrentFileAccess: restoreFidelity === "SNAPSHOT_FIDELITY_ROOTFS",
      originalActorRetained: true,
      destructiveDisposal: false,
      restoreFidelity,
      restored,
      commands: commands.map(({ stdout, stderr, ...result }) => ({
        ...result,
        stdoutBytes: Buffer.byteLength(stdout),
        stderrBytes: Buffer.byteLength(stderr),
      })),
      timings,
    };
    await writeFile(
      join(evidenceDirectory, "native-lifecycle.json"),
      JSON.stringify(receipt, null, 2),
    );
    console.log(JSON.stringify(receipt));
    if (input.delivery === "after-journey")
      await starterDelivery({ database, projectID, base, cookie });
    return receipt;
  } catch (cause) {
    try {
      await cleanupProbe?.();
    } catch (cleanupFailure) {
      throw new AggregateError(
        [cause, cleanupFailure],
        "Starter qualification and owned probe cleanup failed",
      );
    }
    throw cause;
  } finally {
    terminal?.close();
    await lifecycle?.close();
  }
}
