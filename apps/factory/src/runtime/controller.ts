import { stripVTControlCharacters } from "node:util";
import {
  and,
  desc,
  eq,
  exists,
  inArray,
  isNotNull,
  isNull,
  notInArray,
  or,
  sql as query,
} from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import {
  type createDatabase,
  type DatabaseTransaction,
  drizzleTransaction,
} from "../../../../packages/db/src/client";
import {
  administrator,
  agentTurn,
  changeAgentSession,
  change as changeModel,
  developmentWorkspace,
  projectImagePreparation,
  projectMembership,
  project as projectModel,
  projectRelease,
  promotionOperation,
  releaseAttempt,
  runtimeAttempt,
  stagingPreview,
  substrateWorkspace,
  verification as verificationModel,
  workspaceShare,
} from "../../../../packages/db/src/schema";
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
import { createCodingRuntimeShutdown } from "../agent/runtime-shutdown";
import {
  createChangeAgentStop,
  type PendingWriterHandoff,
  type RetainedStopTarget,
  requirePendingWriterHandoffIn,
  requireStoppedAgentInputsIn,
} from "../agent/stop";
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
// The public inventory uses the driver's existing text timestamps/bigints.
// Keep one projection for saved list state and explicit native get observation.
const runtimeAttemptFields = {
  id: runtimeAttempt.id,
  projectId: runtimeAttempt.projectId,
  changeId: runtimeAttempt.changeId,
  workspaceId: runtimeAttempt.workspaceId,
  workspaceKind: developmentWorkspace.kind,
  ownerUserId: developmentWorkspace.ownerUserId,
  generation: query<string>`${runtimeAttempt.generation}::text`,
  revision: runtimeAttempt.revision,
  runtimeKind: query<
    RuntimeAttemptView["runtimeKind"]
  >`coalesce(${runtimeAttempt.isolatedKind}::text, ${developmentWorkspace.kind}::text)`,
  currentStaging: query<boolean>`coalesce(${stagingPreview.runtimeAttemptId} = ${runtimeAttempt.id}, false)`,
  state: runtimeAttempt.state,
  failure: runtimeAttempt.failure,
  createdAt: query<string>`${runtimeAttempt.createdAt}`,
  updatedAt: query<string>`${runtimeAttempt.updatedAt}`,
  readyAt: query<string | null>`${runtimeAttempt.readyAt}`,
  appReadyAt: query<Record<string, string>>`${runtimeAttempt.appReadyAt}`,
  restoreFailed: query<boolean>`${runtimeAttempt.state} IN ('resuming', 'cleanup-failed') AND ${runtimeAttempt.resumeFailedAt} IS NOT NULL`,
};
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
  const shutdownCoding = createCodingRuntimeShutdown(database, hub);
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
        shutdownCoding,
      ),
      verification: createSubstrateVerification(
        database,
        hub,
        connectorSecret,
        configuration,
        options.call,
        options.provisionerCall,
        options.capacity,
        shutdownCoding,
      ),
      prebuild: createSubstratePrebuild(
        database,
        hub,
        connectorSecret,
        configuration,
        options.call,
        options.provisionerCall,
        options.capacity,
        shutdownCoding,
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
        shutdownCoding,
      ),
    };
    projects.set(projectID, owners);
    return owners;
  }
  async function execution(attemptID: string) {
    const [attempt] = await database.db
      .select({ projectID: runtimeAttempt.projectId })
      .from(runtimeAttempt)
      .where(eq(runtimeAttempt.id, attemptID));
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
      const [recorded] = await database.db
        .select({
          state: runtimeAttempt.state,
          failure: runtimeAttempt.failure,
          updatedAt: runtimeAttemptFields.updatedAt,
        })
        .from(runtimeAttempt)
        .where(eq(runtimeAttempt.id, attempt.id));
      if (!recorded) throw new Error("Recorded runtime outcome is unavailable");
      return { ...attempt, ...recorded, native: observation };
    }
    return { ...attempt, native: observation };
  }
  async function verificationJob(verificationID: string) {
    const [row] = await database.db
      .select({
        handle: verificationModel.runnerJobHandle,
        runID: verificationModel.actionRunId,
        commit: verificationModel.commitSha,
        repository: projectModel.repositoryUrl,
      })
      .from(verificationModel)
      .innerJoin(changeModel, eq(changeModel.id, verificationModel.changeId))
      .innerJoin(projectModel, eq(projectModel.id, changeModel.projectId))
      .where(eq(verificationModel.id, verificationID));
    if (!row) return undefined;
    const repository = boundForgeRepositoryFromURL(row.repository, forgeBinding);
    if (row.handle || !row.runID) return row.handle ?? undefined;
    const handle = await forge.verificationJobHandle(repository, Number(row.runID), row.commit);
    const [saved] = await database.db
      .update(verificationModel)
      .set({ runnerJobHandle: query`coalesce(${verificationModel.runnerJobHandle}, ${handle})` })
      .where(
        and(
          eq(verificationModel.id, verificationID),
          eq(verificationModel.actionRunId, row.runID),
          eq(verificationModel.commitSha, row.commit),
          inArray(verificationModel.state, ["pending", "runner-starting", "running"]),
        ),
      )
      .returning({ handle: verificationModel.runnerJobHandle });
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
      const [preparation] = await database.db
        .select({
          id: projectImagePreparation.id,
          state: projectImagePreparation.state,
        })
        .from(projectImagePreparation)
        .where(eq(projectImagePreparation.runtimeAttemptId, attemptID));
      if (preparation) {
        const unsupported = error?.startsWith(
          "prebuild Compose cannot depend on the producer environment",
        );
        if (preparation.state === "running")
          await database.db
            .update(projectImagePreparation)
            .set({
              state: unsupported ? "unsupported" : "failed",
              failure: unsupported
                ? "Image preparation was skipped: Compose build inputs depend on environment variables. Normal startup remains available."
                : (error ??
                  "Image preparation ended without a confirmed publication; normal startup remains available."),
              updatedAt: query`now()`,
            })
            .where(
              and(
                eq(projectImagePreparation.id, preparation.id),
                eq(projectImagePreparation.state, "running"),
              ),
            );
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
    const changed = await database.db
      .update(runtimeAttempt)
      .set({
        state: ready
          ? "ready"
          : failed
            ? "failed"
            : reconnecting
              ? "starting"
              : runtimeAttempt.state,
        readyAt: ready ? query`coalesce(${runtimeAttempt.readyAt}, now())` : runtimeAttempt.readyAt,
        appReadyAt: ready
          ? query`${JSON.stringify(healthy)}::jsonb || ${runtimeAttempt.appReadyAt}`
          : runtimeAttempt.appReadyAt,
        failure: ready
          ? null
          : (error ?? `Native observation: ${observed.state}; Connector ${phase}`),
        updatedAt: query`now()`,
      })
      .where(
        and(
          eq(runtimeAttempt.id, attemptID),
          inArray(runtimeAttempt.state, ["starting", "ready"]),
          isNull(runtimeAttempt.stopIntendedAt),
        ),
      )
      .returning({ id: runtimeAttempt.id });
    if (changed.length === 1 && ready) {
      clearReconnect(attemptID);
      await database.db
        .update(changeModel)
        .set({ state: "active", version: query`${changeModel.version} + 1` })
        .where(and(eq(changeModel.runtimeAttemptId, attemptID), eq(changeModel.state, "starting")));
    } else if (changed.length === 1 && reconnecting) observeReconnectLater(attemptID);
  }
  hub.onAppRunning((attemptID, app) => {
    void database.db
      .update(runtimeAttempt)
      .set({
        appReadyAt: query`jsonb_set(${runtimeAttempt.appReadyAt}, ARRAY[${app}]::text[], to_jsonb(now()::text))`,
      })
      .where(
        and(
          eq(runtimeAttempt.id, attemptID),
          eq(runtimeAttempt.state, "ready"),
          query`NOT ${runtimeAttempt.appReadyAt} ? ${app}`,
        ),
      )
      .execute()
      .catch(reportFailure("App readiness timestamp is unavailable"));
  });
  return {
    async supportsInitialSourceRole(attemptID: string, sql: DatabaseTransaction) {
      const [attempt] = await drizzleTransaction(sql)
        .select({ projectID: runtimeAttempt.projectId })
        .from(runtimeAttempt)
        .where(eq(runtimeAttempt.id, attemptID));
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
      const ids = await database.db
        .selectDistinct({ projectID: runtimeAttempt.projectId })
        .from(runtimeAttempt);
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
      recordStart?: (sql: DatabaseTransaction, workspaceID: string) => Promise<void>,
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
      const [change] = await database.db
        .select({ projectID: changeModel.projectId })
        .from(changeModel)
        .where(eq(changeModel.id, changeID));
      if (!change) throw new CommandError("not-found", "Change not found");
      await requireSetupReady(database.client, change.projectID);
      return this.get(await project(change.projectID).workspaces.start(userID, changeID));
    },
    async ensureStaging(projectID: string, userID: string) {
      await requireSetupReady(database.client, projectID);
      return this.get(await project(projectID).isolated.stage(userID));
    },
    async startProjectPrebuild(preparationID: string) {
      const [preparation] = await database.db
        .select({ projectID: projectImagePreparation.projectId })
        .from(projectImagePreparation)
        .where(
          and(
            eq(projectImagePreparation.id, preparationID),
            inArray(projectImagePreparation.state, ["pending", "running"]),
          ),
        );
      if (!preparation) return;
      await project(preparation.projectID).prebuild.start(preparationID);
    },
    async startVerification(verificationID: string, userID: string) {
      const [verification] = await database.db
        .select({ projectID: changeModel.projectId })
        .from(verificationModel)
        .innerJoin(changeModel, eq(changeModel.id, verificationModel.changeId))
        .where(eq(verificationModel.id, verificationID));
      if (!verification) return null;
      await database.client.begin((sql) => projectAuthorityIn(sql, userID, verification.projectID));
      await verificationJob(verificationID);
      return this.get(
        await project(verification.projectID).verification.start(verificationID, userID),
      );
    },
    async startPublication(publicationID: string, userID: string) {
      const [publication] = await database.db
        .select({ projectID: projectRelease.projectId })
        .from(releaseAttempt)
        .innerJoin(projectRelease, eq(projectRelease.id, releaseAttempt.releaseId))
        .where(eq(releaseAttempt.id, publicationID));
      if (!publication) throw new CommandError("not-found", "Publication not found");
      return this.get(await project(publication.projectID).isolated.publish(publicationID, userID));
    },
    async startStagingReplacement(promotionID: string, userID: string) {
      const [promotion] = await database.db
        .select({ projectID: promotionOperation.projectId })
        .from(promotionOperation)
        .where(eq(promotionOperation.id, promotionID));
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
        await database.db
          .update(runtimeAttempt)
          .set({
            failure: query`coalesce(${runtimeAttempt.failure}, ${message})`,
            updatedAt: query`now()`,
          })
          .where(
            and(
              eq(runtimeAttempt.id, attemptID),
              eq(runtimeAttempt.state, "pausing"),
              isNull(runtimeAttempt.stopIntendedAt),
            ),
          );
        throw cause;
      }
      return this.get(attemptID);
    },
    async stop(attemptID: string, handoff?: PendingWriterHandoff) {
      clearReconnect(attemptID);
      if (handoff) await requirePendingWriterHandoffIn(database.client, attemptID, handoff);
      const [coding] = await database.db
        .select({ changeID: changeModel.id })
        .from(runtimeAttempt)
        .innerJoin(
          changeModel,
          and(
            eq(changeModel.id, runtimeAttempt.changeId),
            eq(changeModel.runtimeAttemptId, runtimeAttempt.id),
          ),
        )
        .leftJoin(
          changeAgentSession,
          and(
            eq(changeAgentSession.changeId, changeModel.id),
            eq(changeAgentSession.runtimeAttemptId, runtimeAttempt.id),
          ),
        )
        .where(
          and(
            eq(runtimeAttempt.id, attemptID),
            or(
              eq(changeAgentSession.stopPending, true),
              notInArray(changeAgentSession.state, ["committed", "stopped"]),
              exists(
                database.db
                  .select({ id: agentTurn.id })
                  .from(agentTurn)
                  .where(
                    and(
                      eq(agentTurn.changeId, changeModel.id),
                      inArray(agentTurn.state, ["pending", "dispatching", "running", "uncertain"]),
                    ),
                  ),
              ),
            ),
          ),
        );
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
      const [attempt] = await database.db
        .select({
          projectID: runtimeAttempt.projectId,
          changeID: runtimeAttempt.changeId,
          workspaceID: runtimeAttempt.workspaceId,
          confirmed: isNotNull(runtimeAttempt.resumeFailedAt),
        })
        .from(runtimeAttempt)
        .where(eq(runtimeAttempt.id, attemptID));
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
      const [attempt] = await database.db
        .select(runtimeAttemptFields)
        .from(runtimeAttempt)
        .leftJoin(developmentWorkspace, eq(developmentWorkspace.id, runtimeAttempt.workspaceId))
        .leftJoin(stagingPreview, eq(stagingPreview.projectId, runtimeAttempt.projectId))
        .where(eq(runtimeAttempt.id, attemptID));
      return attempt ? observe(attempt) : null;
    },
    async list(projectID: string | undefined, userID: string) {
      const history = alias(runtimeAttempt, "history_attempt");
      const historyOwner = query`coalesce(${history.workspaceId}::text, ${history.isolatedKind}::text || ':' || coalesce(${history.changeId}::text, ${history.projectId}::text))`;
      const attempts = await database.db
        .select(runtimeAttemptFields)
        .from(runtimeAttempt)
        .leftJoin(developmentWorkspace, eq(developmentWorkspace.id, runtimeAttempt.workspaceId))
        .leftJoin(stagingPreview, eq(stagingPreview.projectId, runtimeAttempt.projectId))
        .where(
          and(
            projectID === undefined ? undefined : eq(runtimeAttempt.projectId, projectID),
            query`${runtimeAttempt.isolatedKind} IS DISTINCT FROM 'prebuild'`,
            or(
              query`${developmentWorkspace.kind} IS DISTINCT FROM 'personal'`,
              eq(developmentWorkspace.ownerUserId, userID),
              exists(
                database.db
                  .select({ id: workspaceShare.workspaceId })
                  .from(workspaceShare)
                  .where(
                    and(
                      eq(workspaceShare.workspaceId, developmentWorkspace.id),
                      eq(workspaceShare.userId, userID),
                      isNull(workspaceShare.revokedAt),
                      exists(
                        database.db
                          .select({ id: projectMembership.projectId })
                          .from(projectMembership)
                          .where(
                            and(
                              eq(projectMembership.projectId, runtimeAttempt.projectId),
                              eq(projectMembership.userId, userID),
                              eq(projectMembership.role, "developer"),
                            ),
                          ),
                      ),
                    ),
                  ),
              ),
            ),
            or(
              exists(
                database.db
                  .select({ id: administrator.userId })
                  .from(administrator)
                  .where(eq(administrator.userId, userID)),
              ),
              exists(
                database.db
                  .select({ id: projectMembership.projectId })
                  .from(projectMembership)
                  .where(
                    and(
                      eq(projectMembership.projectId, runtimeAttempt.projectId),
                      eq(projectMembership.userId, userID),
                    ),
                  ),
              ),
            ),
            projectID === undefined
              ? undefined
              : or(
                  notInArray(runtimeAttempt.state, ["stopped", "failed"]),
                  eq(stagingPreview.runtimeAttemptId, runtimeAttempt.id),
                  inArray(
                    runtimeAttempt.id,
                    database.db
                      .selectDistinctOn([historyOwner], { id: history.id })
                      .from(history)
                      .where(eq(history.projectId, projectID))
                      .orderBy(historyOwner, desc(history.generation), desc(history.createdAt)),
                  ),
                ),
          ),
        )
        .orderBy(desc(runtimeAttempt.createdAt));
      // Inventory reports saved Factory state, not current Actor liveness.
      // Keep it readable while the native API is unavailable. Explicit get()
      // and lifecycle commands still require the original native owner and
      // its live observation; recorded ready never supplies that authority.
      return [...attempts];
    },
    async processOutput(attemptID: string) {
      const [attempt] = await database.db
        .select({ state: runtimeAttempt.state })
        .from(runtimeAttempt)
        .where(eq(runtimeAttempt.id, attemptID));
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
      const [attempt] = await database.db
        .select({
          ready: query<boolean>`${runtimeAttempt.state} = 'ready' AND ${runtimeAttempt.stopIntendedAt} IS NULL`,
          development: isNotNull(runtimeAttempt.workspaceId),
          contract: query<unknown>`${substrateWorkspace.intent}->'systemContract'`,
        })
        .from(runtimeAttempt)
        .leftJoin(
          substrateWorkspace,
          and(
            eq(substrateWorkspace.workspaceId, runtimeAttempt.workspaceId),
            eq(substrateWorkspace.generation, runtimeAttempt.generation),
          ),
        )
        .where(eq(runtimeAttempt.id, attemptID));
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
      const [attempt] = await database.db
        .select({
          ready: eq(runtimeAttempt.state, "ready"),
          development: isNotNull(runtimeAttempt.workspaceId),
        })
        .from(runtimeAttempt)
        .where(eq(runtimeAttempt.id, attemptID));
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
