import { stripVTControlCharacters } from "node:util";
import type { createDatabase } from "../../../../packages/db/src/client";
import { createForgejoClient } from "../../../../packages/forge/src/forge";
import {
  boundForgeRepositoryFromURL,
  forgeRepositoryFromURL,
} from "../../../../packages/forge/src/repository";
import { nativeLifecycleWindowMS } from "../../../../packages/runtime-domain/src/timing";
import type { SubstrateCall } from "../../../../packages/runtime-kubernetes/src/substrate-control";
import {
  parseSystemContract,
  SystemContractError,
} from "../../../../packages/system-contract/src/system-contract";
import { personalWorkspaceIdentity } from "../../../../packages/workspace-domain/src/workspace";
import { workspaceWriteAuthorityIn } from "../access/change-writer";
import { createAccessController, projectAuthorityIn } from "../access/controller";
import {
  createChangeAgentStop,
  type PendingWriterHandoff,
  type RetainedStopTarget,
  requirePendingWriterHandoffIn,
  requireStoppedAgentInputsIn,
} from "../agent/stop";
import type { AgentTurnTransaction } from "../agent/turn-store";
import { CommandError } from "../command-error";
import { reportFailure } from "../failure-log";
import { requireSetupReady } from "../setup/execution-gate";
import type { SubstrateSourceHandoff } from "../workspace/substrate-source";
import { readRepositoryFileAtRevision } from "./git-http";
import type { RuntimeHub } from "./hub";
import type { createSubstrateCapacity } from "./substrate-capacity";
import { createSubstrateIsolated } from "./substrate-isolated";
import { createSubstratePrebuild } from "./substrate-prebuild";
import { createSubstrateVerification } from "./substrate-verification";
import {
  configuredSubstrateInstallation,
  createSubstrateWorkspaces,
  type SubstrateInstallationConfiguration,
  substrateInstallationConfiguration,
  substrateWorkspaceConfiguration,
} from "./substrate-workspaces";
import type { RuntimeAttemptView } from "./types";

type Database = ReturnType<typeof createDatabase>;
export type RuntimeControllerOptions = {
  configuration?: SubstrateInstallationConfiguration;
  call?: SubstrateCall;
  provisionerCall?: SubstrateCall;
  sources?: SubstrateSourceHandoff;
  capacity?: Pick<ReturnType<typeof createSubstrateCapacity>, "ensure" | "requireReady">;
  stopCoding?: (changeID: string, handoff?: PendingWriterHandoff) => Promise<unknown>;
};

