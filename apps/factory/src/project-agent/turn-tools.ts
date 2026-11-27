import type { z } from "zod";
import { type attachmentToolCallInput, attachmentURL } from "#conversation-domain/attachments";
import { drizzleTransaction } from "#db/client";
import { auditEvent, operation } from "#db/schema";
import type { technicalPlanningBaseInput } from "#requirement-domain/technical-design";
import type { AgentTurnRecord } from "../agent/turn-record";
import { attachmentContextIn } from "../attachments/api";
import { createAttachmentTools } from "../attachments/tools-api";
import { CommandError } from "../command-error";
import type { ConversationEntry } from "../conversations/api";
import { codeReadInput } from "../knowledge/contracts";
import type { LearningSourceArtifact } from "../learning/api";
import { connectFactoryMCP } from "../mcp/api";
import { mcpDigest } from "../mcp/library-api";
import { mcpSourceTools } from "../mcp/sources-api";
import { readResearch, searchResearch } from "./research";
import type { ProjectKnowledgeTools, ProjectTurnExecutionDeps } from "./turn-types";

export type ProjectTurnCommand = Extract<
  AgentTurnRecord["command"],
  { kind: "project-message" | "project-answer" }
>;
export type TechnicalPlanningBase = z.infer<typeof technicalPlanningBaseInput>;

export type TurnObservationState = {
  codeRead: boolean;
  readCodeSources: Set<string>;
  projectSources: Set<string>;
  learningArtifacts: LearningSourceArtifact[];
};

export function createTurnObservationState(
  history: ConversationEntry[],
  ticketId: string | null,
): TurnObservationState {
  const projectSources = new Set(
    history.flatMap((entry) =>
      entry.citations.map((citation) => `${citation.source}:${citation.id}`),
    ),
  );
  if (ticketId) projectSources.add(`ticket:${ticketId}`);
  return {
    codeRead: history.some(
      (entry) =>
        entry.payload["visibility"] === "developer" ||
        entry.citations.some((citation) => citation.source === "code"),
    ),
    readCodeSources: new Set(
      history.flatMap((entry) =>
        entry.citations
          .filter((citation) => citation.source === "code")
          .map((citation) => `${citation.commitSha}:${citation.path}`),
      ),
    ),
    projectSources,
    learningArtifacts: [],
  };
}

export async function resolveMcpTools(
  deps: ProjectTurnExecutionDeps,
  ownerID: string,
  token: string,
  command: ProjectTurnCommand,
  signal: AbortSignal,
) {
  if (!deps.mcp) return [];
  return mcpSourceTools(
    deps.mcp,
    ownerID,
    command.projectId,
    command.createdBy,
    async () => {
      if (!(await deps.turns.validateExecution(ownerID, token)))
        throw new CommandError("forbidden", "MCP lookup no longer owns this conversation");
    },
    signal,
    async (connectionId, tool, digest, result) => {
      const current = await deps.turns.validateExecution(ownerID, token, async (tx) => {
        await drizzleTransaction(tx)
          .insert(auditEvent)
          .values({
            id: crypto.randomUUID(),
            kind: "mcp.observation",
            scopeType: "connection",
            scopeId: connectionId,
            actorId: command.createdBy,
            payload: {
              turnId: ownerID,
              toolName: tool,
              toolDigest: digest,
              resultDigest: mcpDigest(result.content),
              isError: result.isError,
            },
          });
      });
      if (!current)
        throw new CommandError("forbidden", "MCP observation no longer owns this conversation");
    },
  );
}

export async function recordLoadedSkills(
  deps: ProjectTurnExecutionDeps,
  ownerID: string,
  token: string,
  revisionIDs: string[],
) {
  const owned = await deps.turns.validateExecution(ownerID, token, async (tx) => {
    for (const revisionID of revisionIDs) {
      await drizzleTransaction(tx)
        .insert(operation)
        .values({
          id: crypto.randomUUID(),
          kind: "coding.turn_skill",
          scopeType: "agent_turn",
          scopeId: ownerID,
          idempotencyKey: `coding.turn_skill:${ownerID}:${revisionID}`,
          activeKey: null,
          state: "loaded",
          payload: {
            turnId: ownerID,
            revisionId: revisionID,
            loadedAt: new Date().toISOString(),
          },
        })
        .onConflictDoNothing({ target: operation.idempotencyKey });
    }
  });
  if (!owned) throw new CommandError("conflict", "The Agent no longer owns this Skill load");
}

