import { and, eq, isNotNull, sql as query } from "drizzle-orm";
import type { BuildBrowserResult } from "#conversation-domain/browser-tools";
import {
  verificationDiagnosisInput,
  verificationToolCallInput,
  verificationToolCatalogue,
} from "#conversation-domain/verification";
import type { createDatabase } from "#db/client";
import { agentTurn, change, project, verification } from "#db/schema";
import { createForgejoClient } from "#forge/forge";
import { CommandError } from "../command-error";
import { createAgentTurnStore } from "./turn-store";

export function createVerificationTools(
  database: ReturnType<typeof createDatabase>,
  forgeOverride?: ReturnType<typeof createForgejoClient>,
) {
  const turns = createAgentTurnStore(database);
  const forge =
    forgeOverride ??
    createForgejoClient({
      apiURL: process.env["FACTORY_FORGEJO_API_URL"] ?? "",
      token: process.env["FACTORY_FORGEJO_TOKEN"] ?? "",
    });
  async function scope(turnID: string, token: string) {
    const turn = await turns.get(turnID);
    if (turn?.command.kind !== "change-repair" || !(await turns.validateExecution(turnID, token)))
      throw new CommandError("forbidden", "Verification evidence no longer owns this correction.");
    const [current] = await database.db
      .select({
        id: verification.id,
        commit: verification.commitSha,
        runID: verification.actionRunId,
        diagnosis: verification.diagnosis,
        repository: project.repositoryUrl,
      })
      .from(verification)
      .innerJoin(change, eq(change.id, verification.changeId))
      .innerJoin(project, eq(project.id, change.projectId))
      .where(
        and(
          eq(verification.id, turn.command.commandId),
          eq(verification.changeId, turn.command.changeId),
          eq(verification.state, "failed"),
          isNotNull(verification.actionRunId),
        ),
      );
    if (!current)
      throw new CommandError(
        "not-found",
        "No failed Verification is admitted for this correction.",
      );
    return current;
  }
  return {
    async tools(turnID: string) {
      const [bound] = await database.db
        .select({ id: verification.id })
        .from(agentTurn)
        .innerJoin(
          verification,
          and(
            eq(verification.id, agentTurn.commandId),
            eq(verification.changeId, agentTurn.changeId),
          ),
        )
        .where(
          and(
            eq(agentTurn.id, turnID),
            eq(query<string>`${agentTurn.input}->>'kind'`, "change-repair"),
          ),
        );
      return bound ? verificationToolCatalogue : [];
    },
    async call(turnID: string, token: string, raw: unknown): Promise<BuildBrowserResult> {
      const { arguments: args } = verificationToolCallInput.parse(raw);
      const current = await scope(turnID, token);
      const diagnosis = verificationDiagnosisInput.parse(current.diagnosis);
      if (
        current.id !== args.verificationId ||
        !diagnosis.jobs.some(
          (job) => job.id === args.jobId && job.attempt === args.attempt && job.step === args.step,
        )
      )
        throw new CommandError(
          "forbidden",
          "Read only the exact failed jobs admitted for this correction.",
        );
      const parts = new URL(current.repository).pathname
        .replace(/\.git$/, "")
        .split("/")
        .filter(Boolean);
      const owner = parts.at(-2);
      const name = parts.at(-1);
      if (!owner || !name || (!forgeOverride && owner !== process.env["FACTORY_FORGEJO_OWNER"]))
        throw new CommandError("forbidden", "Verification repository changed.");
      let result: unknown;
      try {
        result = {
          available: true,
          verificationId: current.id,
          commit: current.commit,
          ...(await forge.readVerificationLog(
            { owner, name },
            {
              runID: Number(current.runID),
              commit: current.commit,
              jobID: args.jobId,
              attempt: args.attempt,
              step: args.step,
              offset: args.offset,
            },
          )),
        };
      } catch {
        result = {
          available: false,
          reason:
            "The exact failed-step log is unavailable or its attempt changed. No action was replayed.",
        };
      }
      await scope(turnID, token);
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    },
  };
}
