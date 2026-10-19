import type { createDatabase } from "../../../../packages/db/src/client";
import { hashConnectorToken } from "../../../../packages/runtime-domain/src/identity";
import {
  boundedSourceBody,
  createWorkspaceSourceClient,
  type SourceResourceObservation,
  type SourceResources,
  type WorkspaceSourceClient,
} from "../../../../packages/runtime-kubernetes/src/workspace-source";
import {
  type WorkspaceSourceState,
  workspaceSourceCapability,
  workspaceSourceIdentity,
} from "../../../../packages/workspace-domain/src/source";
import {
  personalWorkspaceIdentity,
  ticketWorkspaceIdentity,
} from "../../../../packages/workspace-domain/src/workspace";
import { workspaceWriteAuthorityIn } from "../access/change-writer";
import { projectDevelopmentAuthorityIn } from "../access/controller";
import type { AgentTurnTransaction } from "../agent/turn-store";
import { CommandError } from "../command-error";
import { runtimeFactoryURL, runtimeRepositoryCloneURL } from "../runtime/endpoints";
import { resolveRepositoryRevision, serveRuntimeRepository } from "../runtime/git-http";

type Database = ReturnType<typeof createDatabase>;
type SourceSQL = Database["client"] | AgentTurnTransaction;
// Cold volume placement and checkout are separate from prepared IDE switching.
// Keep reconciliation and execution admission on the same bounded startup budget.
const sourcePreparationTimeoutMS = 300_000;
interface SourceRow {
  workspaceID: string;
  projectID: string;
  projectName: string;
  ticketTitle: string | null;
  ownerID: string | null;
  kind: string;
  namespace: string;
  revision: string;
  repositoryURL: string;
  epoch: string;
  state: WorkspaceSourceState;
  filesImage: string;
  capabilityHash: string;
  namespaceUID: string | null;
  claimUID: string | null;
  podUID: string | null;
  storageNode: string | null;
  failure: string | null;
}
export interface SourceWorkspaceView {
  readonly workspaceID: string;
  readonly label: string;
  readonly state: WorkspaceSourceState;
  readonly serviceID: string;
  readonly epoch: number;
  readonly failure: string | null;
}

export interface RuntimeSourceAttachment {
  readonly workspaceID: string;
  readonly namespaceUID: string;
  readonly claimUID: string;
  readonly storageNode: string;
}

function pinnedSourceImages() {
  const { FACTORY_WORKSPACE_FILES_IMAGE: filesImage } = process.env;
  if (
    !filesImage ||
    [filesImage].some((image) => !/^[a-zA-Z0-9.:/-]+@sha256:[a-f0-9]{64}$/.test(image))
  )
    throw new CommandError("unavailable", "Independent source artifacts are not configured");
  return { filesImage };
}

