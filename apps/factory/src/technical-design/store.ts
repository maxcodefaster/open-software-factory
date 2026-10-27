import { createHash } from "node:crypto";
import type { AgentTurnTransaction } from "../agent/turn-store";
import { projectDevelopmentAuthorityIn } from "../access/controller";
import { CommandError } from "../command-error";
import {
  type TechnicalDesignContent,
  type TechnicalPlanningBase,
  technicalDesignContentInput,
  validateTechnicalDesignCoverage,
} from "../../../../packages/requirement-domain/src/technical-design";
import { requirementContentInput } from "../../../../packages/requirement-domain/src/content";
import type { z } from "zod";
import type { sourceCitationInput } from "../../../../packages/conversation-domain/src/conversation";
import { diagramRendererVersion } from "./diagrams";

export async function technicalPlanningOutstandingIn(
  sql: AgentTurnTransaction,
  ticketID: string,
  requirementRevisionID: string | null,
) {
  const [result] = await sql<{ outstanding: boolean }[]>`
    SELECT EXISTS (
      SELECT 1 FROM (
        SELECT turn.id FROM factory.agent_turn turn
        WHERE turn.ticket_id=${ticketID} AND turn.input->>'intent'='technical-planning'
        ORDER BY turn.created_at DESC,turn.id DESC LIMIT 1
      ) request WHERE NOT EXISTS (
        SELECT 1 FROM factory.technical_design_revision design
        WHERE design.ticket_id=${ticketID} AND design.requirement_revision_id=${requirementRevisionID}
          AND design.planning_turn_id=request.id
      )
    ) AS outstanding`;
  return result?.outstanding ?? false;
}

export async function saveTechnicalDesignIn(
  sql: AgentTurnTransaction,
  input: {
    id: string;
    ticketID: string;
    userID: string;
    base: TechnicalPlanningBase;
    content: TechnicalDesignContent;
    citations: z.infer<typeof sourceCitationInput>[];
    renders: string[];
    turnID?: string;
  },
) {
  await sql`SELECT pg_advisory_xact_lock(hashtext(${`ticket:${input.ticketID}`}))`;
  const [ticket] = await sql<{ projectID: string; admitted: boolean; trashed: boolean }[]>`
    SELECT project_id AS "projectID", (trashed_at IS NOT NULL OR converted_to_epic_id IS NOT NULL OR state IN ('cancelled','done')) AS trashed,
      EXISTS(SELECT 1 FROM factory.requirement_approval WHERE ticket_id=ticket.id) AS admitted
    FROM factory.ticket WHERE id=${input.ticketID} FOR UPDATE`;
  if (!ticket) throw new CommandError("not-found", "Ticket not found.");
  await projectDevelopmentAuthorityIn(sql, input.userID, ticket.projectID);
  const content = technicalDesignContentInput.parse(input.content);
  const canonical = JSON.stringify(content);
  if (Buffer.byteLength(canonical) > 96 * 1024)
    throw new CommandError(
      "conflict",
      "Shorten the technical design before saving. Your draft is retained.",
    );
  const digest = createHash("sha256").update(canonical).digest("hex");
  const [replay] = await sql<
    {
      contentDigest: string;
      userID: string;
      ticketID: string;
      previousID: string | null;
      productID: string;
      sourceCommit: string;
      requestID: string | null;
    }[]
  >`
    SELECT content_digest AS "contentDigest",created_by AS "userID",ticket_id AS "ticketID",
      previous_revision_id AS "previousID",requirement_revision_id AS "productID",source_commit AS "sourceCommit"
      ,planning_turn_id AS "requestID"
    FROM factory.technical_design_revision WHERE id=${input.id}`;
  if (replay) {
    if (
      replay.contentDigest !== digest ||
      replay.userID !== input.userID ||
      replay.ticketID !== input.ticketID ||
      replay.previousID !== input.base.previousDesignId ||
      replay.productID !== input.base.requirementRevisionId ||
      replay.sourceCommit !== input.base.sourceCommit ||
      replay.requestID !== (input.base.requestId ?? null)
    )
      throw new CommandError("conflict", "This technical design command has different input.");
    return;
  }
  const [revision] = await sql<{ id: string; canonical: string }[]>`
    SELECT id,canonical_content AS canonical FROM factory.requirement_revision
    WHERE ticket_id=${input.ticketID} ORDER BY ordinal DESC LIMIT 1`;
  const [document] = await sql<{ id: string; revisionID: string | null }[]>`
    SELECT id,requirement_revision_id AS "revisionID" FROM factory.ticket_document_revision
    WHERE ticket_id=${input.ticketID} ORDER BY ordinal DESC LIMIT 1`;
  const [previous] = await sql<{ id: string; ordinal: number }[]>`
    SELECT id,ordinal FROM factory.technical_design_revision WHERE ticket_id=${input.ticketID}
    ORDER BY ordinal DESC LIMIT 1`;
  if (
    ticket.admitted ||
    ticket.trashed ||
    revision?.id !== input.base.requirementRevisionId ||
    (document?.id ?? null) !== input.base.documentId ||
    (document && document.revisionID !== revision?.id) ||
    (previous?.id ?? null) !== input.base.previousDesignId
  )
    throw new CommandError(
      "conflict",
      "The Ticket changed. Plan against the current product specification.",
    );
  try {
    validateTechnicalDesignCoverage(
      content,
      requirementContentInput.parse(JSON.parse(revision.canonical)).acceptanceCriteria,
    );
  } catch {
    throw new CommandError(
      "conflict",
      "Map every product acceptance criterion to a concrete validation check.",
    );
  }
  if (input.renders.length !== content.diagrams.length)
    throw new CommandError("conflict", "Every architecture diagram needs a validated render.");
  await sql`INSERT INTO factory.technical_design_revision(
    id,ticket_id,requirement_revision_id,previous_revision_id,ordinal,source_commit,canonical_content,content_digest,
    citations,diagram_renders,renderer_version,created_by,author_kind,turn_id,planning_turn_id)
    VALUES(${input.id},${input.ticketID},${input.base.requirementRevisionId},${input.base.previousDesignId},${(previous?.ordinal ?? 0) + 1},
      ${input.base.sourceCommit},${canonical},${digest},${JSON.stringify(input.citations)}::jsonb,
      ${JSON.stringify(input.renders)}::jsonb,${diagramRendererVersion},${input.userID},
      ${input.turnID ? "ai" : "human"},${input.turnID ?? null},${input.base.requestId ?? null})`;
}
