// Fixture, witness, build evidence, and kubeconfig validation for restored application checks.
import { lstat, readFile, realpath } from "node:fs/promises";
import { isIP } from "node:net";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { historyTables } from "./restore-application-rules";
import {
  type ApplicationFixture,
  type ApplicationWitnesses,
  type Build,
  base64,
  check,
  digest,
  equal,
  functions,
  identity,
  keys,
  type LoadedApplicationFixture,
  name,
  object,
  origin,
  originalRepository,
  privateFile,
  privatePath,
  sha,
  uuid,
} from "./restore-application-types";
import { type Receipt as BackupReceipt, memberPath } from "./restore-rehearsal";

const targetIdentities = [
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
] as const;

function validateBackupAndBuild(
  backupReceipt: BackupReceipt,
  buildEvidence: Build,
  f: ApplicationFixture,
  owner: string,
) {
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
}

function validateDocumentsAndRequirements(expected: ApplicationWitnesses, f: ApplicationFixture) {
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
    return;
  }
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

function validateWitnesses(
  expected: ApplicationWitnesses,
  backupReceipt: BackupReceipt,
  f: ApplicationFixture,
) {
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
  keys(expected.project, "id name slug repositoryUrl defaultBranch actorTemplatePath");
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
  validateDocumentsAndRequirements(expected, f);
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
}

async function validateKubeconfig(f: ApplicationFixture) {
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
    const caText = base64(cluster["certificate-authority-data"]).toString("utf8");
    check(
      endpoint.protocol === "https:" &&
        !endpoint.username &&
        !endpoint.password &&
        !endpoint.hash &&
        !endpoint.search &&
        caText.includes("-----BEGIN CERTIFICATE-----") &&
        !caText.includes("PRIVATE KEY"),
    );
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
}

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
  for (const key of targetIdentities) identity(f.target[key]);
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
  const [backupReceipt, buildEvidence, expected] = (await Promise.all(
    [f.backup, f.build, f.witnesses].map(async (entry) => {
      keys(entry, "file sha256");
      const bytes = await privateFile(f.privateRoot, entry.file);
      check(sha.test(entry.sha256) && digest(bytes) === entry.sha256);
      return JSON.parse(bytes.toString("utf8"));
    }),
  )) as [BackupReceipt, Build, ApplicationWitnesses];
  validateBackupAndBuild(backupReceipt, buildEvidence, f, owner);
  validateWitnesses(expected, backupReceipt, f);
  keys(
    f.credentialHashes,
    "auth-secret admin-password database-password zero-password webhook-secret",
  );
  check(Object.values(f.credentialHashes).every((value) => sha.test(value)));
  await validateKubeconfig(f);
  const caBytes = (await privateFile(f.privateRoot, f.ca)).toString("utf8");
  check(caBytes.includes("-----BEGIN CERTIFICATE-----") && !caBytes.includes("PRIVATE KEY"));
  const passwordValue = (await privateFile(f.privateRoot, f.password))
    .toString("utf8")
    .replace(/\r?\n$/, "");
  const forgeTokenValue = (await privateFile(f.privateRoot, f.forgeToken)).toString("utf8").trim();
  check(passwordValue.length > 0 && /^[A-Za-z0-9_-]{20,256}$/.test(forgeTokenValue));
  return { ...f, backupReceipt, buildEvidence, expected, caBytes, passwordValue, forgeTokenValue };
}
