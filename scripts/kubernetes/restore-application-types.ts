// Shared contracts, validation primitives, and persistence helpers for restored application checks.
import { createHash } from "node:crypto";
import { lstat, readFile, realpath, rename, writeFile } from "node:fs/promises";
import { isIP } from "node:net";
import { isAbsolute, join, resolve } from "node:path";
import type { Receipt as BackupReceipt } from "./restore-rehearsal";

export const ownerLabel = "factory.restore-application.owner";
export const backupAnnotation = "factory.restore-application.backup";
export const sha = /^[a-f0-9]{64}$/;
export const uuid = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/;
export const name = /^[a-z0-9][a-z0-9-]{0,62}$/;
export const functions = ["getBootstrap", "getTicketDetail", "saveTicketDocument"] as const;

export type FunctionName = (typeof functions)[number];
export type Identity = { name: string; uid: string };
export type Digest = { rows: number; sha256: string };
export type Project = {
  id: string;
  name: string;
  slug: string;
  repositoryUrl: string;
  defaultBranch: string;
  actorTemplatePath: string;
};
export type Ticket = {
  id: string;
  projectId: string;
  title: string;
  description: string;
  state: string;
  version: number;
};
export type Document = {
  id: string;
  ordinal: number;
  title: string;
  description: string;
  canonicalContent: string;
  contentDigest: string;
  requirementRevisionId: string | null;
};
export type Revision = {
  id: string;
  ordinal: number;
  canonicalContent: string;
  contentDigest: string;
};
export type Named = { name: string };
export type OwnerReference = { controller?: boolean; kind: string; name: string; uid: string };
export type Metadata = Identity & {
  deletionTimestamp?: string;
  labels?: Record<string, string>;
};
export type Environment = { name: string; value?: string; valueFrom?: unknown };
export type Snapshot = {
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
export type FunctionValues = {
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
export type Build = {
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

export const digest = (bytes: string | Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");

export function check(value: unknown): asserts value {
  if (!value) throw Error("Restore application prerequisite or observation refused");
}

export function object(value: unknown): asserts value is Record<string, unknown> {
  check(value && typeof value === "object" && !Array.isArray(value));
}

export function keys(value: unknown, names: string) {
  object(value);
  check(JSON.stringify(Object.keys(value).sort()) === JSON.stringify(names.split(" ").sort()));
}

export function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.entries(value)
    .sort(([a], [b]) => a.localeCompare(b, "en"))
    .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
    .join(",")}}`;
}

export const equal = (a: unknown, b: unknown) => canonical(a) === canonical(b);

export function select(value: unknown, example: Record<string, unknown>) {
  object(value);
  return Object.fromEntries(Object.keys(example).map((key) => [key, value[key]]));
}

export function identity(value: Identity) {
  keys(value, "name uid");
  check(name.test(value.name) && uuid.test(value.uid));
}

export function origin(value: string) {
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

export function ipKey(address: string) {
  check(isIP(address));
  if (isIP(address) === 4) return address;
  const normalized = new URL(`http://[${address}]/`).hostname.slice(1, -1);
  const mapped = /^::ffff:([a-f0-9]+):([a-f0-9]+)$/.exec(normalized);
  if (!mapped) return normalized;
  const left = Number.parseInt(mapped[1] ?? "", 16),
    right = Number.parseInt(mapped[2] ?? "", 16);
  return [left >> 8, left & 255, right >> 8, right & 255].join(".");
}

export function base64(value: string) {
  check(typeof value === "string" && /^[A-Za-z0-9+/=\r\n]*$/.test(value));
  const compact = value.replace(/[\r\n]/g, "");
  const bytes = Buffer.from(compact, "base64");
  check(bytes.toString("base64") === compact);
  return bytes;
}

export function metadata(value: { metadata: Metadata }, expected: Identity, owner?: string) {
  check(
    value?.metadata?.name === expected.name &&
      value.metadata.uid === expected.uid &&
      !value.metadata.deletionTimestamp &&
      (!owner || value.metadata.labels?.[ownerLabel] === owner),
  );
}

export async function privatePath(path: string, directory = false) {
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

export async function privateFile(root: string, path: string) {
  check(path.startsWith(`${root}/`));
  await privatePath(path);
  return readFile(path);
}

export async function persistReceipt(directory: string, receipt: ApplicationReceipt) {
  const temporary = join(directory, "result.next");
  await writeFile(temporary, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, join(directory, "result.json"));
}