// Factory owns commands, authority and persisted intent. There is exactly one
// execution backend: the admitted official Substrate Actor adapter.
export function createRuntimeController(
  database: Database,
  hub: RuntimeHub,
  connectorSecret: string,
  options: RuntimeControllerOptions = {},
) {
  const selected = options.configuration ?? configuredSubstrateInstallation();
  if (!selected) throw new Error("Factory requires its Substrate installation configuration");
  const installation = substrateInstallationConfiguration(selected);
  const {
    FACTORY_FORGEJO_API_URL,
    FACTORY_FORGEJO_PUBLIC_URL,
    FACTORY_FORGEJO_TOKEN,
    FACTORY_FORGEJO_OWNER,
  } = process.env;
  if (!FACTORY_FORGEJO_API_URL || !FACTORY_FORGEJO_TOKEN || !FACTORY_FORGEJO_OWNER)
    throw new Error("Forgejo configuration is required");
  const forgeBinding = {
    apiURL: FACTORY_FORGEJO_API_URL,
    publicURL: FACTORY_FORGEJO_PUBLIC_URL,
    owner: FACTORY_FORGEJO_OWNER,
  };
  const forge = createForgejoClient({
    apiURL: FACTORY_FORGEJO_API_URL,
    token: FACTORY_FORGEJO_TOKEN,
  });
  const projects = new Map<
    string,
    {
      workspaces: ReturnType<typeof createSubstrateWorkspaces>;
      verification: ReturnType<typeof createSubstrateVerification>;
      prebuild: ReturnType<typeof createSubstratePrebuild>;
      isolated: ReturnType<typeof createSubstrateIsolated>;
    }
  >();
  async function readContract(repositoryURL: string, revision: string) {
    let content: string;
    try {
      if (repositoryURL.startsWith("file://")) {
        content = await readRepositoryFileAtRevision(
          repositoryURL,
          revision,
          ".factory/system.json",
        );
      } else {
        const repository = forgeRepositoryFromURL(
          repositoryURL,
          () => new SystemContractError("Project repository URL is invalid"),
        );
        if (repository.owner !== FACTORY_FORGEJO_OWNER)
          throw new Error("Project Forge owner is not allowed");
        content = await forge.getFile(repository, ".factory/system.json", revision);
      }
    } catch (cause) {
      throw new SystemContractError(
        `Cannot read .factory/system.json at ${revision.slice(0, 12)}: ${cause instanceof Error ? cause.message : "unknown error"}`,
      );
    }
    return parseSystemContract(content);
  }
  function project(projectID: string) {
    const existing = projects.get(projectID);
    if (existing) return existing;
    const configuration = substrateWorkspaceConfiguration({ ...installation, projectID });
    const owners = {
      workspaces: createSubstrateWorkspaces(
        database,
        hub,
        connectorSecret,
        configuration,
        options.call,
        options.provisionerCall,
        readContract,
        options.sources,
        options.capacity,
      ),
      verification: createSubstrateVerification(
        database,
        hub,
        connectorSecret,
        configuration,
        options.call,
        options.provisionerCall,
        options.capacity,
      ),
      prebuild: createSubstratePrebuild(
        database,
        hub,
        connectorSecret,
        configuration,
        options.call,
        options.provisionerCall,
        options.capacity,
      ),
      isolated: createSubstrateIsolated(
        database,
        hub,
        connectorSecret,
        configuration,
        readContract,
        options.call,
        options.provisionerCall,
        options.capacity,
      ),
    };
    projects.set(projectID, owners);
    return owners;
  }
  async function execution(attemptID: string) {
    const [attempt] = await database.client<{ projectID: string }[]>`
      SELECT project_id AS "projectID" FROM factory.runtime_attempt WHERE id=${attemptID}`;
    if (!attempt) throw new CommandError("not-found", "Runtime Attempt not found");
    const owners = project(attempt.projectID);
    const runtime =
      (await owners.isolated.forAttempt(attemptID)) ??
      (await owners.prebuild.forAttempt(attemptID)) ??
      (await owners.verification.forAttempt(attemptID)) ??
      (await owners.workspaces.forAttempt(attemptID));
    if (!runtime) throw new Error("Runtime Attempt requires its persisted Substrate owner binding");
    return runtime;
  }
  async function observe(attempt: RuntimeAttemptView) {
    const observation = await (await execution(attempt.id)).get();
    if (observation.state === "ACTOR_STATE_CRASHED") {
      const [recorded] = await database.client<
        Pick<RuntimeAttemptView, "state" | "failure" | "updatedAt">[]
      >`
        SELECT state,failure,updated_at AS "updatedAt" FROM factory.runtime_attempt WHERE id=${attempt.id}`;
      if (!recorded) throw new Error("Recorded runtime outcome is unavailable");
      return { ...attempt, ...recorded, native: observation };
    }
    return { ...attempt, native: observation };
  }
  async function verificationJob(verificationID: string) {
    const [row] = await database.client<
      { handle: string | null; runID: string | null; commit: string; repository: string }[]
    >`
      SELECT verification.runner_job_handle AS handle,verification.action_run_id AS "runID",
        verification.commit_sha AS commit,project.repository_url AS repository
      FROM factory.verification verification JOIN factory.change change ON change.id=verification.change_id
      JOIN factory.project project ON project.id=change.project_id WHERE verification.id=${verificationID}`;
    if (!row) return undefined;
    const repository = boundForgeRepositoryFromURL(row.repository, forgeBinding);
    if (row.handle || !row.runID) return row.handle ?? undefined;
    const handle = await forge.verificationJobHandle(repository, Number(row.runID), row.commit);
    const [saved] = await database.client<{ handle: string }[]>`
      UPDATE factory.verification SET runner_job_handle=COALESCE(runner_job_handle,${handle})
      WHERE id=${verificationID} AND action_run_id=${row.runID} AND commit_sha=${row.commit}
        AND state IN ('pending','runner-starting','running') RETURNING runner_job_handle AS handle`;
    if (!saved || saved.handle !== handle)
      throw new Error("Verification job authority changed before execution");
    return saved.handle;
  }
  const reconnects = new Map<string, ReturnType<typeof setTimeout>>();
  function clearReconnect(attemptID: string) {
    const timer = reconnects.get(attemptID);
    if (timer) clearTimeout(timer);
    reconnects.delete(attemptID);
  }
  function observeReconnectLater(attemptID: string) {
    if (reconnects.has(attemptID)) return;
    const timer = setTimeout(() => {
      reconnects.delete(attemptID);
      void status(attemptID, "disconnected", "Waiting for runtime connectors").catch(
        reportFailure("Runtime reconnect observation is unavailable"),
      );
    }, 15_000);
    timer.unref();
    reconnects.set(attemptID, timer);
  }
  async function status(attemptID: string, phase: string, error?: string) {
    const native = await execution(attemptID);
    // A retained Source Parent can finish its recorded pause without a Child,
    // a new Build grant, or a fresh native Resume.
    if (phase === "source-ready") return native.recover();
    if (["stopped", "failed", "cleanup-failed"].includes(phase)) {
      const [preparation] = await database.client<{ id: string; state: string }[]>`
        SELECT id,state FROM factory.project_image_preparation WHERE runtime_attempt_id=${attemptID}`;
      if (preparation) {
        const unsupported = error?.startsWith(
          "prebuild Compose cannot depend on the producer environment",
        );
        if (preparation.state === "running")
          await database.client`UPDATE factory.project_image_preparation
            SET state=${unsupported ? "unsupported" : "failed"},
              failure=${unsupported ? "Image preparation was skipped: Compose build inputs depend on environment variables. Normal startup remains available." : (error ?? "Image preparation ended without a confirmed publication; normal startup remains available.")},
              updated_at=now() WHERE id=${preparation.id} AND state='running'`;
        await native.stop();
        return;
      }
    }
    const failed = ["failed", "cleanup-failed", "stopped"].includes(phase);
    const reconnecting = ["disconnected", "reconnecting"].includes(phase);
    if (phase !== "ready" && !failed && !reconnecting) return;
    if (reconnecting && hub.ready(attemptID)) return;
    const observed = await native.get();
    if (reconnecting && hub.ready(attemptID)) return;
    const ready =
      phase === "ready" && observed.state === "ACTOR_STATE_RUNNING" && hub.ready(attemptID);
    const apps = hub.appChannels(attemptID);
    const healthy = ready
      ? Object.fromEntries(
          hub
            .processes(attemptID)
            .filter((process) => process.state === "running" && apps.includes(process.name))
            .map((process) => [process.name, new Date().toISOString()]),
        )
      : {};
    const changed = await database.client`UPDATE factory.runtime_attempt SET
      state=CASE WHEN ${ready} THEN 'ready'::factory.runtime_attempt_state WHEN ${failed} THEN 'failed'::factory.runtime_attempt_state WHEN ${reconnecting} THEN 'starting'::factory.runtime_attempt_state ELSE state END,
      ready_at=CASE WHEN ${ready} THEN COALESCE(ready_at,now()) ELSE ready_at END,
      app_ready_at=CASE WHEN ${ready} THEN ${JSON.stringify(healthy)}::text::jsonb || app_ready_at ELSE app_ready_at END,
      failure=${ready ? null : (error ?? `Native observation: ${observed.state}; Connector ${phase}`)},updated_at=now()
      WHERE id=${attemptID} AND state IN ('starting','ready') AND stop_intended_at IS NULL`;
    if (changed.count === 1 && ready) {
      clearReconnect(attemptID);
      await database.client`UPDATE factory.change SET state='active',version=version+1
        WHERE runtime_attempt_id=${attemptID} AND state='starting'`;
    } else if (changed.count === 1 && reconnecting) observeReconnectLater(attemptID);
  }
  hub.onAppRunning((attemptID, app) => {
    void database.client`UPDATE factory.runtime_attempt
      SET app_ready_at=jsonb_set(app_ready_at,ARRAY[${app}]::text[],to_jsonb(now()::text))
      WHERE id=${attemptID} AND state='ready' AND NOT app_ready_at ? ${app}`.catch(
      reportFailure("App readiness timestamp is unavailable"),
    );
  });
  return {
    async supportsInitialSourceRole(attemptID: string, sql: AgentTurnTransaction) {
      const [attempt] = await sql<{ projectID: string }[]>`
        SELECT project_id AS "projectID" FROM factory.runtime_attempt WHERE id=${attemptID}`;
      if (!attempt) return false;
      const owner = await project(attempt.projectID).workspaces.forAttempt(attemptID, sql);
      return owner ? owner.supportsInitialSourceRole(sql) : false;
    },
    async settleRetainedInputStop(target: RetainedStopTarget, signal: AbortSignal) {
      return (await execution(target.attemptID)).settleInputStop(target, signal);
    },
    async authorizeConnector(request: Request) {
      const attemptID = request.headers.get("x-factory-runtime-attempt");
      if (!attemptID) return false;
      try {
        return await (await execution(attemptID)).authorizeConnector(request);
      } catch {
        return false;
      }
    },
    async admitNativeCapacity() {
      await options.capacity?.ensure();
    },
    async recover() {
      const ids = await database.client<{ projectID: string }[]>`
        SELECT DISTINCT project_id AS "projectID" FROM factory.runtime_attempt`;
      let observing = false;
      return () => {
        if (observing) return;
        observing = true;
        for (const id of ids) {
          const owners = project(id.projectID);
          for (const owner of [
            owners.workspaces,
            owners.verification,
            owners.prebuild,
            owners.isolated,
          ])
            void owner.recover().catch(reportFailure("Native runtime observation is unavailable"));
        }
      };
    },
    async start(
      projectID: string,
      userID: string,
      selectedWorkspaceID?: string,
      recordStart?: (sql: AgentTurnTransaction, workspaceID: string) => Promise<void>,
    ) {
      await createAccessController(database).requireDevelopment(userID, projectID);
      await requireSetupReady(database.client, projectID);
      if (selectedWorkspaceID) {
        const selected = await database.client.begin((sql) =>
          workspaceWriteAuthorityIn(sql, selectedWorkspaceID, userID),
        );
        if (selected.kind !== "personal" || selected.projectID !== projectID || !selected.ownerID)
          throw new CommandError("not-found", "Personal Workspace not found");
        if (
          selectedWorkspaceID !== personalWorkspaceIdentity(projectID, selected.ownerID).workspaceID
        )
          throw new CommandError(
            "conflict",
            "Personal Workspace identity differs from its retained owner",
          );
      }
      return this.get(
        await project(projectID).workspaces.start(
          userID,
          undefined,
          selectedWorkspaceID,
          recordStart,
        ),
      );
    },
    async startPersisted(changeID: string, userID: string) {
      const [change] = await database.client<{ projectID: string }[]>`
        SELECT project_id AS "projectID" FROM factory.change WHERE id=${changeID}`;
      if (!change) throw new CommandError("not-found", "Change not found");
      await requireSetupReady(database.client, change.projectID);
      return this.get(await project(change.projectID).workspaces.start(userID, changeID));
    },
    async ensureStaging(projectID: string, userID: string) {
      await requireSetupReady(database.client, projectID);
      return this.get(await project(projectID).isolated.stage(userID));
    },
    async startProjectPrebuild(preparationID: string) {
      const [preparation] = await database.client<{ projectID: string }[]>`
        SELECT project_id AS "projectID" FROM factory.project_image_preparation WHERE id=${preparationID} AND state IN ('pending','running')`;
      if (!preparation) return;
      await project(preparation.projectID).prebuild.start(preparationID);
    },
    async startVerification(verificationID: string, userID: string) {
      const [verification] = await database.client<{ projectID: string }[]>`
        SELECT change.project_id AS "projectID" FROM factory.verification verification
        JOIN factory.change change ON change.id=verification.change_id WHERE verification.id=${verificationID}`;
      if (!verification) return null;
      await database.client.begin((sql) => projectAuthorityIn(sql, userID, verification.projectID));
      await verificationJob(verificationID);
      return this.get(
        await project(verification.projectID).verification.start(verificationID, userID),
      );
    },
    async startPublication(publicationID: string, userID: string) {
      const [publication] = await database.client<{ projectID: string }[]>`
        SELECT release.project_id AS "projectID" FROM factory.release_attempt publication
        JOIN factory.project_release release ON release.id=publication.release_id WHERE publication.id=${publicationID}`;
      if (!publication) throw new CommandError("not-found", "Publication not found");
      return this.get(await project(publication.projectID).isolated.publish(publicationID, userID));
    },
    async startStagingReplacement(promotionID: string, userID: string) {
      const [promotion] = await database.client<{ projectID: string }[]>`
        SELECT project_id AS "projectID" FROM factory.promotion_operation WHERE id=${promotionID}`;
      if (!promotion) throw new CommandError("not-found", "Promotion not found");
      return this.get(await project(promotion.projectID).isolated.stage(userID, promotionID));
    },
    async resumeForApp(attemptID: string, userID: string) {
      await createAccessController(database).requireRuntime(userID, attemptID, "app");
      await (await execution(attemptID)).resume(userID);
      return this.get(attemptID);
    },
    async pause(attemptID: string) {
      try {
        await (await execution(attemptID)).suspend();
      } catch (cause) {
        const detail = stripVTControlCharacters(
          cause instanceof Error ? cause.message : "Native Pause is unconfirmed",
        )
          // biome-ignore lint/suspicious/noControlCharactersInRegex: Native errors must be persistable PostgreSQL text.
          .replace(/[\u0000-\u001f\u007f]/g, " ")
          .replace(/\s+/g, " ")
          .trim()
          .slice(0, 2_000);
        const message = detail || "Native Pause is unconfirmed";
        await database.client`UPDATE factory.runtime_attempt SET failure=COALESCE(failure,${message}),updated_at=now()
          WHERE id=${attemptID} AND state='pausing' AND stop_intended_at IS NULL`;
        throw cause;
      }
      return this.get(attemptID);
    },
    async stop(attemptID: string, handoff?: PendingWriterHandoff) {
      clearReconnect(attemptID);
      if (handoff) await requirePendingWriterHandoffIn(database.client, attemptID, handoff);
      const [coding] = await database.client<{ changeID: string }[]>`
        SELECT change.id AS "changeID" FROM factory.runtime_attempt attempt
        JOIN factory.change change ON change.id=attempt.change_id AND change.runtime_attempt_id=attempt.id
        LEFT JOIN factory.change_agent_session session ON session.change_id=change.id AND session.runtime_attempt_id=attempt.id
        WHERE attempt.id=${attemptID}
          AND (session.stop_pending OR session.state NOT IN ('committed','stopped')
            OR EXISTS(SELECT 1 FROM factory.agent_turn turn WHERE turn.change_id=change.id
              AND turn.state IN ('pending','dispatching','running','uncertain')))`;
      const codingStop = coding
        ? createChangeAgentStop(database, hub, undefined, (id) => this.get(id))
        : undefined;
      if (coding && codingStop) {
        if (options.stopCoding) await options.stopCoding(coding.changeID, handoff);
        else {
          await codingStop.persist(coding.changeID, handoff);
          await codingStop.confirm(coding.changeID);
        }
      }
      // Do not hold the native Workspace lock while taking Turn locks or
      // waiting for ordered engine HTTP. The adapter checks this barrier again
      // under its own lifecycle lock before snapshot or deletion.
      await requireStoppedAgentInputsIn(database.client, attemptID, handoff);
      await (await execution(attemptID)).stop(handoff);
      if (coding && codingStop && !(await codingStop.confirm(coding.changeID)))
        throw new CommandError("unavailable", "Compute stopped but Coding Stop is not confirmed");
      return this.get(attemptID);
    },
    async startFresh(attemptID: string, userID: string) {
      const [attempt] = await database.client<
        {
          projectID: string;
          changeID: string | null;
          workspaceID: string | null;
          confirmed: boolean;
        }[]
      >`
        SELECT project_id AS "projectID",change_id AS "changeID",workspace_id AS "workspaceID",resume_failed_at IS NOT NULL AS confirmed
        FROM factory.runtime_attempt WHERE id=${attemptID}`;
      if (!attempt?.workspaceID) throw new CommandError("not-found", "Workspace not found");
      await database.client.begin((sql) =>
        workspaceWriteAuthorityIn(sql, attempt.workspaceID ?? "", userID),
      );
      if (!attempt.confirmed)
        throw new CommandError("conflict", "Factory has not confirmed that the restore failed");
      const stopped = await this.stop(attemptID);
      if (stopped?.state !== "stopped")
        throw new CommandError(
          "unavailable",
          "Original runtime cleanup is not confirmed; nothing new was started",
        );
      return attempt.changeID
        ? this.startPersisted(attempt.changeID, userID)
        : this.start(attempt.projectID, userID, attempt.workspaceID);
    },
    async get(attemptID: string) {
      const [attempt] = await database.client<RuntimeAttemptView[]>`
        SELECT attempt.id,attempt.project_id AS "projectId",attempt.change_id AS "changeId",
          attempt.workspace_id AS "workspaceId",workspace.kind AS "workspaceKind",workspace.owner_user_id AS "ownerUserId",
          attempt.generation,attempt.revision,COALESCE(attempt.isolated_kind::text,workspace.kind::text) AS "runtimeKind",
          COALESCE(staging.runtime_attempt_id=attempt.id,false) AS "currentStaging",attempt.state,attempt.failure,
          attempt.created_at AS "createdAt",attempt.updated_at AS "updatedAt",attempt.ready_at AS "readyAt",attempt.app_ready_at AS "appReadyAt",
          (attempt.state IN ('resuming','cleanup-failed') AND attempt.resume_failed_at IS NOT NULL) AS "restoreFailed"
        FROM factory.runtime_attempt attempt LEFT JOIN factory.development_workspace workspace ON workspace.id=attempt.workspace_id
        LEFT JOIN factory.staging_preview staging ON staging.project_id=attempt.project_id WHERE attempt.id=${attemptID}`;
      return attempt ? observe(attempt) : null;
    },
    async list(projectID: string | undefined, userID: string) {
      const attempts = await database.client<RuntimeAttemptView[]>`
        SELECT attempt.id,attempt.project_id AS "projectId",attempt.change_id AS "changeId",
          attempt.workspace_id AS "workspaceId",workspace.kind AS "workspaceKind",workspace.owner_user_id AS "ownerUserId",
          attempt.generation,attempt.revision,COALESCE(attempt.isolated_kind::text,workspace.kind::text) AS "runtimeKind",
          COALESCE(staging.runtime_attempt_id=attempt.id,false) AS "currentStaging",attempt.state,attempt.failure,
          attempt.created_at AS "createdAt",attempt.updated_at AS "updatedAt",attempt.ready_at AS "readyAt",attempt.app_ready_at AS "appReadyAt",
          (attempt.state IN ('resuming','cleanup-failed') AND attempt.resume_failed_at IS NOT NULL) AS "restoreFailed"
        FROM factory.runtime_attempt attempt LEFT JOIN factory.development_workspace workspace ON workspace.id=attempt.workspace_id
        LEFT JOIN factory.staging_preview staging ON staging.project_id=attempt.project_id
        WHERE (${projectID ?? null}::uuid IS NULL OR attempt.project_id=${projectID ?? null})
          AND attempt.isolated_kind IS DISTINCT FROM 'prebuild'
          AND (workspace.kind IS DISTINCT FROM 'personal' OR workspace.owner_user_id=${userID}
            OR EXISTS(SELECT 1 FROM factory.workspace_share member WHERE member.workspace_id=workspace.id AND member.user_id=${userID}
              AND member.revoked_at IS NULL AND EXISTS(SELECT 1 FROM factory.project_membership developer
                WHERE developer.project_id=attempt.project_id AND developer.user_id=${userID} AND developer.role='developer')))
          AND (EXISTS(SELECT 1 FROM factory.administrator WHERE user_id=${userID})
            OR EXISTS(SELECT 1 FROM factory.project_membership WHERE project_id=attempt.project_id AND user_id=${userID}))
          AND (${projectID ?? null}::uuid IS NULL OR attempt.state NOT IN ('stopped','failed') OR staging.runtime_attempt_id=attempt.id
            OR attempt.id IN (SELECT DISTINCT ON (COALESCE(workspace_id::text,isolated_kind::text||':'||COALESCE(change_id::text,project_id::text))) id
              FROM factory.runtime_attempt WHERE project_id=${projectID ?? null}
              ORDER BY COALESCE(workspace_id::text,isolated_kind::text||':'||COALESCE(change_id::text,project_id::text)),generation DESC,created_at DESC))
        ORDER BY attempt.created_at DESC`;
      // Inventory reports saved Factory state, not current Actor liveness.
      // Keep it readable while the native API is unavailable. Explicit get()
      // and lifecycle commands still require the original native owner and
      // its live observation; recorded ready never supplies that authority.
      return [...attempts];
    },
    async processOutput(attemptID: string) {
      const [attempt] = await database.client<
        { state: string }[]
      >`SELECT state FROM factory.runtime_attempt WHERE id=${attemptID}`;
      if (!attempt) throw new CommandError("not-found", "Runtime Attempt not found");
      if (!["starting", "ready"].includes(attempt.state))
        return { processes: [{ name: "app", state: attempt.state, output: "" }] };
      const processes = hub.processes(attemptID);
      return {
        processes: processes.length
          ? processes
          : [
              {
                name: "app",
                state: attempt.state === "ready" ? "running" : "starting",
                output: "",
              },
            ],
      };
    },
    async processAction(
      attemptID: string,
      process: string,
      action: "start" | "stop" | "restart",
      options?: {
        beforeSend?: (send: () => void) => Promise<void>;
        waitForReady?: boolean;
        signal?: AbortSignal;
      },
    ) {
      const [attempt] = await database.client<
        { ready: boolean; development: boolean; contract: unknown }[]
      >`
        SELECT attempt.state='ready' AND attempt.stop_intended_at IS NULL AS ready,
          attempt.workspace_id IS NOT NULL AS development,
          provision.intent->'systemContract' AS contract
        FROM factory.runtime_attempt attempt
        LEFT JOIN factory.substrate_workspace provision ON provision.workspace_id=attempt.workspace_id
          AND provision.generation=attempt.generation
        WHERE attempt.id=${attemptID}`;
      if (!attempt?.ready || !attempt.development)
        throw new Error("Development Workspace is not ready");
      if (!hub.hasAppChannel(attemptID, process))
        throw new Error("Declared App process does not exist");
      const app =
        options?.waitForReady && action !== "stop"
          ? (() => {
              const contract = parseSystemContract(JSON.stringify(attempt.contract));
              const app = contract.apps.find(
                (app) => (app.id === contract.primaryApp ? "app" : `app-${app.id}`) === process,
              );
              if (!app) throw new Error("Declared App readiness is unavailable");
              return app;
            })()
          : undefined;
      options?.signal?.throwIfAborted();
      await hub.childRequest(
        attemptID,
        { operationId: crypto.randomUUID(), action: `process-${action}`, process },
        options
          ? async (send) => {
              const forward = () => {
                options.signal?.throwIfAborted();
                send();
              };
              if (options.beforeSend) await options.beforeSend(forward);
              else forward();
            }
          : undefined,
      );
      if (app) {
        // Use the original admitted channel and Connector readiness semantics:
        // declared health path, elapsed lifecycle window and read-only retries.
        // A running process or an old app_ready_at projection is not HTTP health.
        const deadline = performance.now() + nativeLifecycleWindowMS;
        for (;;) {
          options?.signal?.throwIfAborted();
          if (!hub.hasAppChannel(attemptID, process) || !hub.connected(attemptID))
            throw new CommandError("unavailable", "App readiness lost its Runtime Attempt");
          if (
            hub
              .processes(attemptID)
              .some((item) => item.name === process && ["failed", "stopped"].includes(item.state))
          )
            throw new CommandError("unavailable", "Declared App stopped before readiness");
          const remaining = deadline - performance.now();
          if (remaining <= 0)
            throw new CommandError("unavailable", "Declared App did not become ready");
          const timeout = AbortSignal.timeout(Math.min(2_000, Math.ceil(remaining)));
          const signal = options?.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
          try {
            const response = await hub.request(
              attemptID,
              process,
              new Request(`http://factory-runtime.internal${app.healthPath}`, { signal }),
              app.healthPath,
              options?.beforeSend,
            );
            await response.body?.cancel();
            if (response.status >= 200 && response.status < 400) break;
          } catch (cause) {
            options?.signal?.throwIfAborted();
            if (cause instanceof CommandError) throw cause;
            // Only health reads repeat. An unknown process-operation result
            // exits above, without dispatching another restart.
          }
          await Bun.sleep(Math.min(250, Math.max(0, deadline - performance.now())));
        }
      }
      return this.processOutput(attemptID);
    },
    async closeTerminal(attemptID: string, terminalID: string) {
      const [attempt] = await database.client<{ ready: boolean; development: boolean }[]>`
        SELECT state='ready' AS ready,workspace_id IS NOT NULL AS development FROM factory.runtime_attempt WHERE id=${attemptID}`;
      if (!attempt?.ready || !attempt.development)
        throw new Error("Development Workspace is not ready");
      if (!/^[a-zA-Z0-9_-]{1,64}$/.test(terminalID)) throw new Error("Terminal session is invalid");
      await hub.childOperation(attemptID, {
        operationId: crypto.randomUUID(),
        action: "terminal-close",
        terminalId: terminalID,
      });
      return { closed: true };
    },
    status,
  };
}
