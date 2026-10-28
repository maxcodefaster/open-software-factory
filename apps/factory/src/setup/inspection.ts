import type { createDatabase } from "../../../../packages/db/src/client";
import type { createForgejoClient } from "../../../../packages/forge/src/forge";
import {
  setupFeedbackKey,
  setupInspectionCommand,
  setupInspectionOutput,
  setupInspectionView,
  type SetupInspectionOutput,
} from "../../../../packages/project-domain/src/setup";
import { createAccessController, projectAuthorityIn } from "../access/controller";
import type { AgentTurnTransaction } from "../agent/turn-store";
import { CommandError } from "../command-error";
import { readableCodePath } from "../knowledge/code-read";
import { factoryForgeSource } from "../knowledge/forge-source";
import type { ResolvedModelConnection } from "../models/native";
import { createUsageJournal } from "../usage/journal";
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

type InspectionRow = {
  id: string;
  projectID: string;
  sourceCommit: string;
  state: string;
  output: unknown;
  failure: string | null;
  modelID: string | null;
  connectionID: string | null;
  connectionVersion: number | null;
  userID: string;
  parentID: string | null;
  answers: Record<string, string>;
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
  forgeOwner: string;
  model(
    projectID: string,
    userID: string,
    transaction: AgentTurnTransaction,
  ): Promise<{ modelID: string; connectionID: string | null; connectionVersion: number | null }>;
  connection(reference: {
    connectionID: string | null;
    connectionVersion: number | null;
  }): Promise<ResolvedModelConnection>;
  ready(projectID: string, userID: string): Promise<void>;
  generate?: typeof inspectConfiguration;
}) {
  const sql = input.database.client;
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
    const [value] = await sql<
      { url: string; branch: string }[]
    >`SELECT repository_url AS url,default_branch AS branch FROM factory.project WHERE id=${projectID}`;
    if (!value) throw new CommandError("not-found", "Project not found");
    return {
      ...value,
      repository: factoryForgeSource(value.url, input.forgeURL, input.forgeOwner),
    };
  }
  async function row(id: string) {
    const [value] = await sql<
      InspectionRow[]
    >`SELECT id,project_id AS "projectID",source_commit AS "sourceCommit",state,output,failure,
      model_id AS "modelID",connection_id AS "connectionID",connection_version::float8 AS "connectionVersion",created_by AS "userID",parent_id AS "parentID",answers
      FROM factory.project_setup_inspection WHERE id=${id}`;
    return value;
  }
  async function view(projectID: string, userID: string) {
    await access.requireProject(userID, projectID, true);
    const [value] =
      await sql`SELECT id,project_id AS "projectID",source_commit AS "sourceCommit",state,output,failure
      FROM factory.project_setup_inspection WHERE project_id=${projectID} ORDER BY created_at DESC LIMIT 1`;
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
        await sql`UPDATE factory.project_setup_inspection SET state='proposal',output=${JSON.stringify(output)}::jsonb,updated_at=now() WHERE id=${value.id} AND state='inspecting'`;
      } catch (cause) {
        const timedOut =
          (signal?.aborted &&
            signal.reason instanceof Error &&
            signal.reason.name === "TimeoutError") ||
          (cause instanceof Error && cause.name === "TimeoutError");
        const failure = timedOut
          ? "Inspection timed out. Previous answers and source are unchanged. Retry explicitly when ready."
          : cause instanceof SetupConfigurationError
            ? cause.recovery
            : "Inspection could not finish. Previous answers and source are unchanged; retry when ready.";
        await sql`UPDATE factory.project_setup_inspection SET state='failed',failure=${failure},updated_at=now() WHERE id=${value.id} AND state='inspecting'`;
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
      await transaction`SELECT id FROM factory.project WHERE id=${projectID} FOR UPDATE`;
      await projectAuthorityIn(transaction, userID, projectID, true);
      if (command.parentID) {
        const [parent] = await transaction<
          InspectionRow[]
        >`SELECT id,project_id AS "projectID",source_commit AS "sourceCommit",state,output,answers,parent_id AS "parentID"
          FROM factory.project_setup_inspection WHERE id=${command.parentID} FOR UPDATE`;
        if (
          !parent ||
          parent.projectID !== projectID ||
          !["proposal", "failed"].includes(parent.state)
        )
          throw new CommandError("conflict", "The setup question changed");
        if (parent.sourceCommit !== head.headSha)
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
          await transaction`UPDATE factory.project_setup_inspection SET state='superseded' WHERE id=${parent.id} AND state='proposal'`;
        }
      }
      await projectAuthorityIn(transaction, userID, projectID, true);
      const active =
        await transaction`SELECT id FROM factory.project_setup_inspection WHERE project_id=${projectID} AND state IN ('inspecting','proposal','confirming')`;
      if (active.length)
        throw new CommandError("conflict", "Continue the retained setup inspection");
      const model = complete ? undefined : await input.model(projectID, userID, transaction);
      await transaction`INSERT INTO factory.project_setup_inspection(id,project_id,source_commit,state,model_id,connection_id,connection_version,created_by,parent_id,answers)
        VALUES(${commandID},${projectID},${head.headSha},${complete ? "complete" : "inspecting"},${model?.modelID ?? null},${model?.connectionID ?? null},${model?.connectionVersion ?? null},${userID},${command.parentID ?? null},${JSON.stringify(command.answers)}::jsonb)`;
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
      await sql`UPDATE factory.project_setup_inspection SET state='superseded',failure=NULL,updated_at=now()
        WHERE id=${id} AND state IN ('inspecting','proposal')`;
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
          await transaction`INSERT INTO factory.project_setup_confirmation(inspection_id,created_by) VALUES(${id},${userID}) ON CONFLICT(inspection_id) DO NOTHING`;
          await transaction`UPDATE factory.project_setup_inspection SET state='confirming',updated_at=now() WHERE id=${id} AND state='proposal'`;
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
        await sql`UPDATE factory.project_setup_inspection SET state='confirmed',failure=NULL,updated_at=now() WHERE id=${id} AND state='confirming'`;
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
      const confirmed = await sql<
        { projectID: string; userID: string }[]
      >`SELECT project_id AS "projectID",created_by AS "userID" FROM factory.project_setup_inspection WHERE state IN ('confirmed','complete')`;
      for (const value of confirmed) await input.ready(value.projectID, value.userID);
      const pending = await sql<
        { id: string }[]
      >`SELECT id FROM factory.project_setup_inspection WHERE state='inspecting'`;
      for (const value of pending) {
        await inspectionLock(value.id, async () => {
          await createUsageJournal(input.database).abandon(`setup:${value.id}`);
          await sql`UPDATE factory.project_setup_inspection SET state='failed',failure='Inspection was interrupted. Retry explicitly; source is unchanged.' WHERE id=${value.id} AND state='inspecting'`;
        });
      }
    },
  };
}
