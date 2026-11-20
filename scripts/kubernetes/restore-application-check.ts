// Explicit application acceptance against an already restored, exclusively owned target.
// No installation, native lifecycle, repair SQL, model calls or retry of a write.
import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, realpath, rename, writeFile } from "node:fs/promises";
import * as https from "node:https";
import { isIP } from "node:net";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { checkServerIdentity } from "node:tls";
import { type Receipt as BackupReceipt, invocation, memberPath } from "./restore-rehearsal";
import { type ProjectReader, projectRows, readRestoredProjects } from "./restore-zero-projects";

const ownerLabel = "factory.restore-application.owner";
const backupAnnotation = "factory.restore-application.backup";
const sha = /^[a-f0-9]{64}$/;
const uuid = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/;
const name = /^[a-z0-9][a-z0-9-]{0,62}$/;
const functions = ["getBootstrap", "getTicketDetail", "saveTicketDocument"] as const;
const zeroImage =
  "docker.io/rocicorp/zero:1.12.0@sha256:213d3bc4c667458c2ca6b65c963db4e484298dc25586f3cd93033bbdeaf32cb1";
type FunctionName = (typeof functions)[number];
type Identity = { name: string; uid: string };
type Digest = { rows: number; sha256: string };
type Project = {
  id: string;
  name: string;
  slug: string;
  repositoryUrl: string;
  defaultBranch: string;
  devcontainerPath: string;
};
type Ticket = {
  id: string;
  projectId: string;
  title: string;
  description: string;
  state: string;
  version: number;
};
type Document = {
  id: string;
  ordinal: number;
  title: string;
  description: string;
  canonicalContent: string;
  contentDigest: string;
  requirementRevisionId: string | null;
};
type Revision = { id: string; ordinal: number; canonicalContent: string; contentDigest: string };
type Named = { name: string };
type OwnerReference = { controller?: boolean; kind: string; name: string; uid: string };
type Metadata = Identity & {
  deletionTimestamp?: string;
  labels?: Record<string, string>;
};
type Environment = { name: string; value?: string; valueFrom?: unknown };
type Snapshot = {
  readOnly: string;
  database: string;
  schema: string;
  busy: Record<string, number>;
  history: ApplicationWitnesses["history"];
  project: Project;
  ticket: Ticket;
  documents: Document[];
  requirements: Revision[];
  scope: string | null;
  source: { eligible: boolean; sha256: string };
  account: ApplicationFixture["account"];
  sessions: string[];
  saved: {
    id: string;
    ticketID: string;
    createdBy: string;
    authorKind: string;
    proposalEntryID: string | null;
  } | null;
};
type FunctionValues = {
  getBootstrap: {
    session: { user: { id: string; email: string }; systemManager: boolean } | null;
    zeroCacheURL: string;
    planningCacheScope: string;
  };
  getTicketDetail: { ticket: Ticket; documentRevisions: Document[]; revisions: Revision[] };
  saveTicketDocument: { id: string; ticketVersion: number; requirementRevisionId: string | null };
};
export type ApplicationWitnesses = {
  schema: 1;
  provenance: "independent-source-observation";
  backupWitnessDigest: string;
  schemaDigest: string;
  project: Project;
  ticket: Ticket;
  documents: Document[];
  requirements: Revision[];
  requirementRevisionID: string | null;
  history: Record<string, Digest>;
  source: {
    workspaceID: string;
    leaseSHA256: string;
    path: string;
    bytes: number;
    sha256: string;
  };
  git: {
    owner: string;
    repository: string;
    commit: string;
    path: string;
    bytes: number;
    sha256: string;
    blob: string;
  };
};
export type ApplicationFixture = {
  schema: 1;
  owner: string;
  exclusiveTarget: true;
  privateRoot: string;
  evidenceDirectory: string;
  kubeconfig: string;
  ca: string;
  password: string;
  forgeToken: string;
  account: { id: string; email: string };
  backup: { file: string; sha256: string };
  build: { file: string; sha256: string };
  witnesses: { file: string; sha256: string };
  source: { context: string; kubeSystemUID: string; ingress: Identity };
  target: {
    context: string;
    kubeSystemUID: string;
    namespace: Identity;
    deployment: Identity;
    applicationPod: Identity;
    postgresPod: Identity;
    forgejoPod: Identity;
    zeroPod: Identity;
    ingress: Identity;
    factoryService: Identity;
    postgresService: Identity;
    forgejoService: Identity;
    zeroService: Identity;
    configuration: Identity;
    credentials: Identity;
    address: string;
  };
  credentialHashes: Record<string, string>;
  save: { commandID: string; description: string };
  limits: { seconds: number; responseBytes: number };
};
type Build = {
  schema: 1;
  image: string;
  platformDigest: string;
  applicationRevision: string;
  treeSHA256: string;
  functions: Record<FunctionName, string>;
};
export type LoadedApplicationFixture = ApplicationFixture & {
  backupReceipt: BackupReceipt;
  buildEvidence: Build;
  expected: ApplicationWitnesses;
  caBytes: string;
  passwordValue: string;
  forgeTokenValue: string;
};
export type Command = (
  args: string[],
  input: string | undefined,
  signal: AbortSignal,
) => Promise<{ code: number; stdout: string }>;
export type HTTPRequest = {
  url: string;
  address: string;
  ca: string;
  method: "GET" | "POST";
  headers: Record<string, string>;
  body?: string;
  limit: number;
  signal: AbortSignal;
};
export type HTTPResponse = {
  status: number;
  headers: Record<string, string | string[]>;
  body: Uint8Array;
};
export type Wire = {
  serialize(args: unknown[]): Promise<string>;
  decode(response: Response): Promise<unknown>;
};
export type ApplicationReceipt = {
  schema: 1;
  owner: string;
  status: "incomplete" | "restored-application-passed";
  stage: string;
  probeSHA256: string;
  backupSHA256: string;
  buildSHA256: string;
  witnessesSHA256: string;
  sourceClusterUID: string;
  targetClusterUID: string;
  targetNamespaceUID: string;
  targetDeploymentUID: string;
  image: string;
  commandID: string;
  save: "not-sent" | "intended" | "confirmed" | "unconfirmed";
  logout: "not-needed" | "unconfirmed" | "confirmed";
  projectRead: "not-started" | "complete" | "failed";
  oldActors: "not-run-not-qualified";
  newCompute: "not-run-not-qualified";
};
const digest = (bytes: string | Uint8Array) => createHash("sha256").update(bytes).digest("hex");
function check(value: unknown): asserts value {
  if (!value) throw Error("Restore application prerequisite or observation refused");
}
export function originalRepository(
  repositoryURL: string,
  source: Pick<BackupReceipt["source"], "release" | "namespace" | "forgejoOrigin">,
) {
  check(name.test(source.release) && name.test(source.namespace));
  const url = new URL(repositoryURL);
  const internal = `http://${source.release}-forgejo.${source.namespace}.svc:3000`;
  check(
    [source.forgejoOrigin, internal].includes(url.origin) &&
      repositoryURL === `${url.origin}${url.pathname}`,
  );
  const match = /^\/([A-Za-z0-9_-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?$/.exec(url.pathname);
  const owner = match?.[1],
    repository = match?.[2];
  check(owner && repository && repository !== "." && repository !== "..");
  return { owner, repository };
}
function object(value: unknown): asserts value is Record<string, unknown> {
  check(value && typeof value === "object" && !Array.isArray(value));
}
function keys(value: unknown, names: string) {
  object(value);
  check(JSON.stringify(Object.keys(value).sort()) === JSON.stringify(names.split(" ").sort()));
}
function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.entries(value)
    .sort(([a], [b]) => a.localeCompare(b, "en"))
    .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
    .join(",")}}`;
}
const equal = (a: unknown, b: unknown) => canonical(a) === canonical(b);
export function restoredApplicationContainersMatch(template: unknown, pod: unknown): boolean {
  try {
    object(template);
    object(pod);
    check(
      (pod["serviceAccountName"] ?? "default") === (template["serviceAccountName"] ?? "default"),
    );
    if (equal(template["containers"], pod["containers"])) return true;
    check(
      Array.isArray(template["containers"]) &&
        Array.isArray(pod["containers"]) &&
        template["automountServiceAccountToken"] !== false &&
        pod["automountServiceAccountToken"] !== false &&
        Array.isArray(pod["volumes"]),
    );
    const expectedContainers = template["containers"];
    const podVolumes = pod["volumes"];
    const containers = pod["containers"].map((value, index) => {
      object(value);
      const expected = expectedContainers[index];
      object(expected);
      check(Array.isArray(value["volumeMounts"]));
      const mounts = value["volumeMounts"].filter((entry) => {
        object(entry);
        return entry["mountPath"] === "/var/run/secrets/kubernetes.io/serviceaccount";
      });
      check(mounts.length === 1);
      const mount = mounts[0];
      check(
        /^kube-api-access-[a-z0-9]{5}$/.test(mount.name) &&
          equal(mount, { name: mount.name, mountPath: mount.mountPath, readOnly: true }),
      );
      const volumes = podVolumes.filter((entry) => {
        object(entry);
        return entry["name"] === mount.name;
      });
      check(
        volumes.length === 1 &&
          equal(volumes[0], {
            name: mount.name,
            projected: {
              defaultMode: 420,
              sources: [
                { serviceAccountToken: { expirationSeconds: 3607, path: "token" } },
                {
                  configMap: {
                    name: "kube-root-ca.crt",
                    items: [{ key: "ca.crt", path: "ca.crt" }],
                  },
                },
                {
                  downwardAPI: {
                    items: [
                      {
                        path: "namespace",
                        fieldRef: { apiVersion: "v1", fieldPath: "metadata.namespace" },
                      },
                    ],
                  },
                },
              ],
            },
          }),
      );
      const normalized = {
        ...value,
        volumeMounts: value["volumeMounts"].filter((entry) => entry !== mount),
      };
      if (normalized.volumeMounts.length === 0 && expected["volumeMounts"] === undefined)
        delete (normalized as Record<string, unknown>)["volumeMounts"];
      return normalized;
    });
    // Nothing besides the API server's exact standard credential mount is ignored.
    return equal(containers, expectedContainers);
  } catch {
    return false;
  }
}
function select(value: unknown, example: Record<string, unknown>) {
  object(value);
  return Object.fromEntries(Object.keys(example).map((key) => [key, value[key]]));
}
async function privatePath(path: string, directory = false) {
  check(typeof path === "string" && isAbsolute(path) && resolve(path) === path);
  const info = await lstat(path);
  check(
    info.uid === process.getuid?.() &&
      !info.isSymbolicLink() &&
      (directory ? info.isDirectory() : info.isFile() && info.nlink === 1) &&
      (info.mode & 0o077) === 0 &&
      (await realpath(path)) === path,
  );
}
async function privateFile(root: string, path: string) {
  check(path.startsWith(`${root}/`));
  await privatePath(path);
  return readFile(path);
}
function identity(value: Identity) {
  keys(value, "name uid");
  check(name.test(value.name) && uuid.test(value.uid));
}
function origin(value: string) {
  const url = new URL(value);
  check(
    url.protocol === "https:" &&
      url.origin === value &&
      !url.port &&
      !isIP(url.hostname) &&
      !url.username &&
      !url.password,
  );
  return url;
}

// Deliberately conservative eligibility, not a general recovery classifier.
// Unknown/nonterminal external work fails closed. Historical unknown accounting is
// admitted only for the finalized owners audited below, with complete history witnesses.
export const idleRules: Record<string, string> = {
  agent_turn: "state::text NOT IN ('completed','failed','stopped')",
  knowledge_generation: "state::text NOT IN ('succeeded','failed')",
  change: "state::text NOT IN ('delivered','cancelled','failed')",
  change_agent_session: "stop_pending OR state::text NOT IN ('stopped','failed','committed')",
  change_writer: "state NOT IN ('unassigned','human','agent')",
  change_commit_operation: "state::text NOT IN ('succeeded','failed')",
  branch_create_operation: "state::text NOT IN ('succeeded','failed')",
  promotion_operation: "state::text NOT IN ('succeeded','failed')",
  pull_request_operation: "state::text NOT IN ('succeeded','failed')",
  merge_operation: "state::text NOT IN ('succeeded','failed')",
  verification: "state::text NOT IN ('succeeded','failed','cancelled')",
  runtime_attempt: "state::text <> 'stopped'",
  substrate_binding: "NOT create_rejected AND deleted_at IS NULL",
  substrate_source:
    "owner <> 'service' OR NOT writable OR checkpoint IS NULL OR service_base IS NULL",
  substrate_actor_rpc: "outcome IS NULL",
  substrate_input_stop: "completed_at IS NULL",
  substrate_worker_capacity: "NOT rejected AND pool IS NULL",
  runtime_compute_wait: "true",
  build_browser_session: "state <> 'closed'",
  implementation_order: "state NOT IN ('started','cancelled')",
  project_image_preparation: "state NOT IN ('succeeded','unsupported','failed')",
  project_setup_inspection: "state NOT IN ('complete','confirmed','superseded','failed')",
  project_setup_readiness: "state NOT IN ('ready','failed')",
  project_setup_draft: "state IN ('creating','checking')",
  project_repository_intent: "state NOT IN ('committed','failed')",
  model_role_probe: "state = 'probing'",
  model_connection_write: "state <> 'committed'",
  identity_setup: "state NOT IN ('active','superseded')",
  forge_account_intent: "state NOT IN ('ready','disabled')",
  forge_connection: "state <> 'ready'",
  forge_identity_intent: "state <> 'ready'",
  forge_branch_intent: "NOT confirmed",
  forge_grant_intent: "confirmed IS DISTINCT FROM desired",
  environment_write: "state NOT IN ('committed','discarded')",
  mcp_secret_write: "state NOT IN ('committed','superseded')",
  mcp_token_refresh: "state <> 'committed'",
  mcp_connect_intent: "true",
  monitoring_hook: "enabled",
  monitoring_incident: "state IN ('queued','diagnosing','implementing','uncertain')",
  learning_policy: "enabled",
  learning_trial: "true",
  learning_review: "state IN ('pending','running','uncertain')",
  learning_command: `input->>'kind'='review-now' AND NOT EXISTS (
    SELECT 1 FROM factory.learning_review review WHERE review.kind='work'
    AND review.project_id=(learning_command.input->>'projectId')::uuid
    AND review.owner_id IS NOT DISTINCT FROM
      (CASE WHEN learning_command.input->>'scope'='personal' THEN learning_command.actor_id END)
    AND review.developer_only=(learning_command.input->>'developerOnly')::boolean
    AND review.created_at>learning_command.created_at)`,
  project_release: "state NOT IN ('published','failed')",
  release_access: "state NOT IN ('active','revoked')",
  release_attempt: "cleaned_at IS NULL",
  repository_mirror_command: "state NOT IN ('completed','acknowledged','failed')",
  personal_git_operation: "state NOT IN ('succeeded','failed')",
  workspace_command: "state NOT IN ('exited','cancelled','failed','interrupted')",
  workspace_file_operation: "completed_at IS NULL",
  workspace_file_transfer: "state <> 'released'",
  workspace_terminal_operation: "completed_at IS NULL",
  workspace_lifecycle_command: "completed_at IS NULL",
  // workspace/submission.ts recovers only commit-intended/push-intended operations.
  // Admit confirmed pushes or its exact definite pre-push failures, never an uncertain push.
  workspace_submission: `NOT EXISTS (
    SELECT 1 FROM factory.change_commit_operation operation
    JOIN factory.runtime_attempt attempt ON attempt.id=operation.runtime_attempt_id
    JOIN factory.development_workspace workspace ON workspace.id=attempt.workspace_id
    WHERE operation.id=workspace_submission.id AND operation.source='workspace'
      AND operation.created_by=workspace_submission.actor_id
      AND operation.idempotency_key='workspace:'||CAST(workspace_submission.id AS text)
      AND workspace.id=workspace_submission.workspace_id AND workspace.kind='ticket'
      AND workspace.change_id=operation.change_id AND operation.completed_at IS NOT NULL
      AND workspace_submission.prepare_attempted_at IS NOT NULL
      AND ((operation.state='succeeded' AND operation.last_error IS NULL
        AND operation.commit_sha IS NOT NULL AND operation.observed_remote_sha=operation.commit_sha)
      OR (operation.state='failed' AND operation.commit_sha IS NULL AND operation.observed_remote_sha IS NULL
        AND operation.last_error IN ('workspace has no changes to commit',
          'workspace HEAD no longer matches the commit intent',
          'an ordinary commit cannot accept an unadmitted merge'))))`,
  workspace_share_decision: "access_reconciled_at IS NULL",
  developer_ide: "state <> 'stopped'",
  candidate_review: "state NOT IN ('passed','changes-requested','failed')",
  session_archive: "state <> 'saved'",
  access_revocation: "processed_version <> version",
  wiki_source_update: "hook_state <> 'ready' OR event_version <> handled_version",
  // Model recovery touches only probing rows; Wiki recovery touches only running generations.
  // Neither replays a finalized owner. Do not generalize this to turn:* Coding journals:
  // usage/record-opencode.ts can still drain or markUnavailable after settlement.
  usage_operation: `settled_at IS NULL OR outcome IS NULL
    OR outcome NOT IN ('completed','failed','interrupted','unknown')
    OR (outcome='unknown' AND (NOT EXISTS (
      SELECT 1 FROM factory.usage_entry entry WHERE entry.operation_id=usage_operation.id
        AND entry.source='unobserved' AND entry.outcome='unknown') OR NOT (
      (purpose='probe' AND project_id IS NULL AND EXISTS (
        SELECT 1 FROM factory.model_role_probe probe
        WHERE usage_operation.id='probe:'||CAST(probe.command_id AS text)
          AND probe.state IN ('finished','uncertain') AND probe.finished_at IS NOT NULL
          AND probe.result IS NOT NULL AND usage_operation.user_id=probe.created_by
          AND usage_operation.model=probe.model_id
          AND usage_operation.engine=CASE WHEN probe.role='build' THEN 'opencode' ELSE 'mastra' END))
      OR (purpose='wiki' AND engine='mastra' AND EXISTS (
        SELECT 1 FROM factory.knowledge_generation generation
        WHERE usage_operation.id LIKE 'wiki:'||CAST(generation.id AS text)||':_%:_%'
          AND generation.state IN ('succeeded','failed') AND generation.completed_at IS NOT NULL
          AND usage_operation.project_id=generation.project_id
          AND usage_operation.user_id=generation.created_by)))))`,
  installation_maintenance: "enabled",
  ticket: "trash_stop_pending",
};
export const historyTables = [
  "requirement_revision",
  "requirement_approval",
  "technical_design_revision",
  "substrate_binding",
  "substrate_source",
  "substrate_workspace",
  "substrate_capacity_installation",
  "substrate_worker_capacity",
  "substrate_actor_rpc",
  "substrate_input_stop",
  "runtime_attempt",
  "substrate_prebuild",
  "substrate_verification",
  "substrate_isolated",
  "development_workspace",
  "agent_turn",
  "change",
  "change_writer",
  "change_agent_turn_intent",
  // Idle terminal workflow rows must not change during startup/read/save/logout.
  // Verification retry retains its failed receipt in execution_policy_command before
  // resetting the current Verification, so witness both, not just the latest result.
  "change_agent_session",
  "branch_create_operation",
  "pull_request_operation",
  "verification",
  "candidate_review",
  "review_scenario",
  "review_feedback",
  "review_feedback_message",
  "review_feedback_command",
  "delivery_approval",
  "merge_operation",
  "promotion_operation",
  "execution_policy_command",
  // Complete original rows, including failed submissions, unknown outcomes and replay cursors.
  // Both source observations and every restored snapshot must match these independent digests.
  "workspace_submission",
  "change_commit_operation",
  "usage_operation",
  "usage_entry",
  "usage_replay_cursor",
  "model_role_probe",
  "knowledge_generation",
];
export async function loadApplicationFixture(
  path: string,
  owner: string,
): Promise<LoadedApplicationFixture> {
  await privatePath(path);
  const f: ApplicationFixture = JSON.parse(await readFile(path, "utf8"));
  keys(
    f,
    "schema owner exclusiveTarget privateRoot evidenceDirectory kubeconfig ca password forgeToken account backup build witnesses source target credentialHashes save limits",
  );
  check(
    f.schema === 1 &&
      /^[a-f0-9]{32}$/.test(owner) &&
      f.owner === owner &&
      f.exclusiveTarget === true,
  );
  await privatePath(f.privateRoot, true);
  check(path === join(f.privateRoot, "application.json"));
  check(
    isAbsolute(f.evidenceDirectory) &&
      resolve(f.evidenceDirectory) === f.evidenceDirectory &&
      f.evidenceDirectory !== f.privateRoot &&
      !f.evidenceDirectory.startsWith(`${f.privateRoot}/`) &&
      !f.privateRoot.startsWith(`${f.evidenceDirectory}/`),
  );
  const parent = await lstat(dirname(f.evidenceDirectory));
  check(
    parent.isDirectory() &&
      parent.uid === process.getuid?.() &&
      (parent.mode & 0o022) === 0 &&
      (await realpath(dirname(f.evidenceDirectory))) === dirname(f.evidenceDirectory),
  );
  check(!(await lstat(f.evidenceDirectory).catch(() => null)));
  keys(f.source, "context kubeSystemUID ingress");
  keys(
    f.target,
    "context kubeSystemUID namespace deployment applicationPod postgresPod forgejoPod zeroPod ingress factoryService postgresService forgejoService zeroService configuration credentials address",
  );
  for (const cluster of [f.source, f.target]) {
    check(/^[A-Za-z0-9_.:-]+$/.test(cluster.context) && uuid.test(cluster.kubeSystemUID));
    identity(cluster.ingress);
  }
  check(
    f.source.context !== f.target.context &&
      f.source.kubeSystemUID !== f.target.kubeSystemUID &&
      isIP(f.target.address),
  );
  for (const key of [
    "namespace",
    "deployment",
    "applicationPod",
    "postgresPod",
    "forgejoPod",
    "zeroPod",
    "factoryService",
    "postgresService",
    "forgejoService",
    "zeroService",
    "configuration",
    "credentials",
  ] as const)
    identity(f.target[key]);
  keys(f.account, "id email");
  check(
    uuid.test(f.account.id) && typeof f.account.email === "string" && f.account.email.includes("@"),
  );
  keys(f.save, "commandID description");
  check(
    uuid.test(f.save.commandID) &&
      typeof f.save.description === "string" &&
      f.save.description.length <= 10000,
  );
  keys(f.limits, "seconds responseBytes");
  check(
    Number.isSafeInteger(f.limits.seconds) &&
      f.limits.seconds > 0 &&
      f.limits.seconds <= 3600 &&
      Number.isSafeInteger(f.limits.responseBytes) &&
      f.limits.responseBytes > 0 &&
      f.limits.responseBytes <= 16 * 1024 ** 2,
  );
  const inputs = await Promise.all(
    [f.backup, f.build, f.witnesses].map(async (entry) => {
      keys(entry, "file sha256");
      const bytes = await privateFile(f.privateRoot, entry.file);
      check(sha.test(entry.sha256) && digest(bytes) === entry.sha256);
      return JSON.parse(bytes.toString("utf8"));
    }),
  );
  const [backupReceipt, buildEvidence, expected] = inputs as [
    BackupReceipt,
    Build,
    ApplicationWitnesses,
  ];
  check(
    backupReceipt.schema === 1 &&
      /^[a-f0-9]{40}$/.test(backupReceipt.source.applicationRevision) &&
      sha.test(backupReceipt.witnessDigest) &&
      backupReceipt.owner === owner &&
      backupReceipt.status === "data-services-passed" &&
      backupReceipt.cleanup === "confirmed" &&
      backupReceipt.nativeActivation === "not-run-not-qualified" &&
      equal(backupReceipt.components, {
        postgres: "passed",
        forgejo: "passed",
        state: "passed",
        objects: "passed",
        openbao: "passed",
      }),
  );
  check(
    backupReceipt.source.namespace === f.target.namespace.name &&
      f.source.ingress.name === f.target.ingress.name &&
      f.target.namespace.uid !== backupReceipt.source.namespaceUID,
  );
  origin(backupReceipt.source.factoryOrigin);
  origin(backupReceipt.source.forgejoOrigin);
  check(backupReceipt.source.factoryOrigin !== backupReceipt.source.forgejoOrigin);
  keys(buildEvidence, "schema image platformDigest applicationRevision treeSHA256 functions");
  keys(buildEvidence.functions, functions.join(" "));
  check(
    buildEvidence.schema === 1 &&
      buildEvidence.applicationRevision === backupReceipt.source.applicationRevision &&
      /^[a-zA-Z0-9.:/_-]+@sha256:[a-f0-9]{64}$/.test(buildEvidence.image) &&
      sha.test(buildEvidence.platformDigest) &&
      sha.test(buildEvidence.treeSHA256) &&
      name.test(backupReceipt.source.release),
  );
  const ids = Object.values(buildEvidence.functions);
  check(
    new Set(ids).size === functions.length && ids.every((id) => /^[A-Za-z0-9_-]{1,200}$/.test(id)),
  );
  keys(
    expected,
    "schema provenance backupWitnessDigest schemaDigest project ticket documents requirements requirementRevisionID history source git",
  );
  check(
    expected.schema === 1 &&
      expected.provenance === "independent-source-observation" &&
      expected.backupWitnessDigest === backupReceipt.witnessDigest &&
      sha.test(expected.schemaDigest),
  );
  keys(expected.project, "id name slug repositoryUrl defaultBranch devcontainerPath");
  keys(expected.ticket, "id projectId title description state version");
  check(
    uuid.test(expected.project.id) &&
      uuid.test(expected.ticket.id) &&
      expected.ticket.projectId === expected.project.id &&
      Number.isSafeInteger(expected.ticket.version) &&
      expected.ticket.version > 0 &&
      f.save.description !== expected.ticket.description,
  );
  check(expected.requirementRevisionID === null || uuid.test(expected.requirementRevisionID));
  check(
    Array.isArray(expected.documents) &&
      expected.documents.length > 0 &&
      Array.isArray(expected.requirements),
  );
  for (const doc of expected.documents) {
    keys(doc, "id ordinal title description canonicalContent contentDigest requirementRevisionId");
    check(
      uuid.test(doc.id) &&
        Number.isSafeInteger(doc.ordinal) &&
        doc.ordinal > 0 &&
        digest(doc.canonicalContent) === doc.contentDigest,
    );
    JSON.parse(doc.canonicalContent);
  }
  for (const revision of expected.requirements) {
    keys(revision, "id ordinal canonicalContent contentDigest");
    check(
      uuid.test(revision.id) &&
        Number.isSafeInteger(revision.ordinal) &&
        revision.ordinal > 0 &&
        digest(revision.canonicalContent) === revision.contentDigest,
    );
  }
  for (const revisions of [expected.documents, expected.requirements]) {
    check(new Set(revisions.map((value) => value.id)).size === revisions.length);
    check(
      revisions.every(
        (value, index) =>
          value.id !== f.save.commandID &&
          (index === 0 || value.ordinal < (revisions[index - 1]?.ordinal ?? 0)),
      ),
    );
  }
  const latest = expected.documents[0];
  check(
    latest &&
      latest.requirementRevisionId === expected.requirementRevisionID &&
      expected.ticket.state !== "cancelled",
  );
  const requirement: unknown = JSON.parse(latest.canonicalContent);
  if (requirement === null) {
    check(expected.requirementRevisionID === null && expected.requirements.length === 0);
  } else {
    // Support a complete unchanged scope, not a document repair or a new revision.
    // This is the canonical shape in requirement-domain/src/requirement.ts.
    keys(requirement, "summary acceptanceCriteria nonGoals");
    object(requirement);
    const summary = requirement["summary"],
      criteria = requirement["acceptanceCriteria"],
      nonGoals = requirement["nonGoals"];
    check(
      typeof summary === "string" &&
        summary.trim() === summary &&
        summary.length > 0 &&
        summary.length <= 10000 &&
        Array.isArray(criteria) &&
        criteria.length > 0 &&
        criteria.length <= 100 &&
        Array.isArray(nonGoals) &&
        nonGoals.length <= 100,
    );
    for (const entries of [criteria, nonGoals])
      check(
        new Set(entries).size === entries.length &&
          entries.every(
            (value) =>
              typeof value === "string" &&
              value.trim() === value &&
              value.length > 0 &&
              value.length <= 2000,
          ),
      );
    check(
      latest.canonicalContent ===
        JSON.stringify({ acceptanceCriteria: criteria, nonGoals, summary }) &&
        expected.requirements.some(
          (revision) =>
            revision.id === expected.requirementRevisionID &&
            revision.canonicalContent === latest.canonicalContent,
        ) &&
        !["inbox", "backlog"].includes(expected.ticket.state),
    );
  }
  keys(
    expected.history,
    [...historyTables, "other_tickets", "old_documents", "protected_ticket"].join(" "),
  );
  for (const value of Object.values(expected.history)) {
    keys(value, "rows sha256");
    check(Number.isSafeInteger(value.rows) && value.rows >= 0 && sha.test(value.sha256));
  }
  keys(expected.source, "workspaceID leaseSHA256 path bytes sha256");
  keys(expected.git, "owner repository commit path bytes sha256 blob");
  check(uuid.test(expected.source.workspaceID) && sha.test(expected.source.leaseSHA256));
  for (const file of [expected.source, expected.git]) {
    memberPath(file.path);
    check(
      Number.isSafeInteger(file.bytes) &&
        file.bytes >= 0 &&
        file.bytes <= f.limits.responseBytes &&
        sha.test(file.sha256),
    );
  }
  check(
    /^[A-Za-z0-9_-]+$/.test(expected.git.owner) &&
      /^[A-Za-z0-9_.-]+$/.test(expected.git.repository) &&
      /^[a-f0-9]{40}$/.test(expected.git.commit) &&
      /^[a-f0-9]{40}$/.test(expected.git.blob),
  );
  const repository = originalRepository(expected.project.repositoryUrl, backupReceipt.source);
  check(
    repository.owner === expected.git.owner && repository.repository === expected.git.repository,
  );
  keys(
    f.credentialHashes,
    "auth-secret admin-password database-password zero-password webhook-secret",
  );
  check(Object.values(f.credentialHashes).every((value) => sha.test(value)));
  // Only self-contained JSON kubeconfigs. No credential plugins, proxies, mutable
  // external files or TLS bypasses are executed by this acceptance helper.
  const kubeconfig = JSON.parse((await privateFile(f.privateRoot, f.kubeconfig)).toString("utf8"));
  check(kubeconfig.apiVersion === "v1" && kubeconfig.kind === "Config");
  const servers: string[] = [];
  for (const context of [f.source.context, f.target.context]) {
    const contexts = kubeconfig.contexts?.filter((item: { name: string }) => item.name === context);
    check(contexts?.length === 1);
    const selected = contexts[0].context;
    const clusters = kubeconfig.clusters?.filter(
      (item: { name: string }) => item.name === selected.cluster,
    );
    const users = kubeconfig.users?.filter((item: { name: string }) => item.name === selected.user);
    check(clusters?.length === 1 && users?.length === 1);
    const cluster = clusters[0].cluster,
      user = users[0].user;
    keys(cluster, "server certificate-authority-data");
    const endpoint = new URL(cluster.server);
    check(
      endpoint.protocol === "https:" &&
        !endpoint.username &&
        !endpoint.password &&
        !endpoint.hash &&
        !endpoint.search &&
        base64(cluster["certificate-authority-data"])
          .toString("utf8")
          .includes("-----BEGIN CERTIFICATE-----"),
    );
    check(!base64(cluster["certificate-authority-data"]).toString("utf8").includes("PRIVATE KEY"));
    if ("token" in user) {
      keys(user, "token");
      check(typeof user.token === "string" && user.token.length > 0 && !/[\r\n]/.test(user.token));
    } else {
      keys(user, "client-certificate-data client-key-data");
      check(
        base64(user["client-certificate-data"])
          .toString("utf8")
          .includes("-----BEGIN CERTIFICATE-----") &&
          base64(user["client-key-data"]).toString("utf8").includes("PRIVATE KEY"),
      );
    }
    servers.push(endpoint.href);
  }
  check(servers[0] !== servers[1]);
  const caBytes = (await privateFile(f.privateRoot, f.ca)).toString("utf8");
  check(caBytes.includes("-----BEGIN CERTIFICATE-----") && !caBytes.includes("PRIVATE KEY"));
  const passwordValue = (await privateFile(f.privateRoot, f.password))
    .toString("utf8")
    .replace(/\r?\n$/, "");
  const forgeTokenValue = (await privateFile(f.privateRoot, f.forgeToken)).toString("utf8").trim();
  check(passwordValue.length > 0 && /^[A-Za-z0-9_-]{20,256}$/.test(forgeTokenValue));
  return { ...f, backupReceipt, buildEvidence, expected, caBytes, passwordValue, forgeTokenValue };
}

// Hash before importing the fixed, verified compiler entry for the same introspection
// used by test/fixtures/server-functions.ts. Never invoke any Factory function.
export async function applicationBuildTree(expectedTree: string) {
  const fs = await import("node:fs/promises");
  const { createHash } = await import("node:crypto");
  const root = "/opt/factory/apps/factory/dist";
  const files: string[] = [];
  async function walk(path: string) {
    for (const entry of await fs.readdir(`${root}/${path}`, { withFileTypes: true })) {
      const file = `${path}${entry.name}`;
      if (entry.isDirectory()) await walk(`${file}/`);
      else if (entry.isFile()) files.push(file);
      else throw Error("Unsupported build tree");
    }
  }
  await walk("");
  if (!files.includes("server/entry.js")) throw Error("Missing built handler");
  const hash = createHash("sha256");
  for (const file of files.sort()) {
    const bytes = await fs.readFile(`${root}/${file}`);
    hash.update(`${file}\0${createHash("sha256").update(bytes).digest("hex")}\n`);
  }
  const treeSHA256 = hash.digest("hex");
  if (treeSHA256 !== expectedTree) throw Error("Built application changed");
  const installation = JSON.parse(
    await fs.readFile("/var/lib/factory/kubernetes-installation.json", "utf8"),
  );
  const ready = JSON.parse(await fs.readFile("/var/lib/factory/kubernetes-ready.json", "utf8"));
  const entrypoint = "/opt/factory/apps/factory/dist/server/entry.js";
  const entry = await import(entrypoint);
  const functions = Object.fromEntries(
    ["getBootstrap", "getTicketDetail", "saveTicketDocument"].map((name) => [
      name,
      entry.compiledFunctionID(entry.factoryFunctions[name]),
    ]),
  );
  const environmentHashes = Object.fromEntries(
    [
      "FACTORY_BASE_URL",
      "FACTORY_FORGEJO_PUBLIC_URL",
      "FACTORY_FORGEJO_API_URL",
      "FACTORY_HELM_RELEASE",
      "FACTORY_STATE_DIRECTORY",
      "FACTORY_AUTH_SECRET",
      "FACTORY_ADMIN_PASSWORD",
      "FACTORY_DATABASE_PASSWORD",
      "FACTORY_WIKI_WEBHOOK_SECRET",
      "DATABASE_URL",
    ].map((name) => {
      const value = process.env[name];
      if (typeof value !== "string" || !value) throw Error("Missing inherited configuration");
      return [name, createHash("sha256").update(value).digest("hex")];
    }),
  );
  process.stdout.write(
    JSON.stringify({
      treeSHA256,
      installation,
      startupID: ready.startupID,
      functions,
      environmentHashes,
    }),
  );
}
function sqlDigest(query: string) {
  // Hash a JSONB array, ordered by canonical row JSONB text under C collation.
  return `(SELECT json_build_object('rows',count(*),'sha256',encode(factory.digest(convert_to(
    COALESCE(jsonb_agg(row ORDER BY row::text COLLATE "C"),'[]'::jsonb)::text,'UTF8'),'sha256'),'hex'))
    FROM (${query}) witness(row))`;
}
export function applicationSQL(f: LoadedApplicationFixture) {
  const w = f.expected;
  const t = `'${w.ticket.id}'::uuid`,
    p = `'${w.project.id}'::uuid`,
    s = `'${w.source.workspaceID}'::uuid`;
  const history: Record<string, string> = Object.fromEntries(
    historyTables.map((table) => [table, `SELECT to_jsonb(t) FROM factory.${table} t`]),
  );
  history["other_tickets"] = `SELECT to_jsonb(t) FROM factory.ticket t WHERE id<>${t}`;
  history["old_documents"] =
    `SELECT to_jsonb(t) FROM factory.ticket_document_revision t WHERE id<>'${f.save.commandID}'::uuid`;
  history["protected_ticket"] =
    `SELECT to_jsonb(t)-ARRAY['description','version','updated_at'] FROM factory.ticket t WHERE id=${t}`;
  return `BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;
