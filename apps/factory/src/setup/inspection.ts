import { and, desc, eq, sql as expression, inArray } from "drizzle-orm";
import {
  type createDatabase,
  type DatabaseTransaction,
  drizzleTransaction,
} from "../../../../packages/db/src/client";
import {
  projectSetupConfirmation,
  projectSetupInspection,
  project as projectTable,
} from "../../../../packages/db/src/schema";
import type { createForgejoClient } from "../../../../packages/forge/src/forge";
import {
  type SetupInspectionOutput,
  setupFeedbackKey,
  setupInspectionCommand,
  setupInspectionOutput,
  setupInspectionView,
} from "../../../../packages/project-domain/src/setup";
import { createAccessController } from "../access/api";
import { projectAuthorityIn } from "../access/authority";
import { CommandError } from "../command-error";
import { readableCodePath } from "../knowledge/code-read";
import { factoryForgeSource } from "../knowledge/forge-source";
import { type ResolvedModelConnection } from "../models/inference-contracts";
import { createUsageJournal } from "../usage/journal-api";
import { recordedMastraUsage } from "../usage/record-mastra";
import {
  configurationPath,
  requiredConfiguration,
  SetupConfigurationError,
  setupConfigurationFeedback,
  validateConfiguration,
  validateSetupProposal,
} from "./configuration";
import { inspectConfiguration } from "./inspection-agent";
import { setupInspectionTimeoutMS, setupQuestionRoundLimit } from "./limits";

const inspectionViewFields = {
  id: projectSetupInspection.id,
  projectID: projectSetupInspection.projectId,
  sourceCommit: projectSetupInspection.sourceCommit,
  state: projectSetupInspection.state,
  output: projectSetupInspection.output,
  failure: projectSetupInspection.failure,
};

function readableSetupSource(path: string) {
  const parts = path.split("/");
  if (parts.some((part) => /^\.env(?:$|\.)/i.test(part))) return false;
  if (readableCodePath(path) || configurationPath(path)) return true;
  return (
    /^(?:Dockerfile(?:\.[A-Za-z0-9._-]+)?|[A-Za-z0-9][A-Za-z0-9._-]*\.Dockerfile)$/i.test(
      parts.at(-1) ?? "",
    ) &&
    !parts.some((part) => /secret|credential|private[-_]?key/i.test(part)) &&
    readableCodePath(`${path}.sh`)
  );
}

