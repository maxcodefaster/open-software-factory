import type { PullRow } from "@rocicorp/zero";
import { z } from "zod";
import {
  conversationModeInput,
  sourceCitationInput,
} from "../../../packages/conversation-domain/src/conversation";
import { desktopBackgroundKeys } from "../../../packages/interface-domain/src/background";
import { turnObservationInput } from "../../../packages/conversation-domain/src/turn-observation";
import type { FactoryZeroSchema } from "../../../packages/zero-schema/src";
import { requirementContentInput } from "../../../packages/requirement-domain/src/content";

export const requirementProposalSchema = z.object({
  id: z.uuid(),
  ticket: z.object({ title: z.string(), description: z.string() }),
  requirement: requirementContentInput,
  base: z.object({
    version: z.number(),
    documentId: z.uuid().nullable(),
    revisionId: z.uuid().nullable(),
  }),
});
export type RequirementProposal = z.infer<typeof requirementProposalSchema>;

const optionalString = z.preprocess(
  (value) => (value === null ? undefined : value),
  z.string().optional(),
);

const optionalNumber = z.preprocess(
  (value) => (value === null ? undefined : value),
  z.number().optional(),
);

function optionalEnum<const TValues extends readonly [string, ...string[]]>(values: TValues) {
  return z.preprocess((value) => (value === null ? undefined : value), z.enum(values).optional());
}

export type Project = Pick<
  PullRow<"project", FactoryZeroSchema>,
  "id" | "slug" | "name" | "repositoryUrl" | "defaultBranch" | "devcontainerPath" | "createdAt"
>;
export type Ticket = Pick<
  PullRow<"ticket", FactoryZeroSchema>,
  "id" | "projectId" | "epicId" | "title" | "description" | "state" | "version"
> & {
  trashedAt?: string | number | null | undefined;
  trashStopPending?: boolean | null | undefined;
  trashError?: string | null | undefined;
  convertedToEpicId?: string | null | undefined;
};
export type Epic = Pick<
  PullRow<"epic", FactoryZeroSchema>,
  "id" | "projectId" | "parentId" | "title" | "description" | "version"
>;
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

export const knowledgeSaveSchema = z.object({
  id: z.uuid(),
  version: z.number().int().positive(),
  title: z.string(),
  body: z.string(),
  revisionId: z.uuid().nullable(),
});
export type KnowledgeSave = z.infer<typeof knowledgeSaveSchema>;

export const sessionSchema = z.object({
  user: z.object({ id: z.string(), name: z.string(), email: z.string() }),
  systemManager: z.boolean().default(false),
});
export type Session = z.infer<typeof sessionSchema>;

export const uiPreferenceSchema = z.object({
  desktopBackgroundKey: z.enum(desktopBackgroundKeys),
});
export type UIPreference = z.infer<typeof uiPreferenceSchema>;

export const bootstrapSchema = z.object({
  session: sessionSchema.nullable(),
  uiPreference: uiPreferenceSchema,
  zeroCacheURL: z.string(),
  modelRelayConfigured: z.boolean(),
  identity: z
    .object({ companySignIn: z.boolean(), sessionDays: z.number() })
    .default({ companySignIn: false, sessionDays: 7 }),
});
export type Bootstrap = z.infer<typeof bootstrapSchema>;

export const sourceWorkspaceViewSchema = z.object({
  workspaceID: z.uuid(),
  serviceID: z.string(),
  epoch: z.number().int().positive(),
  state: z.enum(["create-intended", "preparing", "ready", "failed", "stop-intended", "stopped"]),
  failure: z.string().nullable(),
});
export const developerIDEViewSchema = z.object({
  serviceID: z.string(),
  epoch: z.number().int().positive(),
  state: z.enum(["create-intended", "preparing", "ready", "failed", "stop-intended", "stopped"]),
  failure: z.string().nullable(),
});

export const projectSchema = z.object({
  id: z.string(),
  slug: z.string(),
  name: z.string(),
  repositoryUrl: z.string(),
  defaultBranch: z.string(),
  devcontainerPath: z.string(),
  createdAt: z.union([z.number(), z.string()]),
});

export const runtimeAttemptSchema = z.object({
  computeWait: optionalString,
  id: z.string(),
  projectId: z.string(),
  changeId: optionalString,
  workspaceId: optionalString,
  workspaceKind: optionalEnum(["personal", "ticket"]),
  runtimeKind: optionalEnum(["personal", "ticket", "staging", "verification"]),
  currentStaging: z.boolean().optional(),
  ownerUserId: optionalString,
  state: z.string(),
  failure: optionalString,
});
export type RuntimeAttempt = z.infer<typeof runtimeAttemptSchema>;
export const appPreviewsSchema = z.object({
  previews: z.array(
    z.object({
      attemptID: z.string(),
      projectID: z.string(),
      channel: z.string(),
      label: z.string(),
    }),
  ),
});
export type AppPreview = z.infer<typeof appPreviewsSchema>["previews"][number];

export type RuntimeDockTarget = {
  id: string;
  label: string;
  detail: string;
  attemptId?: string;
  changeId?: string;
  projectId?: string;
  appChannel?: string;
};

