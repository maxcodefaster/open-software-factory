import { and, eq, sql as expression, inArray } from "drizzle-orm";
import { drizzleTransaction } from "#db/client";
import { operation } from "#db/schema";
import { validateWikiGeneration } from "#knowledge-domain/generation";
import { projectAuthorityIn } from "../access/authority";
import { CommandError } from "../command-error";
import { recordedMastraUsage } from "../usage/record-mastra";
import type { generateWiki } from "./generation-agent";
import {
  attemptWhere,
  completedPublications,
  type ModelSettingsController,
  resolveGenerationConnection,
} from "./generation-context";
import type { WikiGenerationInput } from "./generation-contracts";
import { wikiGenerationFailureMessage } from "./generation-failure";
import {
  prepareWikiPublication,
  publishWikiPackage,
  WikiPublicationConflict,
  wikiPublicationSnapshotsIn,
} from "./publication";
import type { KnowledgeDatabase, KnowledgeRepository } from "./repository-source";

export type WikiGenerationDeps = {
  database: KnowledgeDatabase;
  repository: KnowledgeRepository;
  models: ModelSettingsController;
  generationAgent: (input: WikiGenerationInput) => ReturnType<typeof generateWiki>;
  signal: AbortSignal;
};

export async function executeWikiGeneration(deps: WikiGenerationDeps, generationID: string) {
  const { database, repository, models, generationAgent, signal } = deps;
  const attemptId = crypto.randomUUID();
  let failureMessage = "Wiki model is unavailable. Check Project settings and retry.";
  try {
    const initialProgress = {
      phase: "planning",
      topicsTotal: 0,
      topicsDone: 0,
      currentTopic: null,
    };
    const [generation] = await database.db
      .update(operation)
      .set({
        state: "running",
        error: null,
        updatedAt: expression`now()`,
        payload: expression`${operation.payload} || jsonb_build_object(
          'failure', NULL,
          'attemptId', ${attemptId}::text,
          'progress', ${JSON.stringify(initialProgress)}::jsonb
        )`,
      })
      .where(
        and(
          eq(operation.id, generationID),
          eq(operation.kind, "knowledge.generation"),
          inArray(operation.state, ["pending", "running"]),
        ),
      )
      .returning({
        projectID: operation.scopeId,
        commitSha: expression<string>`${operation.payload}->>'sourceCommitSha'`,
        userID: expression<string>`coalesce(${operation.createdBy}::text, ${operation.payload}->>'createdBy')`,
        modelId: expression<string | null>`${operation.payload}->>'modelId'`,
      });
    if (!generation) return;
    const { modelId, connection } = await resolveGenerationConnection(
      database,
      models,
      generationID,
      attemptId,
      generation,
    );
    const authorize = async () => {
      signal.throwIfAborted();
      await database.client.begin(async (sql) => {
        await projectAuthorityIn(sql, generation.userID, generation.projectID);
        const [current] = await drizzleTransaction(sql)
          .select({ id: operation.id })
          .from(operation)
          .where(attemptWhere(generationID, attemptId, eq(operation.state, "running")));
        if (!current) throw new CommandError("conflict", "Wiki execution authority changed.");
      });
    };
    const recordProgress = async (progress: unknown) => {
      // Progress is advisory; a lost write must never fail checked generation.
      try {
        await database.db
          .update(operation)
          .set({
            payload: expression`jsonb_set(${operation.payload}, '{progress}', ${JSON.stringify(progress)}::jsonb, true)`,
            updatedAt: expression`now()`,
          })
          .where(attemptWhere(generationID, attemptId, eq(operation.state, "running")));
      } catch {
        console.error("[factory] Wiki progress could not be recorded");
      }
    };
    for (let retry = 0; retry < 3; retry++) {
      signal.throwIfAborted();
      failureMessage =
        "Wiki source could not be read at this revision. Saved pages are retained; retry the update.";
      const pages = await wikiPublicationSnapshotsIn(database.db, generation.projectID);
      // Generated baselines belong to publication, not model context or its input-size budget.
      const pageContext = () => pages.map(({ generatedBody: _, ...page }) => page);
      const completedPageIDs = await completedPublications(
        database,
        generationID,
        attemptId,
        generation.projectID,
        generation.commitSha,
      );
      const bundle = await repository.sourceBundle(
        generation.projectID,
        generation.commitSha,
        pageContext(),
      );
      failureMessage =
        "The Wiki model could not finish a supported update. Saved pages are retained; retry the update.";
      try {
        const output = await generationAgent({
          name: bundle.project.name,
          actorTemplatePath: bundle.project.actorTemplatePath,
          commit: generation.commitSha,
          modelId,
          connection,
          pages: pageContext(),
          completedPageIDs,
          inventory: bundle.candidates,
          changedPaths: bundle.changedPaths,
          sources: bundle.sources,
          readFiles: bundle.readFiles,
          signal,
          authorize,
          progress: recordProgress,
          usageSink: (callID) =>
            recordedMastraUsage(database, {
              id: `wiki:${generationID}:${attemptId}:${callID}`,
              projectID: generation.projectID,
              userID: generation.userID,
              purpose: "wiki",
              provider: connection.provider ?? "openai",
              model: modelId,
            }),
          preparePublication: (output) => prepareWikiPublication(pages, output),
          publish: async (output) => {
            await authorize();
            validateWikiGeneration(output, pages, bundle.readPaths());
            await repository.verifyHead(
              bundle.project.repository,
              generation.commitSha,
              "Source head changed",
            );
            // The workflow captures its read snapshot, not a later human draft.
            const published = await publishWikiPackage(database, {
              generationID,
              attemptID: attemptId,
              ...generation,
              pages,
              output,
              complete: false,
            });
            if (!published)
              throw new WikiPublicationConflict("Wiki changed during checked publication");
            pages.splice(0, pages.length, ...published);
            return pageContext();
          },
        });
        validateWikiGeneration(output, pages, bundle.readPaths());
        failureMessage =
          "Wiki source changed during the update. Saved pages are retained; a fresh update will follow.";
        await repository.verifyHead(
          bundle.project.repository,
          generation.commitSha,
          "Default branch changed during Wiki update. A fresh update will follow.",
        );
        failureMessage =
          "The Wiki update could not be saved. Current pages are retained; retry the update.";
        const published = await publishWikiPackage(database, {
          generationID,
          attemptID: attemptId,
          ...generation,
          pages,
          output,
          complete: true,
        });
        if (published) return;
      } catch (cause) {
        if (!(cause instanceof WikiPublicationConflict)) throw cause;
      }
    }
    failureMessage =
      "Wiki changed repeatedly during the update. Saved content is retained; retry when edits settle.";
    throw new Error(failureMessage);
  } catch (cause) {
    failureMessage = wikiGenerationFailureMessage(cause, failureMessage);
    await database.db
      .update(operation)
      .set({
        state: "failed",
        activeKey: null,
        error: failureMessage,
        payload: expression`${operation.payload} || jsonb_build_object('failure', ${failureMessage}::text)`,
        completedAt: expression`now()`,
        updatedAt: expression`now()`,
      })
      .where(
        attemptWhere(generationID, attemptId, inArray(operation.state, ["pending", "running"])),
      );
  }
}
