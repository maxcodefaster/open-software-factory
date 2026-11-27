import { and, eq, inArray, isNull, ne, sql } from "drizzle-orm";
import { sourceCitationInput } from "#conversation-domain/conversation";
import { epic, knowledgePage, ticket } from "#db/schema";
import { readableAttachmentIn } from "../attachments/api";
import type { Citation } from "../conversations/api";
import type { ProjectAgentDatabase, ProjectKnowledgeTools } from "./turn-types";

function citationKey(citation: Citation) {
  return citation.source === "code"
    ? `code:${citation.id}:${citation.commitSha}:${citation.path}`
    : `${citation.source}:${citation.id}`;
}

export async function validateCitations(
  database: ProjectAgentDatabase,
  knowledge: ProjectKnowledgeTools | undefined,
  input: {
    projectID: string;
    citations: Citation[];
    userID: string;
    readCodeSources: Set<string>;
    projectSources: Set<string>;
  },
) {
  const { projectID, citations, userID, readCodeSources, projectSources } = input;
  const parsed = citations.flatMap((value, index) => {
    const result = sourceCitationInput.safeParse(value);
    return result.success
      ? [{ ...result.data, reference: result.data.reference ?? index + 1 }]
      : [];
  });
  if (!parsed.length) return [];

  const idsFor = (source: "knowledge" | "ticket" | "epic") =>
    parsed.filter((value) => value.source === source).map((value) => value.id);

  const rows = await database.db
    .select({ source: sql<string>`'knowledge'::text`, id: knowledgePage.id })
    .from(knowledgePage)
    .where(
      and(
        eq(knowledgePage.projectId, projectID),
        eq(knowledgePage.state, "active"),
        inArray(knowledgePage.id, idsFor("knowledge")),
      ),
    )
    .unionAll(
      database.db
        .select({ source: sql<string>`'ticket'::text`, id: ticket.id })
        .from(ticket)
        .where(
          and(
            eq(ticket.projectId, projectID),
            isNull(ticket.trashedAt),
            ne(ticket.state, "cancelled"),
            isNull(ticket.convertedToEpicId),
            inArray(ticket.id, idsFor("ticket")),
          ),
        ),
    )
    .unionAll(
      database.db
        .select({ source: sql<string>`'epic'::text`, id: epic.id })
        .from(epic)
        .where(and(eq(epic.projectId, projectID), inArray(epic.id, idsFor("epic")))),
    );

  const allowed = new Set(
    rows.map((row) => `${row.source}:${row.id}`).filter((key) => projectSources.has(key)),
  );

  for (const citation of parsed) {
    if (citation.source === "attachment") {
      if (!projectSources.has(`attachment:${citation.id}`)) continue;
      const asset = await database.client.begin((tx) =>
        readableAttachmentIn(tx, userID, citation.id),
      );
      if (asset.projectId === projectID && asset.state === "ready")
        allowed.add(`attachment:${asset.id}`);
      continue;
    }
    if (citation.source === "code" && citation.id === projectID) {
      if (!knowledge || !readCodeSources.has(`${citation.commitSha}:${citation.path}`)) continue;
      await knowledge.code(
        projectID,
        { commitSha: citation.commitSha, path: citation.path, startLine: 1, lineCount: 1 },
        userID,
      );
      allowed.add(citationKey(citation));
    }
  }

  return parsed.filter((value) => allowed.has(citationKey(value)));
}
