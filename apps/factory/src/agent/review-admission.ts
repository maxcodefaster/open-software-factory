import { agentTurnAuthorityInput } from "../../../../packages/conversation-domain/src/agent-turn";
import { buildBrowserInstructions } from "../../../../packages/conversation-domain/src/browser-tools";
import { candidateReviewInstructions } from "../../../../packages/conversation-domain/src/candidate-review";
import type { createDatabase } from "../../../../packages/db/src/client";
import { claimAgentWriterIn, lockChangeWriterIn } from "../access/change-writer";
import { projectAuthorityIn } from "../access/controller";
import { CommandError } from "../command-error";
import { createAgentTurnStore } from "./turn-store";

export function createReviewAdmission(database: ReturnType<typeof createDatabase>) {
  const turns = createAgentTurnStore(database);
  return async (changeID: string, reviewID: string, userID: string) =>
    database.client.begin(async (sql) => {
      await sql`SELECT pg_advisory_xact_lock(hashtext(${`agent-command:${reviewID}`}))`;
      const locked = await lockChangeWriterIn(sql, changeID);
      await projectAuthorityIn(sql, userID, locked.projectID);
      const old = await turns.getByCommand(reviewID, sql);
      if (old) {
        if (
          old.command.kind !== "change-review" ||
          old.command.changeId !== changeID ||
          old.command.createdBy !== userID ||
          old.command.reviewId !== reviewID
        )
          throw new CommandError("conflict", "Review command changed input");
        return turns.admitIn(sql, old.command, old.authority);
      }
      const [change] = await sql<
        {
          projectID: string;
          ticketID: string;
          revisionID: string;
          specification: string;
          title: string;
          conversationID: string | null;
          conversationVersion: number | null;
          baseSHA: string;
          commitSHA: string;
          verificationID: string;
          supersedesID: string | null;
          contextID: string | null;
        }[]
      >`
        SELECT change.project_id AS "projectID",change.ticket_id AS "ticketID",
          revision.id AS "revisionID",revision.canonical_content AS specification,ticket.title,
          conversation.id AS "conversationID",conversation.version::float8 AS "conversationVersion",
          conversation.active_coding_context_id AS "contextID",
          review.base_sha AS "baseSHA",review.commit_sha AS "commitSHA",review.verification_id AS "verificationID",
          review.supersedes_id AS "supersedesID"
        FROM factory.change change
        JOIN factory.ticket ticket ON ticket.id=change.ticket_id
        JOIN factory.requirement_approval approval ON approval.id=change.requirement_approval_id
        JOIN factory.requirement_revision revision ON revision.id=approval.requirement_revision_id
        JOIN factory.candidate_review review ON review.change_id=change.id AND review.id=${reviewID}
        JOIN factory.verification verification ON verification.id=review.verification_id
        LEFT JOIN factory.ticket_conversation conversation ON conversation.ticket_id=ticket.id
        WHERE change.id=${changeID} AND review.created_by=${userID}
          AND (change.state='active' OR (change.state='starting' AND review.supersedes_id IS NOT NULL
            AND EXISTS(SELECT 1 FROM factory.runtime_attempt attempt
              WHERE attempt.id=change.runtime_attempt_id AND attempt.state IN ('stopped','failed'))))
          AND change.cancel_requested_at IS NULL
          AND ticket.trashed_at IS NULL AND verification.state='succeeded'
          AND review.base_sha=change.base_sha
          AND review.commit_sha=(SELECT commit_sha FROM factory.change_commit_operation
            WHERE change_id=change.id AND state='succeeded' ORDER BY sequence DESC LIMIT 1)
          AND revision.id=(SELECT id FROM factory.requirement_revision WHERE ticket_id=ticket.id ORDER BY ordinal DESC LIMIT 1)
          AND (conversation.id IS NULL OR conversation.mode='build')`;
      if (!change)
        throw new CommandError("conflict", "Review needs the current verified candidate");
      const [session] = await sql<
        { state: string; stopPending: boolean }[]
      >`SELECT state,stop_pending AS "stopPending" FROM factory.change_agent_session WHERE change_id=${changeID}`;
      if (
        session?.stopPending ||
        (session && !["committed", "failed", "stopped"].includes(session.state))
      )
        throw new CommandError(
          "conflict",
          "Wait for the implementation and Stop to settle before review",
        );
      const [first] = await sql<{ authority: unknown }[]>`
        SELECT authority FROM factory.agent_turn WHERE change_id=${changeID}
          AND input->>'kind' <> 'change-review' ORDER BY created_at,id LIMIT 1`;
      if (!first) throw new CommandError("conflict", "Review needs the admitted Coding model");
      const authority = agentTurnAuthorityInput.parse(first.authority);
      if (authority.mode !== "build") throw new Error("Missing Coding configuration");
      return turns.admitIn(
        sql,
        {
          kind: "change-review",
          commandId: reviewID,
          reviewId: reviewID,
          changeId: changeID,
          ticketId: change.ticketID,
          projectId: change.projectID,
          conversationId: change.conversationID,
          createdBy: userID,
          ...(change.contextID ? { contextId: change.contextID } : {}),
        },
        {
          ...authority,
          conversationVersion: change.conversationVersion,
          requirementRevisionId: change.revisionID,
          submissionPolicy: "native",
          browserTransport: "mcp",
          // Reviewer guidance is fixed and read-only. Implementation packages
          // can contain scripts and are not activated in the independent Session.
          skillRevisionIds: [],
          requiredSkillRevisionIds: [],
          review: {
            reviewId: reviewID,
            verificationId: change.verificationID,
            commitSha: change.commitSHA,
            baseSha: change.baseSHA,
          },
        },
        async (transaction, record) => {
          await claimAgentWriterIn(transaction, changeID, record.id, userID);
          await transaction`UPDATE factory.coding_pause pause SET resumed_by_turn_id=${record.id}
            FROM factory.candidate_review previous, factory.agent_turn previous_turn
            WHERE previous.id=${change.supersedesID} AND previous.change_id=${changeID}
              AND previous.turn_id=previous_turn.id AND previous_turn.state IN ('failed','stopped')
              AND pause.turn_id=previous.turn_id AND pause.resumed_by_turn_id IS NULL`;
          const policy = candidateReviewInstructions(change);
          await transaction`INSERT INTO factory.change_agent_turn_intent(
            turn_id,change_id,session_id,prompt_id,prompt_text,bootstrap,session_title,skill_loading
          ) VALUES(${record.id},${changeID},${`ses_factory_review_${reviewID.replaceAll("-", "")}`},
            ${`msg_factory_${record.id.replaceAll("-", "")}`},${`${policy}\n\n${buildBrowserInstructions(record.id)}`},
            true,${`Review: ${change.title}`.slice(0, 200)},'eager')`;
          await transaction`UPDATE factory.candidate_review SET turn_id=${record.id}
            WHERE id=${reviewID} AND turn_id IS NULL AND state='pending'`;
        },
      );
    });
}