export function createSetupInspection(input: {
  database: ReturnType<typeof createDatabase>;
  forge: ReturnType<typeof createForgejoClient>;
  forgeURL: string;
  forgePublicURL?: string;
  forgeOwner: string;
  model(
    projectID: string,
    userID: string,
    transaction: DatabaseTransaction,
  ): Promise<{ modelID: string; connectionID: string | null; connectionVersion: number | null }>;
  connection(reference: {
    connectionID: string | null;
    connectionVersion: number | null;
  }): Promise<ResolvedModelConnection>;
  ready(projectID: string, userID: string): Promise<void>;
  generate?: typeof inspectConfiguration;
}) {
  const sql = input.database.client;
  const db = input.database.db;
  const access = createAccessController(input.database);
  const executions = new Map<string, Promise<void>>();
  const aborts = new Map<string, AbortController>();
  async function inspectionLock(id: string, work: () => Promise<void>) {
    // A session lock must live across inference, but must not occupy the pool
    // used by authorization, usage and ordinary requests. This connection does
    // only coordination and is closed with the operation, never held idle.
    const lock = input.database.coordination();
    try {
      const [claimed] = await lock<{ held: boolean }[]>`
        SELECT pg_try_advisory_lock(hashtext(${`setup-inspect:${id}`})) AS held`;
      if (!claimed?.held) return;
      try {
        await work();
      } finally {
        await lock`SELECT pg_advisory_unlock(hashtext(${`setup-inspect:${id}`}))`;
      }
    } finally {
      await lock.end({ timeout: 1 });
    }
  }
  async function project(projectID: string, userID: string) {
    await access.requireProject(userID, projectID, true);
    const [value] = await db
      .select({ url: projectTable.repositoryUrl, branch: projectTable.defaultBranch })
      .from(projectTable)
      .where(eq(projectTable.id, projectID));
    if (!value) throw new CommandError("not-found", "Project not found");
    return {
      ...value,
      repository: factoryForgeSource(
        value.url,
        input.forgeURL,
        input.forgeOwner,
        input.forgePublicURL,
      ),
    };
  }
  async function row(id: string) {
    const [value] = await db
      .select({
        ...inspectionViewFields,
        modelID: projectSetupInspection.modelId,
        connectionID: projectSetupInspection.connectionId,
        connectionVersion: projectSetupInspection.connectionVersion,
        userID: projectSetupInspection.createdBy,
        parentID: projectSetupInspection.parentId,
        answers: expression<Record<string, string>>`${projectSetupInspection.answers}`,
      })
      .from(projectSetupInspection)
      .where(eq(projectSetupInspection.id, id));
    return value;
  }
  type InspectionRow = NonNullable<Awaited<ReturnType<typeof row>>>;
  async function view(projectID: string, userID: string) {
    await access.requireProject(userID, projectID, true);
    const [value] = await db
      .select(inspectionViewFields)
      .from(projectSetupInspection)
      .where(eq(projectSetupInspection.projectId, projectID))
      .orderBy(desc(projectSetupInspection.createdAt))
      .limit(1);
    return value ? setupInspectionView.parse(value) : null;
  }
  async function inspect(value: InspectionRow) {
    return inspectionLock(value.id, async () => {
      let signal: AbortSignal | undefined;
      try {
        const current = await project(value.projectID, value.userID);
        const admitted = await row(value.id);
        if (admitted?.state !== "inspecting") return;
        const abort = new AbortController();
        aborts.set(value.id, abort);
        const files = await input.forge.listFiles(current.repository, value.sourceCommit);
        const existing = files.map((file) => file.path);
        const availablePaths = files
          .filter((file) => file.size <= 64000 && readableSetupSource(file.path))
          .map((file) => file.path);
        const available = new Set(availablePaths);
        if (!value.modelID) throw new Error("Inspection model was not admitted");
        const connection = await input.connection(value);
        signal = AbortSignal.any([abort.signal, AbortSignal.timeout(setupInspectionTimeoutMS)]);
        const history = await questionContext(value, signal);
        const output = await (input.generate ?? inspectConfiguration)({
          modelID: value.modelID,
          connection,
          usageSink: recordedMastraUsage(input.database, {
            id: `setup:${value.id}`,
            projectID: value.projectID,
            userID: value.userID,
            purpose: "setup",
            provider: connection.provider ?? "openai",
            model: value.modelID,
          }),
          signal,
          answers: value.answers,
          context: history.confirmedAnswers,
          ...(history.configurationFeedback
            ? { configurationFeedback: history.configurationFeedback }
            : {}),
          ...(history.previousProposal ? { previousProposal: history.previousProposal } : {}),
          existingConfiguration: existing.filter(configurationPath),
          paths: availablePaths.slice(0, 2000),
          availablePaths,
          read: async (path) => {
            if (!available.has(path))
              throw new Error("Source is not available for setup inspection");
            await access.requireProject(value.userID, value.projectID, true);
            const admitted = await row(value.id);
            if (admitted?.state !== "inspecting") throw new Error("Inspection was stopped");
            return input.forge.getFile(current.repository, path, value.sourceCommit);
          },
        });
        validateSetupProposal(output, existing);
        await access.requireProject(value.userID, value.projectID, true);
        await db
          .update(projectSetupInspection)
          .set({ state: "proposal", output, updatedAt: expression`now()` })
          .where(
            and(
              eq(projectSetupInspection.id, value.id),
              eq(projectSetupInspection.state, "inspecting"),
            ),
          );
      } catch (cause) {
        const timedOut =
          (signal?.aborted &&
            signal.reason instanceof Error &&
            signal.reason.name === "TimeoutError") ||
          (cause instanceof Error && cause.name === "TimeoutError");
        const failure = timedOut
          ? "Inspection timed out. Previous answers and source are unchanged. Retry explicitly when ready."
          : cause instanceof Error && cause.message === "Inspection model was not admitted"
            ? "No planning model is connected. Ask a Factory administrator to connect one in Settings, then retry."
            : cause instanceof SetupConfigurationError
              ? cause.recovery
              : "Inspection could not finish. Previous answers and source are unchanged; retry when ready.";
        await db
          .update(projectSetupInspection)
          .set({ state: "failed", failure, updatedAt: expression`now()` })
          .where(
            and(
              eq(projectSetupInspection.id, value.id),
              eq(projectSetupInspection.state, "inspecting"),
            ),
          );
      } finally {
        aborts.delete(value.id);
      }
    });
  }
  async function questionContext(value: InspectionRow, signal: AbortSignal) {
    const rounds: { question: string; answer: string }[][] = [];
    const seen = new Set([value.id]);
    let configurationFeedback: string | undefined;
    let previousProposal: SetupInspectionOutput | undefined;
    let questionRounds = 0;
    let child = value;
    while (child.parentID) {
      signal.throwIfAborted();
      if (seen.has(child.parentID)) throw new Error("Question context is unavailable");
      seen.add(child.parentID);
      const parent = await row(child.parentID);
      if (!parent || parent.projectID !== value.projectID)
        throw new Error("Question context is unavailable");
      if (child === value && parent.state === "failed")
        configurationFeedback = setupConfigurationFeedback(parent.failure);
      if (parent.state === "failed") {
        child = parent;
        continue;
      }
      const output = setupInspectionOutput.parse(parent.output);
      if (!previousProposal && output.files.length) previousProposal = output;
      if (output.questions.length && ++questionRounds > setupQuestionRoundLimit)
        throw new Error("Setup question round bound reached");
      const round =
        !output.questions.length && child.answers[setupFeedbackKey]
          ? [
              {
                question: "Requested configuration changes",
                answer: child.answers[setupFeedbackKey],
              },
            ]
          : output.questions.map((question) => ({
              question: question.question,
              answer: child.answers[question.id] ?? "",
            }));
      if (round.length) {
        // Explicit edits review a retained proposal; they are not another
        // discovery question round. The existing model-input bound still
        // covers all retained answers and the single latest draft.
        rounds.unshift(round);
      }
      child = parent;
    }
    return { confirmedAnswers: rounds.flat(), configurationFeedback, previousProposal };
  }
  async function start(
    projectID: string,
    userID: string,
    commandID: string,
    continuation: { parentID?: string; answers?: Record<string, string> } = {},
  ) {
    const command = setupInspectionCommand.parse({ id: commandID, ...continuation });
    const current = await project(projectID, userID);
    const previous = await row(commandID);
    if (previous) {
      if (
        previous.projectID !== projectID ||
        previous.userID !== userID ||
        previous.parentID !== (command.parentID ?? null) ||
        Object.keys(previous.answers).length !== Object.keys(command.answers).length ||
        Object.entries(command.answers).some(([key, value]) => previous.answers[key] !== value)
      )
        throw new CommandError("conflict", "Inspection command belongs to different work");
      return view(projectID, userID);
    }
    const head = await input.forge.getDefaultBranch(current.repository);
    const files = await input.forge.listFiles(current.repository, head.headSha);
    const complete = requiredConfiguration.every((path) =>
      files.some((file) => file.path === path),
    );
    if (complete) {
      validateConfiguration(
        await Promise.all(
          requiredConfiguration.map(async (path) => ({
            path,
            content: await input.forge.getFile(current.repository, path, head.headSha),
          })),
        ),
        files.map((file) => file.path),
      );
    }
    await sql.begin(async (transaction) => {
      const tx = drizzleTransaction(transaction);
      await tx
        .select({ id: projectTable.id })
        .from(projectTable)
        .where(eq(projectTable.id, projectID))
        .for("update");
      await projectAuthorityIn(transaction, userID, projectID, true);
      if (command.parentID) {
        const [parent] = await tx
          .select({
            id: projectSetupInspection.id,
            projectID: projectSetupInspection.projectId,
            sourceCommit: projectSetupInspection.sourceCommit,
            state: projectSetupInspection.state,
            output: projectSetupInspection.output,
            answers: projectSetupInspection.answers,
            parentID: projectSetupInspection.parentId,
          })
          .from(projectSetupInspection)
          .where(eq(projectSetupInspection.id, command.parentID))
          .for("update");
        if (
          !parent ||
          parent.projectID !== projectID ||
          !["proposal", "failed"].includes(parent.state)
        )
          throw new CommandError("conflict", "The setup question changed");
        // A failed inspection retained no proposal. A changed default branch is the usual
        // reason to retry, so only a proposal or open questions are bound to their commit.
        if (parent.sourceCommit !== head.headSha && parent.state !== "failed")
          throw new CommandError(
            "conflict",
            "Source changed. Inspect the current configuration again.",
          );
        if (parent.state === "failed") {
          if (Object.keys(command.answers).length)
            throw new CommandError("conflict", "Retry keeps the confirmed answers unchanged");
        } else {
          const output = setupInspectionOutput.parse(parent.output);
          const refining = output.files.length > 0 && !output.questions.length;
          if (
            (refining && !command.answers[setupFeedbackKey]) ||
            output.questions.some((question) => !command.answers[question.id]) ||
            Object.keys(command.answers).some(
              (key) =>
                !(refining && key === setupFeedbackKey) &&
                !output.questions.some((question) => question.id === key),
            )
          )
            throw new CommandError(
              "conflict",
              refining
                ? "Describe the required configuration changes before continuing"
                : "Answer the current setup questions before continuing",
            );
          await tx
            .update(projectSetupInspection)
            .set({ state: "superseded" })
            .where(
              and(
                eq(projectSetupInspection.id, parent.id),
                eq(projectSetupInspection.state, "proposal"),
              ),
            );
        }
      }
      await projectAuthorityIn(transaction, userID, projectID, true);
      const active = await tx
        .select({ id: projectSetupInspection.id })
        .from(projectSetupInspection)
        .where(
          and(
            eq(projectSetupInspection.projectId, projectID),
            inArray(projectSetupInspection.state, ["inspecting", "proposal", "confirming"]),
          ),
        );
      if (active.length)
        throw new CommandError("conflict", "Continue the retained setup inspection");
      const model = complete ? undefined : await input.model(projectID, userID, transaction);
      await tx.insert(projectSetupInspection).values({
        id: commandID,
        projectId: projectID,
        sourceCommit: head.headSha,
        state: complete ? "complete" : "inspecting",
        modelId: model?.modelID ?? null,
        connectionId: model?.connectionID ?? null,
        connectionVersion: model?.connectionVersion ?? null,
        createdBy: userID,
        parentId: command.parentID ?? null,
        answers: command.answers,
      });
    });
    if (complete) await input.ready(projectID, userID);
    else {
      const saved = await row(commandID);
      if (saved) {
        const work = inspect(saved).finally(() => executions.delete(commandID));
        executions.set(commandID, work);
      }
    }
    return view(projectID, userID);
  }
  async function stop(projectID: string, userID: string, id: string) {
    await project(projectID, userID);
    const value = await row(id);
    if (!value || value.projectID !== projectID)
      throw new CommandError("not-found", "Inspection not found");
    if (["inspecting", "proposal"].includes(value.state)) {
      await db
        .update(projectSetupInspection)
        .set({ state: "superseded", failure: null, updatedAt: expression`now()` })
        .where(
          and(
            eq(projectSetupInspection.id, id),
            inArray(projectSetupInspection.state, ["inspecting", "proposal"]),
          ),
        );
      aborts.get(id)?.abort(new DOMException("Inspection stopped", "AbortError"));
    } else if (value.state === "confirming") {
      throw new CommandError(
        "conflict",
        "Configuration was confirmed. Check its result before starting another inspection.",
      );
    }
    return view(projectID, userID);
  }
  async function confirm(projectID: string, userID: string, id: string) {
    const current = await project(projectID, userID);
    const connection = await sql.reserve();
    try {
      const [lock] = await connection<
        { held: boolean }[]
      >`SELECT pg_try_advisory_lock(hashtext(${`setup-confirm:${id}`})) AS held`;
      if (!lock?.held) throw new CommandError("conflict", "Confirmation is already running");
      try {
        const value = await row(id);
        if (
          !value ||
          value.projectID !== projectID ||
          !["proposal", "confirming", "confirmed"].includes(value.state)
        )
          throw new CommandError("conflict", "Setup proposal is unavailable");
        if (value.state === "confirmed") return view(projectID, userID);
        const output = setupInspectionOutput.parse(value.output);
        if (output.questions.length || !output.files.length)
          throw new CommandError("conflict", "Answer the remaining setup questions first");
        const head = await input.forge.getDefaultBranch(current.repository);
        await input.forge.ensureDefaultBranchProtection(current.repository, current.branch, false);
        const branchName = `factory/setup-${id}`;
        if (value.state === "proposal" && head.headSha !== value.sourceCommit)
          throw new CommandError(
            "conflict",
            "Source changed. Inspect its current configuration again before confirming",
          );
        await sql.begin(async (transaction) => {
          const tx = drizzleTransaction(transaction);
          await tx
            .insert(projectSetupConfirmation)
            .values({ inspectionId: id, createdBy: userID })
            .onConflictDoNothing({ target: projectSetupConfirmation.inspectionId });
          await tx
            .update(projectSetupInspection)
            .set({ state: "confirming", updatedAt: expression`now()` })
            .where(
              and(eq(projectSetupInspection.id, id), eq(projectSetupInspection.state, "proposal")),
            );
        });
        const commit = await input.forge.applySetupFiles({
          repository: current.repository,
          branch: branchName,
          baseCommit: value.sourceCommit,
          files: output.files,
          proposalID: id,
        });
        await access.requireProject(userID, projectID, true);
        const observed = await input.forge.getDefaultBranch(current.repository);
        if (observed.headSha !== value.sourceCommit && observed.headSha !== commit)
          throw new CommandError(
            "conflict",
            "Main branch changed; confirmed files were not merged",
          );
        if (observed.headSha !== commit) {
          const pull = await input.forge.ensurePullRequest({
            repository: current.repository,
            baseBranch: current.branch,
            headBranch: branchName,
            expectedHeadSha: commit,
            title: "Configure Project for Factory",
            body: "Exact human-confirmed Project setup. No application code changes.",
          });
          if (pull.baseSha !== value.sourceCommit)
            throw new CommandError("conflict", "Main branch changed before setup merge");
          const merge = output.files.some(
            (file) => file.path === ".forgejo/workflows/factory-verification.yml",
          )
            ? () =>
                input.forge.mergeInitialSetupWorkflow(
                  current.repository,
                  pull.number,
                  commit,
                  current.branch,
                  value.sourceCommit,
                )
            : () =>
                input.forge.mergeFastForward(
                  current.repository,
                  pull.number,
                  commit,
                  current.branch,
                );
          await merge();
        }
        await input.forge.protectSetupWorkflow(current.repository, current.branch);
        await db
          .update(projectSetupInspection)
          .set({ state: "confirmed", failure: null, updatedAt: expression`now()` })
          .where(
            and(eq(projectSetupInspection.id, id), eq(projectSetupInspection.state, "confirming")),
          );
        await input.ready(projectID, userID);
        return view(projectID, userID);
      } finally {
        await connection`SELECT pg_advisory_unlock(hashtext(${`setup-confirm:${id}`}))`;
      }
    } finally {
      connection.release();
    }
  }
  return {
    start,
    view,
    confirm,
    stop,
    async settle() {
      await Promise.allSettled([...executions.values()]);
    },
    async recover() {
      const confirmed = await db
        .select({
          projectID: projectSetupInspection.projectId,
          userID: projectSetupInspection.createdBy,
        })
        .from(projectSetupInspection)
        .where(inArray(projectSetupInspection.state, ["confirmed", "complete"]));
      for (const value of confirmed) await input.ready(value.projectID, value.userID);
      const pending = await db
        .select({ id: projectSetupInspection.id })
        .from(projectSetupInspection)
        .where(eq(projectSetupInspection.state, "inspecting"));
      for (const value of pending) {
        await inspectionLock(value.id, async () => {
          await createUsageJournal(input.database).abandon(`setup:${value.id}`);
          await db
            .update(projectSetupInspection)
            .set({
              state: "failed",
              failure: "Inspection was interrupted. Retry explicitly; source is unchanged.",
            })
            .where(
              and(
                eq(projectSetupInspection.id, value.id),
                eq(projectSetupInspection.state, "inspecting"),
              ),
            );
        });
      }
    },
  };
}
