import type { PullRow } from "@rocicorp/zero";
import { z } from "zod";
import { wikiGenerationProgress } from "#knowledge-domain/generation";
import type { FactoryZeroSchema } from "#zero-schema";
import { optionalNumber, optionalString } from "../optional-values";

export const codeReference = z
  .object({
    commitSha: z.string().regex(/^[0-9a-f]{40}$|^[0-9a-f]{64}$/),
    path: z.string().min(1).max(1000),
  })
  .strict();
export const codeReadInput = codeReference.extend({
  startLine: z.number().int().min(1).max(100000).default(1),
  lineCount: z.number().int().min(1).max(160).default(80),
});
export const codeReadResult = codeReadInput.extend({
  body: z.string().max(16000),
  truncated: z.boolean(),
  nextStartLine: z.number().int().positive().nullable().optional(),
  totalLines: z.number().int().nonnegative().optional(),
  url: z.string().url(),
});

export type KnowledgePage = Pick<
  PullRow<"knowledgePage", FactoryZeroSchema>,
  | "id"
  | "projectId"
  | "slug"
  | "title"
  | "state"
  | "version"
  | "parentId"
  | "sortOrder"
  | "icon"
  | "metadataVersion"
  | "currentRevisionId"
  | "currentBody"
>;

export type KnowledgePageOutline = Omit<KnowledgePage, "currentBody">;

export const knowledgeSaveSchema = z.object({
  id: z.uuid(),
  version: z.number().int().positive(),
  title: z.string(),
  body: z.string(),
  revisionId: z.uuid().nullable(),
});

export type KnowledgeSave = z.infer<typeof knowledgeSaveSchema>;

export const repositoryDocumentSchema = z.object({
  path: z.string(),
  title: z.string(),
  sha: z.string(),
  size: z.coerce.number(),
});

export type RepositoryDocument = z.infer<typeof repositoryDocumentSchema>;

export const openRepositoryDocumentSchema = z.object({
  path: z.string(),
  title: z.string(),
  body: z.string(),
  blobSha: z.string(),
  commitSha: z.string(),
});

export type OpenRepositoryDocument = z.infer<typeof openRepositoryDocumentSchema>;

export const knowledgeGenerationSchema = z.object({
  id: z.string(),
  state: z.enum(["pending", "running", "succeeded", "failed"]),
  pageCount: optionalNumber,
  conflictCount: optionalNumber,
  failure: optionalString,
  progress: z.preprocess(
    (value) => (value === null ? undefined : value),
    wikiGenerationProgress.optional(),
  ),
});

export type KnowledgeGeneration = z.infer<typeof knowledgeGenerationSchema>;

export const knowledgeRevisionSchema = z.object({
  id: z.string(),
  ordinal: z.coerce.number(),
  kind: z.enum(["generated", "human", "proposed"]),
  title: z.string(),
  body: z.string(),
  sourceCommitSha: z.string().optional(),
  createdAt: z.string(),
  author: optionalString,
});

export type KnowledgeRevision = z.infer<typeof knowledgeRevisionSchema>;

export const knowledgeSourcesSchema = z.object({
  citations: z.array(z.object({ path: z.string(), commitSha: z.string() })),
});

export const repositoryDocumentsSchema = z.object({
  commitSha: z.string(),
  documents: z.array(repositoryDocumentSchema),
});

export const knowledgeHistorySchema = z.object({ revisions: z.array(knowledgeRevisionSchema) });

export const knowledgeSearchResultSchema = z.object({
  id: z.string(),
  kind: z.enum(["page", "document"]),
  title: z.string(),
  path: z.string(),
  snippet: z.string(),
});

export type KnowledgeSearchResult = z.infer<typeof knowledgeSearchResultSchema>;

export const knowledgeSearchSchema = z.object({ results: z.array(knowledgeSearchResultSchema) });
