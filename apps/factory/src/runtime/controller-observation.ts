import { createHash } from "node:crypto";
import { and, eq, inArray, isNull, sql as query } from "drizzle-orm";
import type { createDatabase } from "#db/client";
import {
  change as changeModel,
  project as projectModel,
  runtimeAttempt,
  verification as verificationModel,
} from "#db/schema";
import type { createForgejoClient } from "#forge/forge";
import { boundForgeRepositoryFromURL, forgeRepositoryFromURL } from "#forge/repository";
import { parseSystemContract, SystemContractError } from "#system-contract/system-contract";
import { reportFailure } from "../failure-log";
import { readRepositoryFileAtRevision } from "./git-http";
import type { RuntimeHub } from "./hub";

type Database = ReturnType<typeof createDatabase>;
type ForgeClient = ReturnType<typeof createForgejoClient>;
export type ForgeBinding = {
  apiURL: string;
  publicURL: string | undefined;
  owner: string;
};

export function createProjectRepositoryReader(forge: ForgeClient, forgeOwner: string) {
  async function readWorkspaceFile(
    repositoryURL: string,
    revision: string,
    path: string,
  ): Promise<string | null> {
    let content: string | null;
    try {
      if (repositoryURL.startsWith("file://")) {
        if (!/^[0-9a-f]{40,64}$/.test(revision)) throw new Error("Project revision is invalid");
        const tree = Bun.spawn(
          [
            "git",
            "-C",
            decodeURIComponent(new URL(repositoryURL).pathname),
            "ls-tree",
            "-z",
            revision,
            "--",
            path,
          ],
          { stdout: "pipe", stderr: "pipe" },
        );
        const [entries, error, exitCode] = await Promise.all([
          new Response(tree.stdout).text(),
          new Response(tree.stderr).text(),
          tree.exited,
        ]);
        if (exitCode !== 0) throw new Error(error.trim() || "Project revision is unavailable");
        content = entries
          ? await readRepositoryFileAtRevision(repositoryURL, revision, path)
          : null;
      } else {
        const repository = forgeRepositoryFromURL(
          repositoryURL,
          () => new SystemContractError("Project repository URL is invalid"),
        );
        if (repository.owner !== forgeOwner) throw new Error("Project Forge owner is not allowed");
        content = await forge.getOptionalFile(repository, path, revision);
        // A contents 404 can also mean an inaccessible repository or revision.
        // Confirm absence in its exact tree instead of admitting an unknown read.
        if (
          content === null &&
          (await forge.listFiles(repository, revision)).some((file) => file.path === path)
        )
          throw new Error(`Declared ${path} is unavailable`);
      }
    } catch (cause) {
      throw new SystemContractError(
        `Cannot read ${path} at ${revision.slice(0, 12)}: ${cause instanceof Error ? cause.message : "unknown error"}`,
      );
    }
    return content;
  }

  async function readWorkspaceContract(repositoryURL: string, revision: string) {
    const content = await readWorkspaceFile(repositoryURL, revision, ".factory/system.json");
    return content === null ? null : parseSystemContract(content);
  }

  return {
    async readWorkspaceConfiguration(
      repositoryURL: string,
      revision: string,
      actorTemplatePath: string,
    ) {
      const systemContract = await readWorkspaceContract(repositoryURL, revision);
      const content = await readWorkspaceFile(repositoryURL, revision, actorTemplatePath);
      return {
        systemContract,
        actorTemplate:
          content === null
            ? null
            : {
                path: actorTemplatePath,
                content,
                sha256: createHash("sha256").update(content).digest("hex"),
              },
      };
    },
    async readContract(repositoryURL: string, revision: string) {
      const contract = await readWorkspaceContract(repositoryURL, revision);
      if (contract === null)
        throw new SystemContractError(".factory/system.json is required for Staging");
      return contract;
    },
  };
}

export async function resolveVerificationJobHandle(
  database: Database,
  forge: ForgeClient,
  forgeBinding: ForgeBinding,
  verificationID: string,
) {
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

type StatusExecution = {
  recover(): Promise<void>;
  get(): Promise<{ state: string }>;
};

export function createStatusObserver(
  database: Database,
  hub: RuntimeHub,
  execution: (attemptID: string) => Promise<StatusExecution>,
) {
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

  return { status, clearReconnect };
}
