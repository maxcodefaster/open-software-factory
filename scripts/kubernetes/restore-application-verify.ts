// End-to-end verification stages for an already restored, exclusively owned application target.
import { mkdir, readFile } from "node:fs/promises";
import {
  applicationBuildTree,
  createApplicationSession,
  createWire,
  executeCommand,
  parseJSON,
  pinnedApplicationRequest,
} from "./restore-application-http";
import { createClusterObserver } from "./restore-application-kubernetes";
import { expectedNewDocument, verifySnapshot } from "./restore-application-rules";
import {
  type ApplicationReceipt,
  base64,
  type Command,
  check,
  digest,
  equal,
  type LoadedApplicationFixture,
  persistReceipt,
  type Snapshot,
  select,
  sha,
  uuid,
  type Wire,
} from "./restore-application-types";
import { invocation } from "./restore-rehearsal";
import { type ProjectReader, projectRows, readRestoredProjects } from "./restore-zero-projects";

export type CheckDependencies = {
  command?: Command;
  http?: typeof pinnedApplicationRequest;
  wire?: Wire;
  signal?: AbortSignal;
  projects?: ProjectReader;
};

export async function runApplicationCheck(
  f: LoadedApplicationFixture,
  probeFile: string,
  zeroImage: string,
  dependencies: CheckDependencies = {},
): Promise<ApplicationReceipt> {
  const command = dependencies.command ?? executeCommand;
  const http = dependencies.http ?? pinnedApplicationRequest;
  const original = f.backupReceipt.source;
  const ns = f.target.namespace.name;
  const receipt: ApplicationReceipt = {
    schema: 1,
    owner: f.owner,
    status: "incomplete",
    stage: "isolation",
    probeSHA256: digest(await readFile(probeFile)),
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
  await persistReceipt(f.evidenceDirectory, receipt);

  let cleaning = false;
  const signal = () =>
    dependencies.signal && !cleaning
      ? AbortSignal.any([dependencies.signal, AbortSignal.timeout(f.limits.seconds * 1000)])
      : AbortSignal.timeout(f.limits.seconds * 1000);

  const cluster = createClusterObserver(f, { command, signal, zeroImage });
  const session = createApplicationSession(f, {
    http,
    verifyOwnership: cluster.verifyOwnership,
    signal,
  });

  const postJSON = async (url: string, payload: unknown) =>
    parseJSON(
      await session.request(url, "POST", JSON.stringify(payload), false, {
        "content-type": "application/json",
      }),
    );

  let loggedIn = false;
  let before: Snapshot | undefined;
  try {
    await cluster.verifyOwnership();
    receipt.stage = "binding";
    await cluster.ownedPod(f.target.applicationPod, "factory");
    const tree = await cluster.kubectl(f.target.context, [
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
    const boundEnvironment = cluster.boundEnvironment();
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
    before = await cluster.readDatabaseSnapshot();
    verifySnapshot(f, before);
    const transport = dependencies.wire ?? (await createWire());

    receipt.stage = "readiness";
    const ready = await session.request(
      `${original.factoryOrigin}/health/ready?installation=complete`,
      "GET",
    );
    check(
      parseJSON(ready).ready === true &&
        ready.headers["x-open-factory"] === "ready" &&
        ready.headers["x-open-factory-startup"] === build.startupID,
    );

    receipt.stage = "authentication";
    receipt.logout = "unconfirmed";
    await persistReceipt(f.evidenceDirectory, receipt);
    const login = await postJSON(`${original.factoryOrigin}/api/auth/sign-in/email`, {
      email: f.account.email,
      password: f.passwordValue,
    });
    check(login.user?.id === f.account.id && session.hasCookies());
    loggedIn = true;
    const currentSession = parseJSON(
      await session.request(`${original.factoryOrigin}/api/auth/get-session`, "GET"),
    );
    check(
      currentSession.user?.id === f.account.id && currentSession.user.email === f.account.email,
    );

    receipt.stage = "reads";
    const bootstrap = await session.callFunction(transport, "getBootstrap", []);
    check(
      bootstrap.session?.user.id === f.account.id &&
        bootstrap.session.user.email === f.account.email &&
        typeof bootstrap.session.systemManager === "boolean" &&
        bootstrap.zeroCacheURL === `${original.factoryOrigin}/zero` &&
        sha.test(bootstrap.planningCacheScope),
    );
    try {
      await cluster.verifyOwnership();
      const projects = projectRows(
        await (dependencies.projects ?? readRestoredProjects)(
          {
            owner: f.owner,
            factoryOrigin: original.factoryOrigin,
            address: f.target.address,
            ca: f.caBytes,
            cookie: session.cookieHeader(),
            accountID: f.account.id,
            systemManager: bootstrap.session.systemManager,
            cacheScope: bootstrap.planningCacheScope,
            seconds: f.limits.seconds,
            responseBytes: f.limits.responseBytes,
          },
          signal(),
        ),
      );
      await cluster.verifyOwnership();
      const selected = projects.filter((p) => p.id === f.expected.project.id);
      check(
        selected.length === 1 && equal(select(selected[0], f.expected.project), f.expected.project),
      );
      receipt.projectRead = "complete";
    } catch {
      receipt.projectRead = "failed";
      throw Error("Completed restored Zero Project enumeration failed");
    }

    const detail = await session.callFunction(transport, "getTicketDetail", [f.expected.ticket.id]);
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

    const git = f.expected.git;
    const repoRoot = `${original.forgejoOrigin}/api/v1/repos/${git.owner}/${git.repository}`;
    check(
      parseJSON(
        await session.request(`${repoRoot}/git/commits/${git.commit}`, "GET", undefined, true),
      ).sha === git.commit,
    );
    const file = parseJSON(
      await session.request(
        `${repoRoot}/contents/${git.path.split("/").map(encodeURIComponent).join("/")}?ref=${git.commit}`,
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
    const source = await postJSON(sourceURL, { path: f.expected.source.path });
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
    verifySnapshot(f, await cluster.readDatabaseSnapshot());
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
    await persistReceipt(f.evidenceDirectory, receipt);
    try {
      const saved = await session.callFunction(transport, "saveTicketDocument", [
        f.expected.ticket.id,
        input,
      ]);
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
    const after = await session.callFunction(transport, "getTicketDetail", [f.expected.ticket.id]);
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
        equal(select(after.documentRevisions[0], latest), expectedNewDocument(f)) &&
        equal(
          after.revisions.map((r) => select(r, f.expected.requirements[0] ?? {})),
          f.expected.requirements,
        ),
    );
    verifySnapshot(f, await cluster.readDatabaseSnapshot(), true);
    const sameSource = await postJSON(sourceURL, { path: f.expected.source.path });
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
    if (session.hasCookies()) {
      try {
        const signedOut = await postJSON(`${original.factoryOrigin}/api/auth/sign-out`, {});
        check(signedOut.success === true && !session.hasCookies());
        const final = await cluster.readDatabaseSnapshot();
        check(before && equal(final.sessions, before.sessions));
        receipt.logout = "confirmed";
        try {
          verifySnapshot(f, final, receipt.save === "confirmed");
        } catch {
          receipt.stage = "post-logout-integrity";
        }
      } catch {
        receipt.logout = "unconfirmed";
      }
    } else if (loggedIn) receipt.logout = "unconfirmed";
    session.clearCookies();
    if (
      receipt.stage === "verified" &&
      receipt.projectRead === "complete" &&
      receipt.save === "confirmed" &&
      receipt.logout === "confirmed"
    )
      receipt.status = "restored-application-passed";
    await persistReceipt(f.evidenceDirectory, receipt);
  }
  return receipt;
}
