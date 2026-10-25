import { z } from "zod";
import { knowledgeEditInput } from "../../../../packages/knowledge-domain/src/knowledge";
import type { createAccessController } from "../access/controller";
import {
  knowledgeGenerationSchema,
  knowledgeHistorySchema,
  knowledgeSaveSchema,
  knowledgeSearchSchema,
  knowledgeSourcesSchema,
  openRepositoryDocumentSchema,
  repositoryDocumentsSchema,
} from "../api-contracts";
import type { createKnowledgeController } from "./controller";

export function createKnowledgeService(options: {
  controller: Pick<
    ReturnType<typeof createKnowledgeController>,
    | "generation"
    | "generate"
    | "edit"
    | "archive"
    | "restore"
    | "sources"
    | "search"
    | "documents"
    | "document"
  > & {
    history(pageID: string, userID: string): Promise<Array<Record<string, unknown>>>;
  };
  access: Pick<ReturnType<typeof createAccessController>, "requireProject" | "requireDevelopment">;
  observeRetry(projectID: string, userID: string, generationID: string): Promise<unknown>;
}) {
  const { controller, access } = options;
  return {
    async generation(userID: string, projectID: string) {
      await access.requireProject(userID, projectID);
      return knowledgeGenerationSchema.nullable().parse(await controller.generation(projectID));
    },
    async generate(userID: string, projectID: string) {
      await access.requireProject(userID, projectID);
      const result = knowledgeGenerationSchema
        .nullable()
        .parse(await controller.generate(projectID, userID));
      if (result) await options.observeRetry(projectID, userID, z.uuid().parse(result.id));
      return result;
    },
    async save(userID: string, pageID: string, input: z.input<typeof knowledgeEditInput>) {
      return knowledgeSaveSchema.parse(
        await controller.edit(pageID, knowledgeEditInput.parse(input), userID),
      );
    },
    async archive(userID: string, pageID: string, expectedVersion: number) {
      await controller.archive(pageID, expectedVersion, userID);
    },
    async restore(userID: string, pageID: string, revisionID: string, expectedVersion: number) {
      return knowledgeSaveSchema.parse(
        await controller.restore(pageID, revisionID, expectedVersion, userID),
      );
    },
    async sources(userID: string, pageID: string) {
      return knowledgeSourcesSchema.parse(await controller.sources(pageID, userID));
    },
    async history(userID: string, pageID: string) {
      const revisions = (await controller.history(pageID, userID)).map((revision) => ({
        ...revision,
        // The old JSON adapter represented SQL timestamps as ISO strings.
        // Native serialization retains Date objects, so keep this DTO explicit.
        createdAt:
          revision["createdAt"] instanceof Date
            ? revision["createdAt"].toISOString()
            : revision["createdAt"],
      }));
      return knowledgeHistorySchema.parse({ revisions });
    },
    async search(userID: string, projectID: string, query: string) {
      await access.requireProject(userID, projectID);
      return knowledgeSearchSchema.parse({
        results: await controller.search(projectID, query, userID),
      });
    },
    async documents(userID: string, projectID: string) {
      await access.requireDevelopment(userID, projectID);
      return repositoryDocumentsSchema.parse(await controller.documents(projectID));
    },
    async document(userID: string, projectID: string, path: string) {
      await access.requireDevelopment(userID, projectID);
      return openRepositoryDocumentSchema.parse(await controller.document(projectID, path));
    },
  };
}