SET LOCAL statement_timeout = '${f.limits.seconds * 1000}ms';
SET LOCAL timezone = 'UTC';
SET LOCAL extra_float_digits = 3;
SET LOCAL bytea_output = 'hex';
SELECT json_build_object(
 'readOnly',current_setting('transaction_read_only'),'database',current_database(),
 'schema',(SELECT source_digest FROM factory.schema_migration WHERE version=1),
 'busy',(SELECT json_object_agg(name,amount) FROM (${Object.entries(idleRules)
   .map(
     ([table, where]) =>
       `SELECT '${table}' AS name,count(*) AS amount FROM factory.${table} WHERE ${where}`,
   )
   .join(" UNION ALL ")}) busy),
 'history',json_build_object(${Object.entries(history)
   .map(([key, query]) => `'${key}',${sqlDigest(query)}`)
   .join(",")}),
 'project',(SELECT row_to_json(v) FROM (SELECT id,name,slug,repository_url AS "repositoryUrl",default_branch AS "defaultBranch",devcontainer_path AS "devcontainerPath" FROM factory.project WHERE id=${p}) v),
 'ticket',(SELECT row_to_json(v) FROM (SELECT id,project_id AS "projectId",title,description,state,version::integer FROM factory.ticket WHERE id=${t} AND trashed_at IS NULL AND converted_to_epic_id IS NULL) v),
 'documents',COALESCE((SELECT json_agg(v ORDER BY ordinal DESC) FROM (SELECT id,ordinal,title,description,canonical_content AS "canonicalContent",content_digest AS "contentDigest",requirement_revision_id AS "requirementRevisionId" FROM factory.ticket_document_revision WHERE ticket_id=${t}) v),'[]'::json),
 'requirements',COALESCE((SELECT json_agg(v ORDER BY ordinal DESC) FROM (SELECT id,ordinal,canonical_content AS "canonicalContent",content_digest AS "contentDigest" FROM factory.requirement_revision WHERE ticket_id=${t}) v),'[]'::json),
 'scope',COALESCE((SELECT requirement_revision_id FROM factory.requirement_approval WHERE ticket_id=${t}),
   (SELECT id FROM factory.requirement_revision WHERE ticket_id=${t} ORDER BY ordinal DESC LIMIT 1)),
 'source',(SELECT json_build_object('eligible',s.owner='service' AND s.writable AND s.service_base IS NOT NULL AND s.checkpoint IS NOT NULL AND w.substrate AND w.project_id=${p}
   AND EXISTS(SELECT 1 FROM factory.runtime_attempt a JOIN factory.substrate_binding b ON b.runtime_attempt_id=a.id
     WHERE a.workspace_id=s.workspace_id AND a.substrate AND a.state='stopped' AND b.actor_uid=s.actor_uid AND b.deleted_at IS NOT NULL),
   'sha256',encode(factory.digest(convert_to(to_jsonb(s)::text,'UTF8'),'sha256'),'hex'))
   FROM factory.substrate_source s JOIN factory.development_workspace w ON w.id=s.workspace_id WHERE s.workspace_id=${s}),
 'account',(SELECT row_to_json(v) FROM (SELECT id,email FROM auth."user" WHERE id='${f.account.id}'::uuid) v),
 'sessions',COALESCE((SELECT json_agg(id ORDER BY id) FROM auth.session WHERE user_id='${f.account.id}'::uuid),'[]'::json),
 'saved',(SELECT row_to_json(v) FROM (SELECT id,ticket_id AS "ticketID",created_by AS "createdBy",author_kind AS "authorKind",proposal_entry_id AS "proposalEntryID" FROM factory.ticket_document_revision WHERE id='${f.save.commandID}'::uuid) v)
);
COMMIT;`;
}

async function execute(args: string[], input: string | undefined, signal: AbortSignal) {
  const child = Bun.spawn(args, {
    env: { PATH: process.env["PATH"] ?? "" },
    stdin: input === undefined ? "ignore" : new Blob([input]),
    stdout: "pipe",
    stderr: "pipe",
  });
  const abort = () => child.kill("SIGKILL");
  signal.addEventListener("abort", abort, { once: true });
  if (signal.aborted) abort();
  try {
    const [code, stdout] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    signal.throwIfAborted();
    return { code, stdout };
  } finally {
    signal.removeEventListener("abort", abort);
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await child.exited;
  }
}
// Connect to a literal target IP. Host, SNI and explicit certificate identity
// checking remain the public origin. No DNS, redirects, proxy or connection pool.
export async function pinnedApplicationRequest(
  input: HTTPRequest,
  send: typeof https.request = https.request,
): Promise<HTTPResponse> {
  const url = origin(new URL(input.url).origin);
  const target = new URL(input.url);
  check(isIP(input.address) && !target.username && !target.password && !target.hash);
  return new Promise((accept, reject) => {
    const options: https.RequestOptions & { autoSelectFamily: boolean } = {
      hostname: input.address,
      port: 443,
      servername: url.hostname,
      ca: input.ca,
      rejectUnauthorized: true,
      checkServerIdentity: (_hostname, certificate) =>
        checkServerIdentity(url.hostname, certificate),
      family: isIP(input.address),
      method: input.method,
      path: target.pathname + target.search,
      agent: false,
      autoSelectFamily: false,
      signal: input.signal,
      headers: { ...input.headers, host: url.host },
    };
    const request = send(options, (response) => {
      const chunks: Buffer[] = [];
      let size = 0;
      response.on("data", (bytes: Buffer) => {
        size += bytes.length;
        if (size > input.limit) response.destroy(Error("Application response exceeds bound"));
        else chunks.push(bytes);
      });
      response.once("error", reject);
      response.once("end", () =>
        accept({
          status: response.statusCode ?? 0,
          headers: response.headers as HTTPResponse["headers"],
          body: Buffer.concat(chunks),
        }),
      );
    });
    request.once("error", reject);
    request.end(input.body);
  });
}
async function wire(): Promise<Wire> {
  const client = await import("@solidjs/web/server-functions/client");
  return {
    serialize: (args) => client.serializeString([{ method: "POST", data: args }]),
    decode: async (response) => {
      const result = await client.decodeResponse<{ result?: unknown; error?: unknown }>(response);
      check(result && !result.error);
      return result.result;
    },
  };
}
async function persist(directory: string, receipt: ApplicationReceipt) {
  const temporary = join(directory, "result.next");
  await writeFile(temporary, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, join(directory, "result.json"));
}
function metadata(value: { metadata: Metadata }, expected: Identity, owner?: string) {
  check(
    value?.metadata?.name === expected.name &&
      value.metadata.uid === expected.uid &&
      !value.metadata.deletionTimestamp &&
      (!owner || value.metadata.labels?.[ownerLabel] === owner),
  );
}
function addresses(ingress: {
  status?: { loadBalancer?: { ingress?: { ip: string; hostname?: string }[] } };
}): string[] {
  const entries = ingress?.status?.loadBalancer?.ingress;
  check(
    Array.isArray(entries) &&
      entries.length > 0 &&
      entries.every((entry) => isIP(entry.ip) && !entry.hostname),
  );
  return entries.map((entry) => ipKey(entry.ip));
}
function ipKey(address: string) {
  check(isIP(address));
  if (isIP(address) === 4) return address;
  const normalized = new URL(`http://[${address}]/`).hostname.slice(1, -1);
  const mapped = /^::ffff:([a-f0-9]+):([a-f0-9]+)$/.exec(normalized);
  if (!mapped) return normalized;
  const left = Number.parseInt(mapped[1] ?? "", 16),
    right = Number.parseInt(mapped[2] ?? "", 16);
  return [left >> 8, left & 255, right >> 8, right & 255].join(".");
}
function base64(value: string) {
  check(typeof value === "string" && /^[A-Za-z0-9+/=\r\n]*$/.test(value));
  const compact = value.replace(/[\r\n]/g, "");
  const bytes = Buffer.from(compact, "base64");
  check(bytes.toString("base64") === compact);
  return bytes;
}
export async function checkRestoredApplication(
  f: LoadedApplicationFixture,
  dependencies: {
    command?: Command;
    http?: typeof pinnedApplicationRequest;
    wire?: Wire;
    signal?: AbortSignal;
    projects?: ProjectReader;
  } = {},
): Promise<ApplicationReceipt> {
  const command = dependencies.command ?? execute,
    http = dependencies.http ?? pinnedApplicationRequest;
  const original = f.backupReceipt.source,
    ns = f.target.namespace.name;
  const receipt: ApplicationReceipt = {
    schema: 1,
    owner: f.owner,
    status: "incomplete",
    stage: "isolation",
    probeSHA256: digest(await readFile(import.meta.filename)),
    backupSHA256: f.backup.sha256,
    buildSHA256: f.build.sha256,
    witnessesSHA256: f.witnesses.sha256,
    sourceClusterUID: f.source.kubeSystemUID,
    targetClusterUID: f.target.kubeSystemUID,
    targetNamespaceUID: f.target.namespace.uid,
    targetDeploymentUID: f.target.deployment.uid,
    image: f.buildEvidence.image,
    commandID: f.save.commandID,
    save: "not-sent",
    logout: "not-needed",
    projectRead: "not-started",
    oldActors: "not-run-not-qualified",
    newCompute: "not-run-not-qualified",
  };
  await mkdir(f.evidenceDirectory, { mode: 0o700 });
  await persist(f.evidenceDirectory, receipt);
  let cleaning = false;
  const signal = () =>
    dependencies.signal && !cleaning
      ? AbortSignal.any([dependencies.signal, AbortSignal.timeout(f.limits.seconds * 1000)])
      : AbortSignal.timeout(f.limits.seconds * 1000);
  const k = async (context: string, args: string[], input?: string) => {
    const current = signal();
    current.throwIfAborted();
    const result = await command(
      [
        "kubectl",
        "--kubeconfig",
        f.kubeconfig,
        "--context",
        context,
        "--request-timeout",
        `${f.limits.seconds}s`,
        ...args,
      ],
      input,
      current,
    );
    current.throwIfAborted();
    check(result.code === 0 && Buffer.byteLength(result.stdout) <= f.limits.responseBytes);
    return result.stdout.trim();
  };
  const get = async (context: string, kind: string, resource: string, namespaced = true) => {
    const value = JSON.parse(
      await k(context, [
        "get",
        kind,
        resource,
        ...(namespaced ? ["--namespace", ns] : []),
        "-o",
        "json",
      ]),
    );
    check(!namespaced || value.metadata?.namespace === ns);
    return value;
  };
  let boundConfiguration: string | undefined;
  let boundEnvironment: Record<string, string> | undefined;
  let boundZero: string | undefined;
  async function ownership() {
    const sourceCluster = await get(f.source.context, "namespace", "kube-system", false);
    const targetCluster = await get(f.target.context, "namespace", "kube-system", false);
    metadata(sourceCluster, { name: "kube-system", uid: f.source.kubeSystemUID });
    metadata(targetCluster, { name: "kube-system", uid: f.target.kubeSystemUID });
    check(sourceCluster.metadata.uid !== targetCluster.metadata.uid);
    metadata(await get(f.source.context, "namespace", ns, false), {
      name: ns,
      uid: original.namespaceUID,
    });
    metadata(await get(f.target.context, "namespace", ns, false), f.target.namespace, f.owner);
    const deployment = await get(f.target.context, "deployment", f.target.deployment.name);
    metadata(deployment, f.target.deployment, f.owner);
    check(
      deployment.metadata.annotations?.[backupAnnotation] === f.backup.sha256 &&
        deployment.spec.replicas === 1 &&
        deployment.status?.observedGeneration === deployment.metadata.generation &&
        deployment.status.readyReplicas === 1 &&
        deployment.status.updatedReplicas === 1,
    );
    const container = deployment.spec.template.spec.containers?.find(
      (c: Named) => c.name === "factory",
    );
    check(
      deployment.spec.template.spec.containers.length === 1 &&
        container?.image === f.buildEvidence.image &&
        equal(container.command, [
          "flock",
          "--nonblock",
          "--no-fork",
          "/var/lib/factory/bootstrap.lock",
          "bun",
          "scripts/kubernetes/start.ts",
        ]) &&
        !container.args?.length,
    );
    const app = await get(f.target.context, "pod", f.target.applicationPod.name);
    metadata(app, f.target.applicationPod);
    check(
      app.status?.phase === "Running" &&
        app.spec.containers.find((c: Named) => c.name === "factory")?.image ===
          f.buildEvidence.image &&
        app.status.containerStatuses?.find((c: Named) => c.name === "factory")?.ready === true,
    );
    check(
      app.status.containerStatuses
        .find((c: Named) => c.name === "factory")
        .imageID?.endsWith(`@sha256:${f.buildEvidence.platformDigest}`),
    );
    check(restoredApplicationContainersMatch(deployment.spec.template.spec, app.spec));
    const replica = app.metadata.ownerReferences?.find(
      (r: OwnerReference) => r.controller && r.kind === "ReplicaSet",
    );
    check(replica);
    const rs = await get(f.target.context, "replicaset", replica.name);
    metadata(rs, { name: replica.name, uid: replica.uid });
    check(
      rs.metadata.ownerReferences?.some(
        (r: OwnerReference) =>
          r.controller && r.kind === "Deployment" && r.uid === f.target.deployment.uid,
      ),
    );
    const targetIngress = await get(f.target.context, "ingress", f.target.ingress.name);
    metadata(targetIngress, f.target.ingress, f.owner);
    const sourceIngress = await get(f.source.context, "ingress", f.source.ingress.name);
    metadata(sourceIngress, f.source.ingress);
    const targetAddresses = addresses(targetIngress),
      sourceAddresses = addresses(sourceIngress);
    check(
      targetAddresses.includes(ipKey(f.target.address)) &&
        !targetAddresses.some((ip) => sourceAddresses.includes(ip)),
    );
    const ingresses = JSON.parse(
      await k(f.target.context, ["get", "ingresses", "--all-namespaces", "-o", "json"]),
    );
    check(
      Array.isArray(ingresses.items) &&
        ingresses.items.some(
          (item: { metadata?: { uid?: string } }) => item.metadata?.uid === f.target.ingress.uid,
        ),
    );
    for (const item of ingresses.items) {
      if (item.metadata?.uid === f.target.ingress.uid) continue;
      check(
        !item.spec?.defaultBackend &&
          !item.spec?.rules?.some(
            (rule: { host?: string }) =>
              !rule.host ||
              [original.factoryOrigin, original.forgejoOrigin].some((value) => {
                const host = new URL(value).hostname,
                  ruleHost = rule.host?.toLowerCase() ?? "";
                return (
                  host === ruleHost ||
                  (ruleHost.startsWith("*.") && host.endsWith(ruleHost.slice(1)))
                );
              }),
          ),
      );
    }
    const safeAnnotations: Record<string, string | undefined> = {
      "meta.helm.sh/release-name": original.release,
      "meta.helm.sh/release-namespace": ns,
      "kubernetes.io/ingress.class": targetIngress.spec.ingressClassName,
      "nginx.ingress.kubernetes.io/ssl-redirect": "true",
      "nginx.ingress.kubernetes.io/force-ssl-redirect": "true",
    };
    check(
      !targetIngress.metadata.annotations ||
        Object.entries(targetIngress.metadata.annotations).every(
          ([key, value]) =>
            typeof safeAnnotations[key] === "string" && value === safeAnnotations[key],
        ),
    );
    for (const [publicOrigin, service, pod] of [
      [original.factoryOrigin, f.target.factoryService, f.target.applicationPod],
      [original.forgejoOrigin, f.target.forgejoService, f.target.forgejoPod],
    ] as const) {
      const host = new URL(publicOrigin).hostname;
      const rules = targetIngress.spec.rules.filter(
        (rule: { host?: string }) => rule.host === host,
      );
      check(
        rules.length === 1 &&
          targetIngress.spec.tls?.some(
            (tls: { hosts?: string[]; secretName?: string }) =>
              tls.hosts?.includes(host) && tls.secretName,
          ),
      );
      const paths = rules[0].http?.paths;
      check(
        Array.isArray(paths) &&
          paths.filter((p: { path?: string }) => p.path !== "/zero").length === 1,
      );
      const route = paths.find((p: { path?: string }) => p.path === "/");
      check(
        route?.pathType === "Prefix" &&
          route.backend?.service?.name === service.name &&
          route.backend.service.port.number === 3000,
      );
      const svc = await get(f.target.context, "service", service.name);
      metadata(svc, service);
      check(
        svc.spec.type !== "ExternalName" &&
          !svc.spec.externalName &&
          !svc.spec.externalIPs?.length &&
          svc.spec.selector?.["app.kubernetes.io/instance"] === original.release &&
          svc.spec.selector?.["app.kubernetes.io/component"] ===
            (pod === f.target.applicationPod ? "factory" : "forgejo"),
      );
      await serviceEndpoint(svc, pod, 3000);
      if (publicOrigin === original.factoryOrigin) {
        const zeroRoutes = paths.filter((p: { path?: string }) => p.path === "/zero");
        check(
          paths.length === 2 &&
            zeroRoutes.length === 1 &&
            zeroRoutes[0].pathType === "Prefix" &&
            zeroRoutes[0].backend?.service?.name === f.target.zeroService.name &&
            zeroRoutes[0].backend?.service?.port?.number === 4848,
        );
        const service = await get(f.target.context, "service", f.target.zeroService.name);
        metadata(service, f.target.zeroService);
        check(
          service.spec.type !== "ExternalName" &&
            !service.spec.externalName &&
            !service.spec.externalIPs?.length &&
            equal(service.spec.selector, {
              "app.kubernetes.io/instance": original.release,
              "app.kubernetes.io/component": "zero",
            }),
        );
        const zero = await ownedPod(f.target.zeroPod, "zero");
        check(
          zero.spec?.containers?.length === 1 &&
            zero.spec.containers[0].name === "zero" &&
            zero.spec.containers[0].image === zeroImage &&
            zero.status.containerStatuses?.find((c: Named) => c.name === "zero")?.ready === true,
        );
        const zeroContainer = zero.spec.containers[0];
        const env = zeroContainer.env;
        check(
          Array.isArray(env) && new Set(env.map((e: Environment) => e.name)).size === env.length,
        );
        const observedEnvironment = Object.fromEntries(
          env.map((e: Environment) => [e.name, e.value]),
        );
        for (const key of ["ZERO_UPSTREAM_DB", "ZERO_CVR_DB", "ZERO_CHANGE_DB"])
          check(
            observedEnvironment[key] ===
              `postgresql://factory:$(FACTORY_DATABASE_PASSWORD)@${f.target.postgresService.name}.${ns}.svc:5432/factory`,
          );
        check(
          !zeroContainer.envFrom?.length &&
            equal(
              env.find((e: Environment) => e.name === "FACTORY_DATABASE_PASSWORD"),
              {
                name: "FACTORY_DATABASE_PASSWORD",
                valueFrom: {
                  secretKeyRef: { name: f.target.credentials.name, key: "database-password" },
                },
              },
            ) &&
            observedEnvironment["ZERO_QUERY_FORWARD_COOKIES"] === "true" &&
            observedEnvironment["ZERO_ENABLE_CRUD_MUTATIONS"] === "false" &&
            observedEnvironment["ZERO_QUERY_URL"] ===
              `http://${original.release}-internal.${ns}.svc:3000/api/zero/query`,
        );
        const internal = await get(f.target.context, "service", `${original.release}-internal`);
        check(
          uuid.test(internal.metadata?.uid) &&
            internal.spec.type !== "ExternalName" &&
            !internal.spec.externalName &&
            !internal.spec.externalIPs?.length &&
            equal(internal.spec.selector, {
              "app.kubernetes.io/instance": original.release,
              "app.kubernetes.io/component": "factory",
            }),
        );
        await serviceEndpoint(internal, f.target.applicationPod, 3000);
        const zeroBinding = canonical({
          podUID: zero.metadata.uid,
          pod: zero.spec,
          serviceUID: service.metadata.uid,
          service: service.spec,
          internalUID: internal.metadata.uid,
          internal: internal.spec,
        });
        check(boundZero === undefined || zeroBinding === boundZero);
        boundZero = zeroBinding;
        await serviceEndpoint(service, f.target.zeroPod, 4848);
      } else check(paths.length === 1);
    }
    await binding(app);
  }
  async function serviceEndpoint(
    svc: { metadata: Identity; spec: { ports: unknown } },
    pod: Identity,
    port: number,
  ) {
    const value = await get(f.target.context, "pod", pod.name);
    metadata(value, pod);
    const slices = JSON.parse(
      await k(f.target.context, [
        "get",
        "endpointslices",
        "--namespace",
        ns,
        "--selector",
        `kubernetes.io/service-name=${svc.metadata.name}`,
        "-o",
        "json",
      ]),
    );
    check(slices.items?.length === 1);
    const slice = slices.items[0];
    check(
      slice.metadata?.namespace === ns &&
        slice.metadata.ownerReferences?.some(
          (r: OwnerReference) => r.controller && r.kind === "Service" && r.uid === svc.metadata.uid,
        ) &&
        slice.endpoints?.length === 1 &&
        equal(slice.ports, [
          { name: port === 5432 ? "postgres" : "http", port, protocol: "TCP" },
        ]) &&
        equal(svc.spec.ports, [
          { name: port === 5432 ? "postgres" : "http", port, targetPort: port, protocol: "TCP" },
        ]),
    );
    const endpoint = slice.endpoints[0];
    check(
      endpoint.conditions?.ready === true &&
        !endpoint.conditions?.terminating &&
        endpoint.targetRef?.kind === "Pod" &&
        endpoint.targetRef.uid === pod.uid &&
        endpoint.targetRef.name === pod.name &&
        endpoint.targetRef.namespace === ns &&
        endpoint.addresses?.length === 1 &&
        ipKey(endpoint.addresses[0]) === ipKey(value.status.podIP),
    );
  }
  async function binding(app: {
    spec: { containers: { name: string; env: Environment[]; envFrom: unknown }[] };
  }) {
    const config = await get(f.target.context, "configmap", f.target.configuration.name);
    metadata(config, f.target.configuration);
    check(
      config.data.FACTORY_BASE_URL === original.factoryOrigin &&
        config.data.FACTORY_FORGEJO_PUBLIC_URL === original.forgejoOrigin &&
        config.data.FACTORY_HELM_RELEASE === original.release &&
        config.data.FACTORY_FORGEJO_API_URL ===
          `http://${f.target.forgejoService.name}.${ns}.svc:3000/api/v1/`,
    );
    const secret = await get(f.target.context, "secret", f.target.credentials.name);
    metadata(secret, f.target.credentials);
    check(
      Object.entries(f.credentialHashes).every(
        ([key, value]) => digest(base64(secret.data[key])) === value,
      ),
    );
    const container = app.spec.containers.find((c) => c.name === "factory");
    check(container);
    const env = container.env;
    check(Array.isArray(env) && new Set(env.map((e) => e.name)).size === env.length);
    for (const [key, secretKey] of [
      ["FACTORY_AUTH_SECRET", "auth-secret"],
      ["FACTORY_ADMIN_PASSWORD", "admin-password"],
      ["FACTORY_DATABASE_PASSWORD", "database-password"],
      ["FACTORY_WIKI_WEBHOOK_SECRET", "webhook-secret"],
    ]) {
      check(
        equal(
          env.find((e) => e.name === key),
          {
            name: key,
            valueFrom: { secretKeyRef: { name: f.target.credentials.name, key: secretKey } },
          },
        ),
      );
    }
    check(
      !env.some((e) =>
        ["FACTORY_BASE_URL", "FACTORY_FORGEJO_PUBLIC_URL", "FACTORY_FORGEJO_API_URL"].includes(
          e.name,
        ),
      ),
    );
    check(equal(container.envFrom, [{ configMapRef: { name: f.target.configuration.name } }]));
    check(
      env.find((e) => e.name === "DATABASE_URL")?.value ===
        `postgresql://factory:$(FACTORY_DATABASE_PASSWORD)@${f.target.postgresService.name}.${ns}.svc:5432/factory`,
    );
    const pgService = await get(f.target.context, "service", f.target.postgresService.name);
    metadata(pgService, f.target.postgresService);
    check(
      pgService.spec.type !== "ExternalName" &&
        !pgService.spec.externalName &&
        !pgService.spec.externalIPs?.length &&
        pgService.spec.selector?.["app.kubernetes.io/instance"] === original.release &&
        pgService.spec.selector?.["app.kubernetes.io/component"] === "postgres",
    );
    await serviceEndpoint(pgService, f.target.postgresPod, 5432);
    const observed = canonical({ configuration: config.data, secret: secret.data, pod: app.spec });
    check(boundConfiguration === undefined || observed === boundConfiguration);
    boundConfiguration = observed;
    boundEnvironment = Object.fromEntries(
      Object.entries({
        FACTORY_BASE_URL: original.factoryOrigin,
        FACTORY_FORGEJO_PUBLIC_URL: original.forgejoOrigin,
        FACTORY_FORGEJO_API_URL: `http://${f.target.forgejoService.name}.${ns}.svc:3000/api/v1/`,
        FACTORY_HELM_RELEASE: original.release,
        FACTORY_STATE_DIRECTORY: "/var/lib/factory",
        FACTORY_AUTH_SECRET: base64(secret.data["auth-secret"]).toString("utf8"),
        FACTORY_ADMIN_PASSWORD: base64(secret.data["admin-password"]).toString("utf8"),
        FACTORY_DATABASE_PASSWORD: base64(secret.data["database-password"]).toString("utf8"),
        FACTORY_WIKI_WEBHOOK_SECRET: base64(secret.data["webhook-secret"]).toString("utf8"),
        DATABASE_URL: `postgresql://factory:${base64(secret.data["database-password"]).toString("utf8")}@${f.target.postgresService.name}.${ns}.svc:5432/factory`,
      }).map(([key, value]) => [key, digest(value)]),
    );
  }
  async function ownedPod(pod: Identity, role: string) {
    const value = await get(f.target.context, "pod", pod.name);
    metadata(value, pod);
    check(
      value.metadata.labels?.["app.kubernetes.io/instance"] === original.release &&
        value.metadata.labels?.["app.kubernetes.io/component"] === role &&
        value.status?.phase === "Running",
    );
    return value;
  }
  const database = async (): Promise<Snapshot> => {
    await ownership();
    await ownedPod(f.target.postgresPod, "postgres");
    return JSON.parse(
      await k(
        f.target.context,
        [
          "exec",
          "--namespace",
          ns,
          f.target.postgresPod.name,
          "--container",
          "postgres",
          "-i",
          "--",
          "psql",
          "-h",
          "/var/run/postgresql",
          "-X",
          "-q",
          "-A",
          "-t",
          "--set",
          "ON_ERROR_STOP=1",
          "-U",
          "factory",
          "-d",
          "factory",
        ],
        applicationSQL(f),
      ),
    );
  };
  function snapshot(value: Snapshot, after = false) {
    check(
      value.readOnly === "on" &&
        value.database === "factory" &&
        value.schema === f.expected.schemaDigest,
    );
    check(
      equal(Object.keys(value.busy).sort(), Object.keys(idleRules).sort()) &&
        Object.values(value.busy).every((v) => v === 0),
    );
    check(
      equal(value.history, f.expected.history) &&
        equal(value.project, f.expected.project) &&
        equal(value.account, f.account) &&
        value.source?.eligible === true &&
        value.source.sha256 === f.expected.source.leaseSHA256 &&
        equal(value.requirements, f.expected.requirements) &&
        value.scope === f.expected.requirementRevisionID,
    );
    check(
      equal(value.ticket, {
        ...f.expected.ticket,
        ...(after
          ? { description: f.save.description, version: f.expected.ticket.version + 1 }
          : {}),
      }),
    );
    check(
      after
        ? value.saved?.id === f.save.commandID &&
            value.saved.ticketID === f.expected.ticket.id &&
            value.saved.createdBy === f.account.id &&
            value.saved.authorKind === "human" &&
            value.saved.proposalEntryID === null
        : value.saved === null,
    );
    const old = value.documents.filter((doc: Document) => doc.id !== f.save.commandID);
    check(
      equal(old, f.expected.documents) && value.documents.length === old.length + (after ? 1 : 0),
    );
    if (after) check(equal(value.documents[0], newDocument()));
  }
  function newDocument(): Document {
    const latest = f.expected.documents[0];
    check(latest);
    return {
      ...latest,
      id: f.save.commandID,
      ordinal:
        Math.max(
          ...f.expected.documents.map((d) => d.ordinal),
          ...f.expected.requirements.map((r) => r.ordinal),
        ) + 1,
      title: f.expected.ticket.title,
      description: f.save.description,
      requirementRevisionId: f.expected.requirementRevisionID,
    };
  }
  let cookies = new Map<string, string>(),
    loggedIn = false,
    before: Snapshot | undefined;
  const cookieHeader = () => [...cookies].map(([key, value]) => `${key}=${value}`).join("; ");
  async function request(
    url: string,
    method: "GET" | "POST",
    body?: string,
    forge = false,
    extra: Record<string, string> = {},
  ) {
    await ownership();
    const target = new URL(url);
    check(target.origin === (forge ? original.forgejoOrigin : original.factoryOrigin));
    const headers: Record<string, string> = { ...extra, origin: target.origin };
    if (forge) headers["authorization"] = `Bearer ${f.forgeTokenValue}`;
    else if (cookies.size) headers["cookie"] = cookieHeader();
    const response = await http({
      url,
      address: f.target.address,
      ca: f.caBytes,
      method,
      headers,
      ...(body === undefined ? {} : { body }),
      limit: f.limits.responseBytes,
      signal: signal(),
    });
    check(response.status === 200 && response.body.byteLength <= f.limits.responseBytes);
    if (!forge) {
      const raw = response.headers["set-cookie"];
      for (const field of typeof raw === "string" ? [raw] : (raw ?? [])) {
        const [pair, ...attributes] = field.split(";").map((v) => v.trim());
        check(pair && !/[\r\n]/.test(pair));
        const equals = pair.indexOf("=");
        check(equals > 0);
        const key = pair.slice(0, equals),
          value = pair.slice(equals + 1);
        check(/^[A-Za-z0-9_.-]+$/.test(key));
        const attrs = new Map(
          attributes.map((v) => [v.split("=")[0]?.toLowerCase(), v.slice(v.indexOf("=") + 1)]),
        );
        check(
          attrs.has("secure") &&
            (!attrs.has("domain") || attrs.get("domain")?.replace(/^\./, "") === target.hostname) &&
            (!attrs.has("path") || attrs.get("path") === "/"),
        );
        if (!value || attrs.get("max-age") === "0") cookies.delete(key);
        else cookies.set(key, value);
      }
    }
    return response;
  }
  const json = (response: HTTPResponse) => JSON.parse(Buffer.from(response.body).toString("utf8"));
  try {
    await ownership();
    receipt.stage = "binding";
    await ownedPod(f.target.applicationPod, "factory");
    const tree = await k(f.target.context, [
      "exec",
      "--namespace",
      ns,
      f.target.applicationPod.name,
      "--container",
      "factory",
      "-i",
      "--",
      "bun",
      "--no-env-file",
      "--eval",
      invocation(applicationBuildTree, f.buildEvidence.treeSHA256),
    ]);
    const build = JSON.parse(tree);
    check(
      build.treeSHA256 === f.buildEvidence.treeSHA256 &&
        equal(build.functions, f.buildEvidence.functions) &&
        boundEnvironment &&
        equal(build.environmentHashes, boundEnvironment) &&
        uuid.test(build.startupID) &&
        equal(build.installation, {
          runtime: "substrate",
          namespace: ns,
          release: original.release,
          factoryURL: original.factoryOrigin,
          forgeURL: original.forgejoOrigin,
          storageClass: original.storageClass,
        }),
    );
    receipt.stage = "quiescence";
    before = await database();
    snapshot(before);
    const transport = dependencies.wire ?? (await wire());
    const fn = async <K extends FunctionName>(
      key: K,
      args: unknown[],
    ): Promise<FunctionValues[K]> => {
      check(functions.includes(key));
      const response = await request(
        `${original.factoryOrigin}/_server/data/${f.buildEvidence.functions[key]}`,
        "POST",
        await transport.serialize(args),
        false,
        { "content-type": "text/plain", "x-server-function-format": "0" },
      );
      const result = await transport.decode(
        new Response(Buffer.from(response.body), {
          status: response.status,
          headers: response.headers as HeadersInit,
        }),
      );
      object(result);
      check(result["ok"] === true);
      return result["value"] as FunctionValues[K];
    };
    receipt.stage = "readiness";
    const ready = await request(
      `${original.factoryOrigin}/health/ready?installation=complete`,
      "GET",
    );
    check(
      json(ready).ready === true &&
        ready.headers["x-open-factory"] === "ready" &&
        ready.headers["x-open-factory-startup"] === build.startupID,
    );
    receipt.stage = "authentication";
    receipt.logout = "unconfirmed";
    await persist(f.evidenceDirectory, receipt);
    const login = await request(
      `${original.factoryOrigin}/api/auth/sign-in/email`,
      "POST",
      JSON.stringify({ email: f.account.email, password: f.passwordValue }),
      false,
      { "content-type": "application/json" },
    );
    check(json(login).user?.id === f.account.id && cookies.size > 0);
    loggedIn = true;
    const session = json(await request(`${original.factoryOrigin}/api/auth/get-session`, "GET"));
    check(session.user?.id === f.account.id && session.user.email === f.account.email);
    receipt.stage = "reads";
    const bootstrap = await fn("getBootstrap", []);
    check(
      bootstrap.session?.user.id === f.account.id &&
        bootstrap.session.user.email === f.account.email &&
        typeof bootstrap.session.systemManager === "boolean" &&
        bootstrap.zeroCacheURL === `${original.factoryOrigin}/zero` &&
        sha.test(bootstrap.planningCacheScope),
    );
    try {
      await ownership();
      const projects = projectRows(
        await (dependencies.projects ?? readRestoredProjects)(
          {
            owner: f.owner,
            factoryOrigin: original.factoryOrigin,
            address: f.target.address,
            ca: f.caBytes,
            cookie: cookieHeader(),
            accountID: f.account.id,
            systemManager: bootstrap.session.systemManager,
            cacheScope: bootstrap.planningCacheScope,
            seconds: f.limits.seconds,
            responseBytes: f.limits.responseBytes,
          },
          signal(),
        ),
      );
      await ownership();
      const selected = projects.filter((p) => p.id === f.expected.project.id);
      check(
        selected.length === 1 && equal(select(selected[0], f.expected.project), f.expected.project),
      );
      receipt.projectRead = "complete";
    } catch {
      receipt.projectRead = "failed";
      throw Error("Completed restored Zero Project enumeration failed");
    }
    const detail = await fn("getTicketDetail", [f.expected.ticket.id]);
    check(
      equal(select(detail.ticket, f.expected.ticket), f.expected.ticket) &&
        equal(
          detail.documentRevisions.map((d) => select(d, f.expected.documents[0] ?? {})),
          f.expected.documents,
        ) &&
        equal(
          detail.revisions.map((r) => select(r, f.expected.requirements[0] ?? {})),
          f.expected.requirements,
        ),
    );
    const git = f.expected.git,
      root = `${original.forgejoOrigin}/api/v1/repos/${git.owner}/${git.repository}`;
    check(
      json(await request(`${root}/git/commits/${git.commit}`, "GET", undefined, true)).sha ===
        git.commit,
    );
    const file = json(
      await request(
        `${root}/contents/${git.path.split("/").map(encodeURIComponent).join("/")}?ref=${git.commit}`,
        "GET",
        undefined,
        true,
      ),
    );
    const gitBytes = base64(file.content);
    check(
      file.type === "file" &&
        file.path === git.path &&
        file.sha === git.blob &&
        file.encoding === "base64" &&
        file.size === git.bytes &&
        gitBytes.length === git.bytes &&
        digest(gitBytes) === git.sha256,
    );
    const sourceURL = `${original.factoryOrigin}/api/workspaces/${f.expected.source.workspaceID}/source/read`;
    const source = json(
      await request(sourceURL, "POST", JSON.stringify({ path: f.expected.source.path }), false, {
        "content-type": "application/json",
      }),
    );
    const sourceBytes = base64(source.content);
    check(
      source.kind === "file" &&
        source.size === f.expected.source.bytes &&
        sourceBytes.length === f.expected.source.bytes &&
        digest(sourceBytes) === f.expected.source.sha256 &&
        typeof source.version === "string" &&
        source.version.length > 0,
    );
    receipt.stage = "save";
    snapshot(await database());
    const latest = f.expected.documents[0];
    check(latest);
    const input = {
      commandId: f.save.commandID,
      expectedVersion: f.expected.ticket.version,
      expectedDocumentId: latest.id,
      requirementRevisionId: f.expected.requirementRevisionID,
      title: f.expected.ticket.title,
      description: f.save.description,
      requirement: JSON.parse(latest.canonicalContent),
    };
    receipt.save = "intended";
    await persist(f.evidenceDirectory, receipt);
    try {
      const saved = await fn("saveTicketDocument", [f.expected.ticket.id, input]);
      check(
        saved.id === f.save.commandID &&
          saved.ticketVersion === f.expected.ticket.version + 1 &&
          saved.requirementRevisionId === f.expected.requirementRevisionID,
      );
      receipt.save = "confirmed";
    } catch {
      receipt.save = "unconfirmed";
      throw Error("Save outcome unconfirmed; never retry automatically");
    }
    receipt.stage = "read-back";
    const after = await fn("getTicketDetail", [f.expected.ticket.id]);
    check(
      equal(select(after.ticket, f.expected.ticket), {
        ...f.expected.ticket,
        version: f.expected.ticket.version + 1,
        description: f.save.description,
      }),
    );
    check(
      after.documentRevisions.length === f.expected.documents.length + 1 &&
        equal(
          after.documentRevisions.slice(1).map((d) => select(d, latest)),
          f.expected.documents,
        ) &&
        equal(select(after.documentRevisions[0], latest), newDocument()) &&
        equal(
          after.revisions.map((r) => select(r, f.expected.requirements[0] ?? {})),
          f.expected.requirements,
        ),
    );
    snapshot(await database(), true);
    const sameSource = json(
      await request(sourceURL, "POST", JSON.stringify({ path: f.expected.source.path }), false, {
        "content-type": "application/json",
      }),
    );
    check(
      sameSource.kind === "file" &&
        sameSource.size === source.size &&
        sameSource.content === source.content &&
        sameSource.version === source.version,
    );
    receipt.stage = "verified";
  } catch {
    // Neither command output, raw errors, credentials nor application content belongs in receipts.
  } finally {
    cleaning = true;
    if (cookies.size) {
      try {
        const signedOut = json(
          await request(`${original.factoryOrigin}/api/auth/sign-out`, "POST", "{}", false, {
            "content-type": "application/json",
          }),
        );
        check(signedOut.success === true && cookies.size === 0);
        const final = await database();
        check(before && equal(final.sessions, before.sessions));
        receipt.logout = "confirmed";
        try {
          snapshot(final, receipt.save === "confirmed");
        } catch {
          receipt.stage = "post-logout-integrity";
        }
      } catch {
        receipt.logout = "unconfirmed";
      }
    } else if (loggedIn) receipt.logout = "unconfirmed";
    cookies = new Map();
    if (
      receipt.stage === "verified" &&
      receipt.projectRead === "complete" &&
      receipt.save === "confirmed" &&
      receipt.logout === "confirmed"
    )
      receipt.status = "restored-application-passed";
    await persist(f.evidenceDirectory, receipt);
  }
  return receipt;
}
if (import.meta.main) {
  try {
    const args = process.argv.slice(2);
    check(
      args.length === 5 && args[0] === "--run" && args[1] === "--fixture" && args[3] === "--owner",
    );
    const fixture = await loadApplicationFixture(args[2] ?? "", args[4] ?? "");
    const controller = new AbortController();
    const abort = () => controller.abort();
    process.once("SIGINT", abort);
    process.once("SIGTERM", abort);
    try {
      const result = await checkRestoredApplication(fixture, { signal: controller.signal });
      console.log(
        `Restored application: ${result.status}; save ${result.save}; logout ${result.logout}; native recovery not qualified`,
      );
      process.exitCode = result.status === "restored-application-passed" ? 0 : 1;
    } finally {
      process.off("SIGINT", abort);
      process.off("SIGTERM", abort);
    }
  } catch {
    console.error(
      "Restore application check refused or incomplete; private diagnostics suppressed",
    );
    process.exitCode = 1;
  }
}