function buildCodeResearch(
  deps: ProjectTurnExecutionDeps,
  knowledge: ProjectKnowledgeTools,
  command: ProjectTurnCommand,
  technicalPlanning: TechnicalPlanningBase | undefined,
  state: TurnObservationState,
) {
  return {
    projectID: command.projectId,
    authorize: () => deps.access.requireDevelopment(command.createdBy, command.projectId),
    paths: async (query: string) => {
      const result = await knowledge.codePaths(
        command.projectId,
        query,
        command.createdBy,
        technicalPlanning?.sourceCommit,
      );
      state.codeRead = true;
      return result;
    },
    read: async (value: Parameters<typeof knowledge.code>[1]) => {
      const parsed = codeReadInput.parse(value);
      if (technicalPlanning && parsed.commitSha !== technicalPlanning.sourceCommit)
        throw new CommandError(
          "conflict",
          "Read the source pinned to this Technical Planning task.",
        );
      const result = await knowledge.code(command.projectId, parsed, command.createdBy);
      state.codeRead = true;
      state.readCodeSources.add(`${parsed.commitSha}:${parsed.path}`);
      if (state.learningArtifacts.length < 3)
        state.learningArtifacts.push({
          reference: `code:${parsed.commitSha}:${parsed.path}:${parsed.startLine}`,
          body: result.body,
          truncated: result.truncated,
        });
      return result;
    },
  };
}

export async function assembleTurnTools(
  deps: ProjectTurnExecutionDeps,
  params: {
    owner: AgentTurnRecord;
    token: string;
    command: ProjectTurnCommand;
    signal: AbortSignal;
    authorizeExecution: () => Promise<void>;
    technicalPlanning?: TechnicalPlanningBase;
    state: TurnObservationState;
  },
) {
  const { database, access } = deps;
  const { owner, token, command, signal, authorizeExecution, technicalPlanning, state } = params;
  const attachmentTools = createAttachmentTools(database);

  const observedSearch = (query: string, source?: "knowledge" | "ticket" | "epic") =>
    searchResearch(database, command.projectId, command.createdBy, query, source);

  const observedRead = async (
    source: "knowledge" | "ticket" | "epic",
    id: string,
    offset?: number,
    expectedVersion?: number,
  ) => {
    const result = await readResearch(
      database,
      command.projectId,
      command.createdBy,
      source,
      id,
      offset,
      expectedVersion,
    );
    state.projectSources.add(`${source}:${id}`);
    if (state.learningArtifacts.length < 3)
      state.learningArtifacts.push({
        reference: `${source}:${id}:v${result.version}`,
        body: result.body,
        truncated: result.truncated || (offset ?? 0) > 0,
      });
    await attachmentTools.discover(
      owner.id,
      token,
      (result.attachments ?? []).map((attachmentId) => attachmentURL(attachmentId)).join("\n"),
    );
    return result;
  };

  const factoryMCP = await connectFactoryMCP({
    database,
    turn: owner,
    ownerToken: token,
    signal,
    authorize: authorizeExecution,
    created: (id) => state.projectSources.add(`ticket:${id}`),
    search: ({ query, source }) => observedSearch(query, source),
    read: ({ source, id, offset, expectedVersion }) =>
      observedRead(source, id, offset, expectedVersion),
  });

  try {
    const canReadCode =
      deps.knowledge !== undefined &&
      (await access.canDevelop(command.createdBy, command.projectId));
    const attachmentContext = await database.client.begin((tx) =>
      attachmentContextIn(tx, owner.id),
    );
    const mcpTools = await resolveMcpTools(deps, owner.id, token, command, signal);

    return {
      factoryTools: factoryMCP.tools,
      attachmentContext,
      attachmentRead: async (call: z.infer<typeof attachmentToolCallInput>) => {
        const result = await attachmentTools.call(owner.id, token, call);
        if (call.name === "attachment_read")
          state.projectSources.add(`attachment:${call.arguments.id}`);
        return result;
      },
      mcpTools,
      skillsLoaded: (revisionIDs: string[]) =>
        recordLoadedSkills(deps, owner.id, token, revisionIDs),
      research: {
        authorize: authorizeExecution,
        search: observedSearch,
        read: observedRead,
        ...(canReadCode && deps.knowledge
          ? { code: buildCodeResearch(deps, deps.knowledge, command, technicalPlanning, state) }
          : {}),
      },
      close: () => factoryMCP.close(),
    };
  } catch (cause) {
    await factoryMCP.close();
    throw cause;
  }
}
