import type { z } from "zod";
import type { ProjectAgentOutput } from "#conversation-domain/conversation";
import type { technicalPlanningBaseInput } from "#requirement-domain/technical-design";
import type { AgentTurnRecord } from "../agent/turn-record";
import type { createAgentTurnStore } from "../agent/turns-api";
import { CommandError } from "../command-error";
import { type LearningSourceArtifact, retainLearningArtifactsIn } from "../learning/api";
import {
  knownModelRejection,
  ModelExecutionBoundError,
  modelExecutionBound,
} from "../models/execution-policy";
import { renderArchitectureDiagrams } from "../technical-design/diagrams";
import { validateCitations } from "./citations";
import { ProjectContextLimitError } from "./context";
import { persistProjectOutput } from "./effects";
import { ProjectAgentOutputError } from "./structured-output";
import type { ProjectAgentDatabase, ProjectKnowledgeTools } from "./turn-types";

export function authorityFailure(cause: unknown) {
  let current = cause;
  for (let depth = 0; depth < 8 && current && typeof current === "object"; depth++) {
    const error = current as Record<string, unknown>;
    // Native steps can preserve the name/code without the CommandError prototype.
    const code = error["code"];
    if (
      error["name"] === "CommandError" &&
      (code === "forbidden" || code === "not-found" || code === "conflict")
    )
      return new CommandError(
        code,
        typeof error["message"] === "string" ? error["message"] : "Project authority changed",
      );
    current = error["cause"];
  }
  return undefined;
}

export function classifyExecutionFailure(cause: unknown, abortReason: unknown) {
  const lostAuthority = authorityFailure(cause) ?? authorityFailure(abortReason);
  if (lostAuthority) {
    return {
      status: "failed" as const,
      summary:
        "The Project Agent execution authority changed. Your input is saved; no response was published.",
      errorToThrow: lostAuthority,
    };
  }
  if (cause instanceof ProjectAgentOutputError) {
    return { status: "failed" as const, summary: cause.retainedMessage, errorToThrow: cause };
  }
  if (cause instanceof ProjectContextLimitError) {
    return { status: "failed" as const, summary: cause.message, errorToThrow: cause };
  }
  const bound = modelExecutionBound(cause);
  if (bound) {
    const summary = `The model ${bound === "input" ? "input limit" : "request allowance"} was reached before the next provider request. Your input is saved. No additional provider request was started.`;
    return {
      status: "failed" as const,
      summary,
      errorToThrow: new CommandError("unavailable", summary),
    };
  }
  if (cause instanceof ModelExecutionBoundError || knownModelRejection(cause)) {
    return {
      status: "failed" as const,
      summary:
        "The provider rejected this request or a configured bound was reached. Your input is saved.",
      errorToThrow: cause,
    };
  }
  return {
    status: "uncertain" as const,
    summary:
      "The provider outcome could not be established. The same command will not be submitted again.",
    errorToThrow: cause,
  };
}

function publicationFailureSummary(cause: unknown, step: string) {
  if (cause instanceof ProjectAgentOutputError) return `${cause.retainedMessage} Step: ${step}.`;
  if (cause instanceof CommandError) return cause.message;
  return `The Agent response could not be saved during ${step}. Your input is retained.`;
}

function publicationFailureCategory(cause: unknown) {
  if (cause instanceof ProjectAgentOutputError) return "invalid-output";
  if (cause instanceof CommandError) return cause.code;
  return "persistence-or-renderer";
}

export async function publishProjectOutput(
  deps: {
    database: ProjectAgentDatabase;
    turns: ReturnType<typeof createAgentTurnStore>;
    knowledge?: ProjectKnowledgeTools;
  },
  params: {
    owner: AgentTurnRecord;
    token: string;
    output: ProjectAgentOutput;
    codeRead: boolean;
    technicalPlanning?: z.infer<typeof technicalPlanningBaseInput>;
    fullPlanningSourceCommit?: string;
    readCodeSources: Set<string>;
    projectSources: Set<string>;
    learningArtifacts: LearningSourceArtifact[];
  },
) {
  const { database, turns, knowledge } = deps;
  const {
    owner,
    token,
    output,
    codeRead,
    technicalPlanning,
    fullPlanningSourceCommit,
    readCodeSources,
    projectSources,
    learningArtifacts,
  } = params;
  const { command } = owner;
  let publicationStep = "source validation";
  try {
    output.citations = await validateCitations(database, knowledge, {
      projectID: command.projectId,
      citations: output.citations,
      userID: command.createdBy,
      readCodeSources,
      projectSources,
    });

    publicationStep = "technical source validation";
    if (
      output.kind === "technical-design" &&
      (!technicalPlanning ||
        !output.citations.some((citation) => citation.source === "code") ||
        output.citations.some(
          (citation) =>
            citation.source === "code" && citation.commitSha !== technicalPlanning.sourceCommit,
        ))
    )
      throw new ProjectAgentOutputError();

    publicationStep = "architecture diagram rendering";
    const technical =
      output.kind === "technical-design" && technicalPlanning
        ? {
            base: technicalPlanning,
            renders: await renderArchitectureDiagrams(output.design, { allowUnrendered: true }),
          }
        : undefined;

    publicationStep = "citation reference validation";
    const supported = new Set(output.citations.map((citation) => citation.reference));
    if (
      [...output.message.matchAll(/\[\^(\d+)\]/g)].some((match) => !supported.has(Number(match[1])))
    )
      throw new ProjectAgentOutputError();

    publicationStep = "saving the response";
    const settled = await turns.settle(
      owner.id,
      token,
      "completed",
      "Project Agent response saved.",
      async (transaction) => {
        await persistProjectOutput(
          transaction,
          owner,
          output,
          codeRead || Boolean(technicalPlanning),
          technical,
          fullPlanningSourceCommit,
        );
        await retainLearningArtifactsIn(transaction, owner, learningArtifacts);
      },
    );
    if (!settled) throw new CommandError("conflict", "The Agent turn no longer owns this response");
  } catch (cause) {
    await turns.settle(
      owner.id,
      token,
      "failed",
      publicationFailureSummary(cause, publicationStep),
    );
    // Keep diagnostics content-free. Provider/generated content and raw SDK
    // errors may contain private source or credentials.
    console.error("Project response publication failed", {
      turnID: owner.id,
      step: publicationStep,
      category: publicationFailureCategory(cause),
    });
    throw cause;
  }
}
