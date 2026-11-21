import { z } from "zod";
import type { MCPAssignment } from "../../../../packages/conversation-domain/src/mcp-library";
import type { UsageCounters } from "../../../../packages/conversation-domain/src/usage";
import { requirementContentInput } from "../../../../packages/requirement-domain/src/content";
import { type codeReadInput, type codeReadResult } from "../knowledge/contracts";
import type { ResolvedModelConnection } from "../models/inference-contracts";

export const monitoringDiagnosis = z
  .object({
    outcome: z.enum(["fix", "insufficient-context", "not-application-defect"]),
    explanation: z.string().trim().min(1).max(4_000),
    title: z.string().trim().min(1).max(200),
    requirements: requirementContentInput.nullable(),
    code: z.array(z.object({ path: z.string(), commitSha: z.string() }).strict()).max(12),
  })
  .strict();
export type MonitoringDiagnosis = z.infer<typeof monitoringDiagnosis>;

export class MonitoringDiagnosisError extends Error {
  constructor() {
    super("Diagnosis did not establish the monitoring incident and exact application source");
    this.name = "MonitoringDiagnosisError";
  }
}

export type MonitoringDiagnosisInput = {
  projectId: string;
  userId: string;
  title: string;
  reference: string | null;
  context: string;
  assignment: MCPAssignment;
  assignments?: MCPAssignment[];
  instructions?: string;
  modelId: string;
  connection: ResolvedModelConnection;
  mcp: {
    call(
      assignment: MCPAssignment,
      projectId: string,
      userId: string,
      name: string,
      args: Record<string, unknown>,
      authorize: () => Promise<void>,
      signal: AbortSignal,
    ): Promise<{ content: string; isError: boolean }>;
  };
  code: {
    codePaths(
      projectId: string,
      query: string,
      userId: string,
    ): Promise<{ commitSha: string; paths: string[]; truncated: boolean }>;
    code(
      projectId: string,
      input: z.output<typeof codeReadInput>,
      userId: string,
    ): Promise<z.output<typeof codeReadResult>>;
  };
  signal: AbortSignal;
  authorize(): Promise<void>;
  usage: {
    begin(): Promise<void>;
    record(entry: {
      eventID: string;
      source: "step" | "title" | "compaction" | "unobserved";
      outcome: "completed" | "failed" | "interrupted" | "unknown";
      counters: UsageCounters;
      occurredAt: string;
    }): Promise<void>;
    settle(outcome: "completed" | "failed" | "interrupted" | "unknown"): Promise<void>;
  };
  observe(value: {
    kind: string;
    digest: string;
    path?: string;
    commitSha?: string;
  }): Promise<void>;
};