export function createWorkspaceSourceController(
  database: Database,
  secret: string,
  client: WorkspaceSourceClient = createWorkspaceSourceClient(),
  now: () => number = () => performance.now(),
) {
  const streams = new Map<
    AbortController,
    { userID: string; projectID: string; workspaceID: string }
  >();
  const pending = new Map<string, { wakeup: boolean }>();
  let closed = false;
  async function row(
    workspaceID: string,
    sql: SourceSQL = database.client,
  ): Promise<SourceRow | null> {
    const [source] = await sql<SourceRow[]>`
      SELECT workspace.id AS "workspaceID", workspace.project_id AS "projectID", workspace.kind,
        project.name AS "projectName",ticket.title AS "ticketTitle",
        workspace.owner_user_id AS "ownerID", workspace.kubernetes_namespace AS namespace,
        workspace.source_revision AS revision, project.repository_url AS "repositoryURL",
        source.access_epoch::text AS epoch,source.state,source.files_image AS "filesImage",
        source.capability_hash AS "capabilityHash",
        source.namespace_uid AS "namespaceUID",source.claim_uid AS "claimUID",source.pod_uid AS "podUID",
        source.storage_node AS "storageNode",source.failure
      FROM factory.workspace_source source JOIN factory.development_workspace workspace ON workspace.id=source.workspace_id
      JOIN factory.project project ON project.id=workspace.project_id
      LEFT JOIN factory.ticket ticket ON ticket.id=workspace.ticket_id
      WHERE source.workspace_id=${workspaceID}`;
    return source ?? null;
  }
  function view(source: SourceRow): SourceWorkspaceView {
    const identity = workspaceSourceIdentity(source.workspaceID, Number(source.epoch));
    return {
      workspaceID: source.workspaceID,
      label:
        source.kind === "personal"
          ? `Personal · ${source.projectName}`
          : `Ticket · ${source.ticketTitle ?? source.projectName}`,
      state: source.state,
      serviceID: identity.serviceID,
      epoch: identity.epoch,
      failure: source.failure,
    };
  }
  function resources(source: SourceRow): SourceResources {
    const identity = workspaceSourceIdentity(source.workspaceID, Number(source.epoch));
    const capability = workspaceSourceCapability(secret, identity);
    if (hashConnectorToken(capability) !== source.capabilityHash)
      throw new CommandError("unavailable", "Source access capability cannot be recovered");
    return {
      identity,
      namespace: source.namespace,
      projectID: source.projectID,
      revision: source.revision,
      repositoryURL: runtimeFactoryURL(
        `/internal/workspace-source/${source.workspaceID}/${source.epoch}/${capability}`,
      ),
      originURL: source.repositoryURL.startsWith("file://")
        ? source.repositoryURL
        : runtimeRepositoryCloneURL(source.repositoryURL),
      capability,
      filesImage: source.filesImage,
      namespaceUID: source.namespaceUID,
      claimUID: source.claimUID,
      podUID: source.podUID,
      storageNode: source.storageNode,
    };
  }
  async function authority(workspaceID: string, userID: string, sql: AgentTurnTransaction) {
    const [workspace] = await sql<
      Array<{ projectID: string; kind: string; ownerID: string | null }>
    >`SELECT project_id AS "projectID",kind,owner_user_id AS "ownerID" FROM factory.development_workspace WHERE id=${workspaceID}`;
    if (!workspace || (workspace.kind === "personal" && workspace.ownerID !== userID))
      throw new CommandError("not-found", "Workspace not found");
    // Transactional membership locks order admitted writes before normal membership revocation.
    await projectDevelopmentAuthorityIn(sql, userID, workspace.projectID);
    return workspace;
  }
  async function record(
    source: SourceRow,
    outcome: SourceResourceObservation,
    sql: SourceSQL = database.client,
  ) {
    const [updated] =
      await sql`UPDATE factory.workspace_source SET namespace_uid=${outcome.namespaceUID},claim_uid=${outcome.claimUID},pod_uid=${outcome.podUID},storage_node=COALESCE(${outcome.storageNode},storage_node),
      state=${outcome.failed ? "failed" : outcome.ready ? "ready" : "preparing"},failure=${outcome.failed ? "Source preparation failed. Stop and retry source access." : null},create_observed_at=COALESCE(create_observed_at,now()),updated_at=now()
      WHERE workspace_id=${source.workspaceID} AND access_epoch=${source.epoch} AND state IN ('create-intended','preparing','ready') RETURNING workspace_id`;
    if (!updated) throw new CommandError("conflict", "Source lifecycle changed during preparation");
  }
  async function fenceSource(
    workspaceID: string,
    epoch: string,
    writable: boolean,
    sql: SourceSQL,
  ) {
    const source = await row(workspaceID, sql);
    if (!source || source.state === "stopped") return;
    if (!source.podUID) {
      if (source.state === "create-intended" || source.state === "preparing") return;
      throw new CommandError("unavailable", "Source writing fence is unavailable");
    }
    const request = new Request("http://factory.internal/fence", {
      method: "POST",
      body: JSON.stringify({ writerEpoch: Number(epoch), writable }),
    });
    const response = await client.request(
      resources(source),
      "fence",
      request,
      AbortSignal.timeout(10_000),
    );
    if (!response.ok || (await response.json()).confirmed !== true)
      throw new CommandError(
        "unavailable",
        "Source writing fence is unconfirmed. Existing buffers are preserved.",
      );
  }
  function revokeWorkspace(workspaceID: string) {
    for (const [controller, stream] of streams)
      if (stream.workspaceID === workspaceID) controller.abort();
  }
  async function reconcile(workspaceID: string) {
    // Checkout and connection warming must not hold the application pool used
    // by source reads and Stop. This connection owns only this reconciliation.
    const sql = database.coordination();
    const key = `workspace-source:${workspaceID}`;
    try {
      await sql`SELECT pg_advisory_lock(hashtext(${key}))`;
      const source = await row(workspaceID, sql);
      if (!source || source.state === "stopped" || source.state === "failed") return false;
      const input = resources(source);
      if (source.state === "stop-intended") {
        revokeWorkspace(workspaceID);
        await client.stop(input);
        await sql`UPDATE factory.workspace_source SET state='stopped',stopped_at=now(),updated_at=now() WHERE workspace_id=${workspaceID} AND access_epoch=${source.epoch} AND state='stop-intended'`;
        return false;
      }
      // A created execution Pod may be initializing a not-yet-prepared checkout.
      // A new persisted compute intent must not deadlock its independent initializer.
      const [starting] =
        await sql`SELECT id FROM factory.runtime_attempt WHERE workspace_id=${workspaceID} AND kubernetes_uid IS NOT NULL AND state IN ('create-intended','starting','stop-intended','stopping','cleanup-failed') LIMIT 1`;
      if (starting && !source.podUID) return true;
      const observed = await (async () => {
        if (source.podUID) {
          const retained = await client.observe(input);
          if (retained) return retained;
        }
        return client.prepare(input);
      })().catch(async () => {
        // The create may have succeeded before its acknowledgement was lost.
        // Observe the same intended identity; never issue a replacement epoch here.
        const recovered = await client.observe(input);
        if (!recovered) throw new Error("Source creation outcome is unconfirmed");
        return recovered;
      });
      // A ready Pod alone does not make source access ready. Persist its exact outcome
      // before warming the authorized connection, so Stop and recovery retain that identity.
      await record(source, { ...observed, ready: false }, sql);
      if (observed.ready && !observed.failed) {
        await client.connect(
          {
            ...input,
            namespaceUID: observed.namespaceUID,
            claimUID: observed.claimUID,
            podUID: observed.podUID,
            storageNode: observed.storageNode,
          },
          observed,
        );
        await record(source, observed, sql);
      }
      return !observed.ready && !observed.failed;
    } catch {
      await sql`UPDATE factory.workspace_source SET state=CASE WHEN state='ready' THEN 'failed' ELSE state END,failure='Source resources are unavailable. Factory is checking the recorded resource intent.',updated_at=now() WHERE workspace_id=${workspaceID} AND state IN ('create-intended','preparing','ready','stop-intended')`;
      // A failed teardown remains visible and recoverable, but must not launch endless workers.
      return (await row(workspaceID, sql))?.state !== "stop-intended";
    } finally {
      try {
        await sql`SELECT pg_advisory_unlock(hashtext(${key}))`;
      } finally {
        await sql.end({ timeout: 1 });
      }
    }
  }
  function schedule(workspaceID: string) {
    if (closed) return;
    const running = pending.get(workspaceID);
    if (running) {
      running.wakeup = true;
      return;
    }
    const worker = { wakeup: false };
    pending.set(workspaceID, worker);
    void (async () => {
      try {
        const deadline = now() + sourcePreparationTimeoutMS;
        do {
          worker.wakeup = false;
          const retry = await reconcile(workspaceID);
          if (!retry && !worker.wakeup) return;
          const current = await row(workspaceID);
          if (
            !current ||
            !["create-intended", "preparing", "stop-intended"].includes(current.state)
          )
            return;
          await Bun.sleep(200);
        } while (!closed && now() < deadline);
        if (closed) return;
        await database.client`UPDATE factory.workspace_source SET state='failed',failure='Source preparation exceeded its deadline. Stop and retry source access.',updated_at=now() WHERE workspace_id=${workspaceID} AND state IN ('create-intended','preparing')`;
      } finally {
        pending.delete(workspaceID);
        // Only an actual command/recovery wakeup can start another worker after its bound.
        if (worker.wakeup) schedule(workspaceID);
      }
    })().catch(() => {
      console.error("Workspace source reconciliation failed");
    });
  }
  async function ensure(workspaceID: string, userID: string) {
    const images = pinnedSourceImages();
    await database.client.begin((sql) => authority(workspaceID, userID, sql));
    const [runtime] = await database.client<
      Array<{ namespace: string; podName: string; podUID: string }>
    >`SELECT kubernetes_namespace AS namespace,kubernetes_pod_name AS "podName",kubernetes_uid AS "podUID" FROM factory.runtime_attempt WHERE workspace_id=${workspaceID} AND state='ready' ORDER BY generation DESC LIMIT 1`;
    const storageNode = runtime ? await client.executionNode({ ...runtime, workspaceID }) : null;
    await database.client.begin(async (sql) => {
      await authority(workspaceID, userID, sql);
      await persistIntent(workspaceID, images, storageNode, sql);
    });
    const current = await row(workspaceID);
    if (!current) throw new CommandError("unavailable", "Source intent was not recorded");
    if (["create-intended", "preparing", "stop-intended"].includes(current.state))
      schedule(workspaceID);
    return view(current);
  }
  async function persistIntent(
    workspaceID: string,
    images: ReturnType<typeof pinnedSourceImages>,
    storageNode: string | null,
    sql: AgentTurnTransaction,
  ) {
    await sql`SELECT id FROM factory.development_workspace WHERE id=${workspaceID} FOR UPDATE`;
    const existing = await row(workspaceID, sql);
    const epoch = existing ? Number(existing.epoch) + (existing.state === "stopped" ? 1 : 0) : 1;
    const capabilityHash = hashConnectorToken(
      workspaceSourceCapability(secret, workspaceSourceIdentity(workspaceID, epoch)),
    );
    if (!existing)
      await sql`INSERT INTO factory.workspace_source(workspace_id,state,files_image,capability_hash) VALUES(${workspaceID},'create-intended',${images.filesImage},${capabilityHash})`;
    else if (existing.state === "stopped")
      await sql`UPDATE factory.workspace_source SET access_epoch=${epoch},state='create-intended',files_image=${images.filesImage},capability_hash=${capabilityHash},pod_uid=NULL,failure=NULL,create_intended_at=now(),create_observed_at=NULL,stop_intended_at=NULL,stopped_at=NULL,updated_at=now() WHERE workspace_id=${workspaceID}`;
    else if (existing.state === "failed")
      // An explicit authorized retry re-observes the same intent. A deadline does not
      // prove the external create failed, and cannot authorize a replacement Pod or epoch.
      await sql`UPDATE factory.workspace_source SET state='preparing',failure=NULL,updated_at=now() WHERE workspace_id=${workspaceID} AND state='failed'`;
    if (storageNode)
      await sql`UPDATE factory.workspace_source SET storage_node=${storageNode} WHERE workspace_id=${workspaceID} AND storage_node IS NULL`;
  }
  return {
    ensure,
    async fenceChange(changeID: string, epoch: string, writable: boolean) {
      const [workspace] = await database.client<
        { id: string }[]
      >`SELECT id FROM factory.development_workspace WHERE change_id=${changeID}`;
      if (workspace) await fenceSource(workspace.id, epoch, writable, database.client);
    },
    async prepareExecution(attemptID: string): Promise<RuntimeSourceAttachment> {
      const images = pinnedSourceImages();
      // Execution admission already checked the commissioning human. This internal
      // path is constrained by the durable attempt, not by direct Developer access.
      const admitted = async (sql: SourceSQL) => {
        const [attempt] = await sql<Array<{ workspaceID: string }>>`
          SELECT attempt.workspace_id AS "workspaceID" FROM factory.runtime_attempt attempt
          JOIN factory.development_workspace workspace ON workspace.id=attempt.workspace_id
            AND workspace.project_id=attempt.project_id
          WHERE attempt.id=${attemptID} AND attempt.state='create-intended'
            AND attempt.stop_intended_at IS NULL
            AND (workspace.kind='personal' OR EXISTS (
              SELECT 1 FROM factory.change change JOIN factory.ticket ticket ON ticket.id=change.ticket_id
              WHERE change.id=workspace.change_id AND change.id=attempt.change_id
                AND change.runtime_attempt_id=attempt.id AND change.cancel_requested_at IS NULL
                AND change.state IN ('starting','active','failed') AND ticket.trashed_at IS NULL
            ))`;
        if (!attempt)
          throw new CommandError("conflict", "Execution source intent is no longer active");
        return attempt.workspaceID;
      };
      const workspaceID = await database.client.begin(async (sql) => {
        const workspaceID = await admitted(sql);
        await persistIntent(workspaceID, images, null, sql);
        return workspaceID;
      });
      if ((await row(workspaceID))?.state !== "ready") schedule(workspaceID);
      const deadline = now() + sourcePreparationTimeoutMS;
      while (!closed && now() < deadline) {
        await admitted(database.client);
        const current = await row(workspaceID);
        if (current?.state === "ready") {
          if (!current.namespaceUID || !current.claimUID || !current.storageNode)
            throw new CommandError("unavailable", "Canonical source placement is unconfirmed");
          const observed = await client.observe(resources(current));
          if (
            !observed?.ready ||
            observed.failed ||
            observed.namespaceUID !== current.namespaceUID ||
            observed.claimUID !== current.claimUID ||
            observed.storageNode !== current.storageNode
          )
            throw new CommandError(
              "unavailable",
              "Canonical source resources do not match execution placement",
            );
          await admitted(database.client);
          return {
            workspaceID,
            namespaceUID: current.namespaceUID,
            claimUID: current.claimUID,
            storageNode: current.storageNode,
          };
        }
        if (current && ["failed", "stop-intended", "stopped"].includes(current.state))
          throw new CommandError("unavailable", "Canonical source is unavailable for execution");
        await Bun.sleep(100);
      }
      throw new CommandError("unavailable", "Canonical source preparation exceeded its deadline");
    },
    async repository(
      request: Request,
      workspaceID: string,
      epoch: string,
      capability: string,
      prefix: string,
    ) {
      const source = await row(workspaceID);
      if (
        !source ||
        source.epoch !== epoch ||
        !["create-intended", "preparing"].includes(source.state) ||
        hashConnectorToken(capability) !== source.capabilityHash
      )
        return new Response(null, { status: 403 });
      const url = new URL(request.url);
      const suffix = url.pathname.slice(prefix.length);
      if (
        !(
          (suffix === "/info/refs" &&
            request.method === "GET" &&
            url.searchParams.get("service") === "git-upload-pack") ||
          (suffix === "/git-upload-pack" && request.method === "POST" && url.search === "")
        )
      )
        return new Response(null, { status: 403 });
      return serveRuntimeRepository(request, source.repositoryURL, prefix);
    },
    async ensurePersonal(projectID: string, userID: string) {
      const identity = personalWorkspaceIdentity(projectID, userID);
      // No runtime, Change, App, turn or model request is created by source preparation.
      await database.client.begin(async (sql) => {
        await projectDevelopmentAuthorityIn(sql, userID, projectID);
        await sql`SELECT pg_advisory_xact_lock(hashtext(${`runtime:${identity.workspaceID}`}))`;
        const [existing] =
          await sql`SELECT id FROM factory.development_workspace WHERE id=${identity.workspaceID}`;
        if (existing) return;
        const [project] = await sql<
          Array<{ repositoryURL: string; defaultBranch: string }>
        >`SELECT repository_url AS "repositoryURL",default_branch AS "defaultBranch" FROM factory.project WHERE id=${projectID}`;
        if (!project) throw new CommandError("not-found", "Project not found");
        const revision = await resolveRepositoryRevision(
          project.repositoryURL,
          project.defaultBranch,
        );
        await sql`INSERT INTO factory.development_workspace(id,project_id,kind,owner_user_id,source_branch,source_revision,kubernetes_namespace,volume_name,created_by) VALUES(${identity.workspaceID},${projectID},'personal',${userID},${project.defaultBranch},${revision},${identity.kubernetesNamespace},${identity.volumeName},${userID})`;
      });
      return ensure(identity.workspaceID, userID);
    },
    async ensureChange(changeID: string, userID: string) {
      const identity = ticketWorkspaceIdentity(changeID);
      await database.client.begin(async (sql) => {
        await sql`SELECT pg_advisory_xact_lock(hashtext(${`runtime:${identity.workspaceID}`}))`;
        const [change] = await sql<
          Array<{
            projectID: string;
            ticketID: string;
            branch: string;
            revision: string;
            state: string;
            ready: boolean;
          }>
        >`SELECT change.project_id AS "projectID",change.ticket_id AS "ticketID",change.branch_name AS branch,change.base_sha AS revision,change.state,operation.state='succeeded' AND operation.observed_head_sha=change.base_sha AS ready FROM factory.change change JOIN factory.branch_create_operation operation ON operation.change_id=change.id WHERE change.id=${changeID} FOR SHARE OF change`;
        if (!change) throw new CommandError("not-found", "Change not found");
        await projectDevelopmentAuthorityIn(sql, userID, change.projectID);
        if (!change.ready || !["starting", "active", "failed"].includes(change.state))
          throw new CommandError("unavailable", "Change source is not ready for editing");
        await sql`INSERT INTO factory.development_workspace(id,project_id,kind,ticket_id,change_id,source_branch,source_revision,kubernetes_namespace,volume_name,created_by) VALUES(${identity.workspaceID},${change.projectID},'ticket',${change.ticketID},${changeID},${change.branch},${change.revision},${identity.kubernetesNamespace},${identity.volumeName},${userID}) ON CONFLICT(id) DO NOTHING`;
      });
      return ensure(identity.workspaceID, userID);
    },
    async get(workspaceID: string, userID: string) {
      await database.client.begin((sql) => authority(workspaceID, userID, sql));
      const current = await row(workspaceID);
      if (!current) throw new CommandError("not-found", "Source access not prepared");
      return view(current);
    },
    async forward(workspaceID: string, userID: string, operation: string, request: Request) {
      if (operation === "events" ? request.method !== "GET" : request.method !== "POST")
        return new Response(null, { status: 405 });
      if (!/^(stat|list|read|write|mkdir|rename|delete|search|events)$/.test(operation))
        return new Response(null, { status: 404 });
      const controller = new AbortController();
      const onAbort = () => controller.abort();
      request.signal.addEventListener("abort", onAbort, { once: true });
      if (request.signal.aborted) controller.abort();
      let retained = false;
      try {
        // Do not hold membership locks while a browser slowly uploads its request body.
        const content =
          operation === "events" ? undefined : await boundedSourceBody(request, controller.signal);
        const admittedRequest =
          content === undefined
            ? request
            : new Request(request.url, {
                method: "POST",
                body: content,
                signal: controller.signal,
              });
        const result = await database.client.begin(async (sql) => {
          if (["write", "mkdir", "rename", "delete"].includes(operation)) {
            const writer = await workspaceWriteAuthorityIn(sql, workspaceID, userID);
            if (writer.writerEpoch) {
              await fenceSource(workspaceID, writer.writerEpoch, true, sql);
              admittedRequest.headers.set("X-Factory-Writer-Epoch", writer.writerEpoch);
            }
          }
          const workspace = await authority(workspaceID, userID, sql);
          const source = await row(workspaceID, sql);
          if (source?.state !== "ready")
            throw new CommandError("unavailable", "Workspace source is preparing or stopped");
          streams.set(controller, { userID, workspaceID, projectID: workspace.projectID });
          // Register before releasing permission locks so revoke cannot miss an admitted stream.
          return client.request(resources(source), operation, admittedRequest, controller.signal);
        });
        if (operation !== "events") return result;
        if (!result.ok || !result.body) return result;
        const reader = result.body.getReader();
        retained = true;
        const body = new ReadableStream<Uint8Array>({
          async pull(target) {
            try {
              const chunk = await reader.read();
              if (chunk.done) {
                target.close();
                finish();
                return;
              }
              target.enqueue(chunk.value);
            } catch {
              target.close();
              finish();
            }
          },
          async cancel() {
            controller.abort();
            await reader.cancel().catch(() => {});
            finish();
          },
        });
        function finish() {
          streams.delete(controller);
          request.signal.removeEventListener("abort", onAbort);
        }
        return new Response(body, {
          status: result.status,
          headers: {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-store",
            "X-Content-Type-Options": "nosniff",
          },
        });
      } finally {
        if (!retained) {
          streams.delete(controller);
          request.signal.removeEventListener("abort", onAbort);
        }
      }
    },
    async stop(workspaceID: string, userID: string) {
      await database.client.begin(async (sql) => {
        await authority(workspaceID, userID, sql);
        await sql`UPDATE factory.workspace_source SET state='stop-intended',stop_intended_at=COALESCE(stop_intended_at,now()),updated_at=now() WHERE workspace_id=${workspaceID} AND state<>'stopped'`;
      });
      revokeWorkspace(workspaceID);
      schedule(workspaceID);
    },
    async revokeMember(projectID: string, userID: string) {
      for (const [controller, stream] of streams)
        if (stream.userID === userID && stream.projectID === projectID) controller.abort();
    },
    revokeUser(userID: string) {
      for (const [controller, stream] of streams) if (stream.userID === userID) controller.abort();
    },
    async reconcileUserAccess(userID: string) {
      const allowed = new Map<string, boolean>();
      for (const [controller, stream] of streams) {
        if (stream.userID !== userID) continue;
        if (!allowed.has(stream.workspaceID)) {
          try {
            await database.client.begin((sql) => authority(stream.workspaceID, userID, sql));
            allowed.set(stream.workspaceID, true);
          } catch (cause) {
            if (
              !(cause instanceof CommandError) ||
              !["forbidden", "not-found"].includes(cause.code)
            )
              throw cause;
            allowed.set(stream.workspaceID, false);
          }
        }
        if (!allowed.get(stream.workspaceID)) controller.abort();
      }
    },
    async recover() {
      // A persisted ready outcome does not establish connectivity in this process.
      // Withdraw it before serving requests, not after the first infrastructure read.
      await database.client`UPDATE factory.workspace_source SET state='preparing',updated_at=now() WHERE state='ready'`;
      const rows = await database.client<
        Array<{ workspaceID: string }>
      >`SELECT workspace_id AS "workspaceID" FROM factory.workspace_source WHERE state IN ('create-intended','preparing','ready','stop-intended')`;
      for (const source of rows) schedule(source.workspaceID);
    },
    async close() {
      closed = true;
      for (const controller of streams.keys()) controller.abort();
      client.close();
      const deadline = now() + 5_000;
      while (pending.size && now() < deadline) await Bun.sleep(10);
    },
  };
}
