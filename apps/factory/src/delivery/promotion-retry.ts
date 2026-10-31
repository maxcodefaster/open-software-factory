import type { createDatabase } from "../../../../packages/db/src/client";
import { projectDevelopmentAuthorityIn } from "../access/controller";
import { CommandError } from "../command-error";

// Persist a new Promotion, never reset the failed operation or repeat merge.
// The command's identity is also the new immutable Promotion identity.
export async function retryPromotion(
  database: ReturnType<typeof createDatabase>,
  changeID: string,
  userID: string,
  commandID: string,
  promotionID: string,
  defaultHead: (repositoryURL: string) => Promise<string>,
) {
  return database.client.begin(async (sql) => {
    const [change] = await sql<
      { projectID: string; state: string; repositoryURL: string }[]
    >`SELECT change.project_id AS "projectID",change.state,project.repository_url AS "repositoryURL"
      FROM factory.change change JOIN factory.project project ON project.id=change.project_id
      JOIN factory.ticket ticket ON ticket.id=change.ticket_id AND ticket.trashed_at IS NULL
      WHERE change.id=${changeID} FOR UPDATE OF change,ticket`;
    if (!change) throw new CommandError("not-found", "Change not found");
    await projectDevelopmentAuthorityIn(sql, userID, change.projectID);
    const scope = `promotion-retry:${changeID}`;
    const input = { changeID, promotionID };
    const [replay] = await sql<
      { scope: string; actor: string; input: typeof input }[]
    >`SELECT scope,actor_id AS actor,input FROM factory.execution_policy_command
      WHERE command_id=${commandID}`;
    if (replay) {
      if (
        replay.scope !== scope ||
        replay.actor !== userID ||
        replay.input.changeID !== changeID ||
        replay.input.promotionID !== promotionID
      )
        throw new CommandError("conflict", "Promotion retry changed target");
      return false;
    }
    const [previous] = await sql<
      {
        id: string;
        ordinal: number;
        state: string;
        commitSHA: string;
        previousAttemptID: string | null;
        replacementAttemptID: string | null;
        replacementState: string | null;
        released: boolean;
        merged: boolean;
      }[]
    >`SELECT promotion.id,promotion.ordinal,promotion.state,promotion.commit_sha AS "commitSHA",
      promotion.previous_runtime_attempt_id AS "previousAttemptID",
      promotion.replacement_runtime_attempt_id AS "replacementAttemptID",
      runtime.state AS "replacementState",
      NOT EXISTS(SELECT 1 FROM factory.factorybox_runtime native
        WHERE native.runtime_attempt_id=runtime.id AND native.inputs_released_at IS NULL) AS released,
      EXISTS(SELECT 1 FROM factory.merge_operation merge
        WHERE merge.change_id=promotion.change_id AND merge.state='succeeded'
          AND merge.commit_sha=promotion.commit_sha AND merge.observed_default_sha=promotion.commit_sha) AS merged
      FROM factory.current_promotion promotion
      LEFT JOIN factory.runtime_attempt runtime ON runtime.id=promotion.replacement_runtime_attempt_id
      WHERE promotion.change_id=${changeID}`;
    if (!previous || previous.id !== promotionID)
      throw new CommandError(
        "conflict",
        "Promotion changed. Refresh before retrying Main Preview.",
      );
    if (
      change.state !== "delivering" ||
      previous.state !== "failed" ||
      !previous.merged ||
      !previous.replacementAttemptID ||
      !["failed", "stopped"].includes(previous.replacementState ?? "") ||
      !previous.released
    )
      throw new CommandError(
        "conflict",
        "Retry Main Preview only after its failed replacement and owned cleanup are confirmed.",
      );
    const [staging] = await sql<{ attemptID: string | null }[]>`
      SELECT runtime_attempt_id AS "attemptID" FROM factory.staging_preview
      WHERE project_id=${change.projectID} FOR UPDATE`;
    if ((staging?.attemptID ?? null) !== previous.previousAttemptID)
      throw new CommandError(
        "conflict",
        "The current Main Preview changed. Its identity was retained.",
      );
    if ((await defaultHead(change.repositoryURL)) !== previous.commitSHA)
      throw new CommandError("conflict", "The default branch changed after this merge.");
    await sql`INSERT INTO factory.execution_policy_command(command_id,scope,actor_id,input,result)
      VALUES(${commandID},${scope},${userID},${JSON.stringify(input)}::jsonb,
        ${JSON.stringify({ promotionID: commandID })}::jsonb)`;
    await sql`INSERT INTO factory.promotion_operation(
      id,change_id,project_id,commit_sha,previous_runtime_attempt_id,ordinal,supersedes_id,retry_command_id)
      VALUES(${commandID},${changeID},${change.projectID},${previous.commitSHA},
        ${previous.previousAttemptID},${previous.ordinal + 1},${previous.id},${commandID})`;
    return true;
  });
}
