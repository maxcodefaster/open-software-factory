import {
  verificationDiagnosisInput,
  verificationToolCallInput,
  verificationToolCatalogue,
} from "../../../../packages/conversation-domain/src/verification";
import type { BuildBrowserResult } from "../../../../packages/conversation-domain/src/browser-tools";
import type { createDatabase } from "../../../../packages/db/src/client";
import { createForgejoClient } from "../../../../packages/forge/src/forge";
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
    const [verification] = await database.client<
      {
        id: string;
        commit: string;
        runID: string;
        diagnosis: unknown;
        repository: string;
      }[]
    >`SELECT verification.id,verification.commit_sha AS commit,verification.action_run_id AS "runID",
      verification.diagnosis,project.repository_url AS repository
      FROM factory.verification verification
      JOIN factory.change change ON change.id=verification.change_id
      JOIN factory.project project ON project.id=change.project_id
      WHERE verification.id=${turn.command.commandId} AND verification.change_id=${turn.command.changeId}
        AND verification.state='failed' AND verification.action_run_id IS NOT NULL`;
    if (!verification)
      throw new CommandError(
        "not-found",
        "No failed Verification is admitted for this correction.",
      );
    return verification;
  }
  return {
    async tools(turnID: string) {
      const [bound] = await database.client`SELECT verification.id FROM factory.agent_turn turn
        JOIN factory.verification verification ON verification.id=turn.command_id
          AND verification.change_id=turn.change_id
        WHERE turn.id=${turnID} AND turn.input->>'kind'='change-repair'`;
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
