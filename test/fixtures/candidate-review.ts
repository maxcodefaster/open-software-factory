import { createChangeAdmission } from "../../apps/factory/src/agent/change-admission";
import { createReviewAdmission } from "../../apps/factory/src/agent/review-admission";
import { createAgentTurnStore } from "../../apps/factory/src/agent/turn-store";
import { buildModelID, fixture } from "./change-agent-turns";
import type { createDatabase } from "../../packages/db/src/client";
import { seedMonitoringDelegation } from "./monitoring";

export async function candidateReviewFixture(
  canonical?: string,
  database?: ReturnType<typeof createDatabase>,
  autofix = false,
) {
  let monitoring: Awaited<ReturnType<typeof seedMonitoringDelegation>> | undefined;
  const owned = await fixture(
    canonical,
    undefined,
    database,
    undefined,
    autofix
      ? async (sql, context) => {
          monitoring = await seedMonitoringDelegation(sql, context);
          return monitoring;
        }
      : undefined,
  );
  await owned.database
    .client`UPDATE factory.project SET repository_url='https://forge.invalid/owned/review.git' WHERE id=${owned.projectID}`;
  const turns = createAgentTurnStore(owned.database);
  const initial = await createChangeAdmission(owned.database, buildModelID).admit(
    owned.changeID,
    owned.userID,
    { kind: "change-start", commandId: crypto.randomUUID() },
  );
  const owner = await turns.claimPending(initial.turn.id);
  if (!owner?.ownerToken) throw new Error("Missing owned initial lease");
  await owned.writers.prepareAgent(owned.changeID, initial.turn.id);
  await turns.beginDispatch(initial.turn.id, owner.ownerToken);
  await turns.settle(
    initial.turn.id,
    owner.ownerToken,
    "completed",
    "Owned implementation completed",
  );
  const commit = "d".repeat(40);
  const verificationID = crypto.randomUUID();
  const reviewID = crypto.randomUUID();
  await owned.database.client`UPDATE factory.change_agent_session SET
    implementation_session_id=opencode_session_id,implementation_session_confirmed_at=native_session_confirmed_at,
    active_turn_id=${initial.turn.id}
    WHERE change_id=${owned.changeID}`;
  await owned.database.client`INSERT INTO factory.change_commit_operation(
    id,change_id,runtime_attempt_id,sequence,branch_name,expected_parent_sha,commit_sha,
    observed_remote_sha,commit_message,idempotency_key,state,created_by,completed_at)
    SELECT ${initial.turn.id},id,runtime_attempt_id,1,branch_name,base_sha,${commit},
      ${commit},'Owned review candidate',${crypto.randomUUID()},'succeeded',created_by,now()
    FROM factory.change WHERE id=${owned.changeID}`;
  await owned.database
    .client`INSERT INTO factory.verification(id,change_id,commit_sha,pull_request_number,runner_name,
    action_run_id,created_by,state,summary,completed_at)
    VALUES(${verificationID},${owned.changeID},${commit},1,'owned-review',1,${owned.userID},'succeeded','Owned exact CI',now())`;
  await owned.database
    .client`INSERT INTO factory.candidate_review(id,verification_id,change_id,commit_sha,base_sha,created_by)
    VALUES(${reviewID},${verificationID},${owned.changeID},${commit},${"a".repeat(40)},${owned.userID})`;
  async function activeReview(targetID: string = reviewID) {
    const accepted = await createReviewAdmission(owned.database)(
      owned.changeID,
      targetID,
      owned.userID,
    );
    const turn = await turns.claimPending(accepted.turn.id);
    if (!turn?.ownerToken) throw new Error("Missing owned review lease");
    await owned.writers.prepareAgent(owned.changeID, turn.id);
    const [intent] = await owned.database.client<{ session: string }[]>`
      SELECT session_id AS session FROM factory.change_agent_turn_intent WHERE turn_id=${turn.id}`;
    if (!intent) throw new Error("Missing owned review intent");
    await owned.database
      .client`UPDATE factory.change_agent_turn_intent SET runtime_attempt_id=${owned.attemptID} WHERE turn_id=${turn.id}`;
    await owned.database.client`UPDATE factory.change_agent_session SET active_turn_id=${turn.id},
      opencode_session_id=${intent.session},state='starting' WHERE change_id=${owned.changeID}`;
    await turns.beginDispatch(turn.id, turn.ownerToken);
    await turns.markRunning(turn.id, turn.ownerToken, async (sql) => {
      await sql`UPDATE factory.change_agent_session SET state='working' WHERE change_id=${owned.changeID}`;
      await sql`UPDATE factory.candidate_review SET state='running' WHERE id=${targetID}`;
    });
    return { ...turn, ownerToken: turn.ownerToken, sessionID: intent.session };
  }
  return {
    ...owned,
    monitoring,
    turns,
    initial: initial.turn,
    commit,
    verificationID,
    reviewID,
    activeReview,
    async review(targetID: string = reviewID) {
      return (
        await owned.database.client<
          { state: string; result: unknown; evidence: unknown[]; turnID: string | null }[]
        >`
        SELECT state,result,evidence,turn_id AS "turnID" FROM factory.candidate_review WHERE id=${targetID}`
      )[0];
    },
  };
}
