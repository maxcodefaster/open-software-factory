import { eq, sql as expression } from "drizzle-orm";
import { type DatabaseTransaction, drizzleTransaction } from "#db/client";
import { operation, project as projectTable } from "#db/schema";
import type { createForgejoClient } from "#forge/forge";
import { setupInspectionCommand } from "#project-domain/setup";
import { createAccessController } from "../access/api";
import { projectAuthorityIn } from "../access/authority";
import { CommandError } from "../command-error";
import { factoryForgeSource } from "../knowledge/forge-source";
import type { ResolvedModelConnection } from "../models/inference-contracts";
import { createUsageJournal } from "../usage/journal-api";
import { recordedMastraUsage } from "../usage/record-mastra";
import {
  configurationPath,
  requiredConfiguration,
  validateConfiguration,
  validateSetupProposal,
} from "./configuration";
import { inspectConfiguration } from "./inspection-agent";
import { createSetupInspectionConfirmer, validateAndSupersedeParentIn } from "./inspection-confirm";
import {
  formatInspectionFailure,
  loadInspectionQuestionContext,
  readableSetupSource,
} from "./inspection-context";
import {
  type Database,
  hasActiveInspection,
  type InspectionRow,
  type InspectionState,
  listConfirmedOrCompleteInspections,
  listPendingInspections,
  loadInspectionRow,
  loadLatestInspection,
  SETUP_INSPECTION_KIND,
  setupInspectionActiveKey,
  setupInspectionKey,
  transitionInspectionToFailed,
  transitionInspectionToProposal,
  transitionInspectionToSuperseded,
} from "./inspection-store";
import { setupInspectionTimeoutMS } from "./limits";
import { withSetupCoordinationLock } from "./setup-lock";

export function createSetupInspection(input: {
  database: Database;
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

  async function loadProject(projectID: string, userID: string) {
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

  async function view(projectID: string, userID: string) {
    await access.requireProject(userID, projectID, true);
    return loadLatestInspection(db, projectID);
  }

  const confirm = createSetupInspectionConfirmer({
    database: input.database,
    forge: input.forge,
    access,
    loadProject,
    view,
    ready: input.ready,
  });

  async function inspect(value: InspectionRow) {
    return withSetupCoordinationLock(input.database, `setup-inspect:${value.id}`, async () => {
      let signal: AbortSignal | undefined;
      try {
        const current = await loadProject(value.projectID, value.userID);
        const admitted = await loadInspectionRow(db, value.id);
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
        const history = await loadInspectionQuestionContext(db, value, signal);
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
            const admittedRow = await loadInspectionRow(db, value.id);
            if (admittedRow?.state !== "inspecting") throw new Error("Inspection was stopped");
            return input.forge.getFile(current.repository, path, value.sourceCommit);
          },
        });
        validateSetupProposal(output, existing);
        await access.requireProject(value.userID, value.projectID, true);
        await transitionInspectionToProposal(db, value.id, value.projectID, output);
      } catch (cause) {
        await transitionInspectionToFailed(db, value.id, formatInspectionFailure(cause, signal));
      } finally {
        aborts.delete(value.id);
      }
    });
  }

  async function start(
    projectID: string,
    userID: string,
    commandID: string,
    continuation: { parentID?: string; answers?: Record<string, string> } = {},
  ) {
    const command = setupInspectionCommand.parse({ id: commandID, ...continuation });
    const current = await loadProject(projectID, userID);
    const previous = await loadInspectionRow(db, commandID);
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
        await validateAndSupersedeParentIn(tx, projectID, head.headSha, {
          parentID: command.parentID,
          answers: command.answers,
        });
      }
      await projectAuthorityIn(transaction, userID, projectID, true);
      if (await hasActiveInspection(tx, projectID))
        throw new CommandError("conflict", "Continue the retained setup inspection");
      const model = complete ? undefined : await input.model(projectID, userID, transaction);
      const nextState: InspectionState = complete ? "complete" : "inspecting";
      await tx.insert(operation).values({
        id: commandID,
        kind: SETUP_INSPECTION_KIND,
        scopeType: "project",
        scopeId: projectID,
        idempotencyKey: setupInspectionKey(commandID),
        activeKey: setupInspectionActiveKey(projectID, nextState),
        state: nextState,
        payload: {
          projectId: projectID,
          sourceCommit: head.headSha,
          output: null,
          failure: null,
          modelId: model?.modelID ?? null,
          connectionId: model?.connectionID ?? null,
          connectionVersion: model?.connectionVersion ?? null,
          parentId: command.parentID ?? null,
          answers: command.answers,
          createdBy: userID,
        },
        createdBy: userID,
        completedAt: complete ? expression`now()` : null,
      });
    });
    if (complete) await input.ready(projectID, userID);
    else {
      const saved = await loadInspectionRow(db, commandID);
      if (saved) {
        const work = inspect(saved).finally(() => executions.delete(commandID));
        executions.set(commandID, work);
      }
    }
    return view(projectID, userID);
  }

  async function stop(projectID: string, userID: string, id: string) {
    await loadProject(projectID, userID);
    const value = await loadInspectionRow(db, id);
    if (!value || value.projectID !== projectID)
      throw new CommandError("not-found", "Inspection not found");
    if (["inspecting", "proposal"].includes(value.state)) {
      await transitionInspectionToSuperseded(db, id, ["inspecting", "proposal"], true);
      aborts.get(id)?.abort(new DOMException("Inspection stopped", "AbortError"));
    } else if (value.state === "confirming") {
      throw new CommandError(
        "conflict",
        "Configuration was confirmed. Check its result before starting another inspection.",
      );
    }
    return view(projectID, userID);
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
      for (const mapped of await listConfirmedOrCompleteInspections(db)) {
        await input.ready(mapped.projectID, mapped.userID);
      }
      for (const value of await listPendingInspections(db)) {
        await withSetupCoordinationLock(input.database, `setup-inspect:${value.id}`, async () => {
          await createUsageJournal(input.database).abandon(`setup:${value.id}`);
          await transitionInspectionToFailed(
            db,
            value.id,
            "Inspection was interrupted. Retry explicitly; source is unchanged.",
          );
        });
      }
    },
  };
}