export const requirementRevisionSchema = z.object({
  id: z.string(),
  ordinal: z.coerce.number(),
  canonicalContent: z.string(),
  contentDigest: z.string(),
  createdAt: z.string().optional(),
  approvalId: optionalString,
  approvedAt: optionalString,
  author: optionalString,
  authorKind: z.enum(["human", "ai"]).optional(),
});
export type RequirementRevision = z.infer<typeof requirementRevisionSchema>;
export const ticketDocumentRevisionSchema = requirementRevisionSchema.extend({
  title: z.string(),
  description: z.string(),
  requirementRevisionId: z.uuid().nullable(),
  proposalEntryId: z.uuid().nullable().optional(),
});
export type TicketDocumentRevision = z.infer<typeof ticketDocumentRevisionSchema>;

export const changeSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  ticketId: z.string(),
  requirementApprovalId: optionalString,
  branchName: z.string(),
  baseSha: z.string(),
  state: z.string(),
  branchState: z.string(),
  branchHeadSha: optionalString,
  runtimeAttemptId: optionalString,
  runtimeState: optionalString,
  verificationState: optionalString,
  buildTurnState: optionalString,
  implementationState: optionalString,
  deliveryApprovedAt: optionalString,
  mergeState: optionalString,
  promotionState: optionalString,
  failure: optionalString,
});
export type Change = z.infer<typeof changeSchema>;

export const agentMessageSchema = z.object({
  id: z.string(),
  role: z.enum(["user", "assistant", "tool"]),
  text: z.string(),
  at: z.number(),
  activity: z
    .object({
      name: z.string(),
      status: z.enum(["pending", "streaming", "running", "completed", "error"]),
      detail: optionalString,
    })
    .optional(),
});
export type AgentMessage = z.infer<typeof agentMessageSchema>;

export const agentViewSchema = z.object({
  computeWait: optionalString,
  codingPause: z.object({ reason: z.string(), turnID: z.uuid() }).nullable().optional(),
  state: z.enum(["idle", "starting", "working", "waiting", "stopped", "failed", "committed"]),
  runtimeState: optionalString,
  lastError: optionalString,
  commitSHA: optionalString,
  commitOperation: z
    .object({
      id: z.uuid(),
      state: z.enum(["commit-intended", "committed", "push-intended"]),
      lastError: optionalString,
    })
    .optional(),
  messages: z.array(agentMessageSchema),
  messagesAvailable: z.boolean(),
  sessionAvailable: z.boolean(),
  runtimeConnected: z.boolean(),
  stopPending: z.boolean(),
  stopId: z.uuid().nullable(),
  turn: turnObservationInput.optional(),
});
export type AgentView = z.infer<typeof agentViewSchema>;

export const conversationEntrySchema = z.object({
  id: z.string(),
  ordinal: z.coerce.number(),
  kind: z.enum([
    "user-message",
    "agent-message",
    "question",
    "answer",
    "requirement",
    "mode-change",
  ]),
  actor: z.enum(["user", "project-agent", "change-agent", "system"]),
  mode: conversationModeInput,
  body: z.string(),
  payload: z.record(z.string(), z.unknown()),
  citations: z.array(sourceCitationInput),
  inReplyToEntryId: optionalString,
  requirementRevisionId: optionalString,
  createdAt: z.string(),
});
export type ConversationEntry = z.infer<typeof conversationEntrySchema>;

export const conversationViewSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  ticketId: optionalString,
  mode: conversationModeInput,
  version: z.coerce.number(),
  entries: z.array(conversationEntrySchema),
  turn: turnObservationInput.optional(),
});
export type ConversationView = z.infer<typeof conversationViewSchema>;

export const deliveryViewSchema = z.object({
  cleanupError: optionalString,
  pullRequestNumber: z.preprocess(
    (value) =>
      value === null
        ? undefined
        : typeof value === "string" && /^[1-9]\d*$/.test(value)
          ? Number(value)
          : value,
    z.number().int().positive().optional(),
  ),
  pullRequestUrl: optionalString,
  pullRequestState: optionalString,
  verificationCommitSha: optionalString,
  verificationState: optionalString,
  verificationSummary: optionalString,
  actionRunUrl: optionalString,
  approvedAt: optionalString,
  mergeState: optionalString,
  mergedCommitSha: optionalString,
  promotionState: optionalString,
  replacementRuntimeAttemptId: optionalString,
  replacementRuntimeState: optionalString,
});
export type DeliveryView = z.infer<typeof deliveryViewSchema>;

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

export const ticketDetailSchema = z.object({
  ticket: z.object({
    id: z.string(),
    projectId: z.string(),
    epicId: z.uuid().nullable().default(null),
    convertedToEpicId: z.uuid().nullable().default(null),
    title: z.string(),
    description: z.string(),
    state: z.enum(["inbox", "backlog", "ready", "in-progress", "cancelled", "done"]),
    version: z.coerce.number(),
    trashedAt: optionalString,
    trashStopPending: z.boolean().optional(),
    trashError: optionalString,
  }),
  revisions: z.array(requirementRevisionSchema),
  documentRevisions: z.array(ticketDocumentRevisionSchema).default([]),
  proposal: requirementProposalSchema.nullable().default(null),
  requirementsEntry: z
    .object({ state: z.enum(["pending", "admitted", "failed"]), failure: z.string().nullable() })
    .nullable()
    .optional(),
  origin: z.object({ id: z.uuid(), title: z.string() }).nullable().default(null),
  followUps: z.array(z.object({ id: z.uuid(), title: z.string() })).default([]),
});
export type TicketDetail = z.infer<typeof ticketDetailSchema>;

export const changesResponseSchema = z.object({ changes: z.array(changeSchema) });
export const attemptsResponseSchema = z.object({ attempts: z.array(runtimeAttemptSchema) });
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
