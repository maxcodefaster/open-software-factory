import { z } from "zod";
import type { createDatabase } from "../../../../packages/db/src/client";
import { createAccessController } from "../access/controller";
import { CommandError } from "../command-error";

export const researchSource = z.enum(["knowledge", "ticket", "epic"]);
export const researchHit = z.object({
  source: researchSource,
  id: z.uuid(),
  label: z.string(),
  excerpt: z.string(),
});
export const researchDocument = researchHit.extend({
  body: z.string(),
  version: z.number().int(),
  truncated: z.boolean(),
  nextOffset: z.number().int().nullable(),
  relationships: z
    .array(
      z.object({
        source: researchSource,
        id: z.uuid(),
        label: z.string(),
        relationship: z.enum([
          "parent-epic",
          "member-ticket",
          "prerequisite",
          "dependent",
          "parent-page",
          "child-page",
        ]),
      }),
    )
    .max(40),
});
type Database = ReturnType<typeof createDatabase>;
type Source = z.infer<typeof researchSource>;

export function researchQuery(value: string) {
  return value.normalize("NFKC").trim().slice(0, 500);
}

export async function searchResearch(
  database: Database,
  projectID: string,
  userID: string,
  query: string,
  source?: Source,
) {
  await createAccessController(database).requireProject(userID, projectID);
  const text = researchQuery(query);
  if (!/[\p{L}\p{N}]/u.test(text)) return [];
  // Each branch keeps its indexed predicate. No generic search engine or code copy.
  const rows = await database.client<Array<z.infer<typeof researchHit>>>`
    WITH input AS (SELECT websearch_to_tsquery('simple',${text}) AS q,lower(${text}) AS text), candidates AS (
      SELECT 'ticket'::text AS source,t.id,t.title AS label,t.description AS body,t.updated_at,
        factory.research_vector(t.title,t.description) AS vector
      FROM factory.ticket t,input WHERE t.project_id=${projectID} AND t.state!='cancelled' AND t.trashed_at IS NULL AND t.converted_to_epic_id IS NULL
        AND (${source ?? null}::text IS NULL OR ${source ?? null}='ticket')
        AND (factory.research_vector(t.title,t.description) @@ input.q OR lower(t.title) % input.text OR
          lower(t.title)=input.text OR 'tck-'||left(replace(t.id::text,'-',''),6)=input.text OR t.id::text=input.text)
      UNION ALL
      SELECT 'ticket',t.id,t.title,d.canonical_content,t.updated_at,factory.research_vector(d.title,d.canonical_content)
      FROM factory.ticket_document_revision d JOIN factory.ticket t ON t.id=d.ticket_id,input
      WHERE t.project_id=${projectID} AND t.state!='cancelled' AND t.trashed_at IS NULL AND t.converted_to_epic_id IS NULL
        AND (${source ?? null}::text IS NULL OR ${source ?? null}='ticket')
        AND factory.research_vector(d.title,d.canonical_content) @@ input.q
        AND NOT EXISTS(SELECT 1 FROM factory.ticket_document_revision newer WHERE newer.ticket_id=t.id AND newer.ordinal>d.ordinal)
      UNION ALL
      SELECT 'ticket',t.id,t.title,r.canonical_content,t.updated_at,factory.research_vector(t.title,r.canonical_content)
      FROM factory.requirement_revision r JOIN factory.ticket t ON t.id=r.ticket_id,input
      WHERE t.project_id=${projectID} AND t.state!='cancelled' AND t.trashed_at IS NULL AND t.converted_to_epic_id IS NULL
        AND (${source ?? null}::text IS NULL OR ${source ?? null}='ticket')
        AND factory.research_vector('',r.canonical_content) @@ input.q
        AND NOT EXISTS(SELECT 1 FROM factory.ticket_document_revision document WHERE document.ticket_id=t.id)
        AND NOT EXISTS(SELECT 1 FROM factory.requirement_revision newer WHERE newer.ticket_id=t.id AND newer.ordinal>r.ordinal)
      UNION ALL
      SELECT 'epic',id,title,description,updated_at,factory.research_vector(title,description)
      FROM factory.epic,input WHERE project_id=${projectID} AND (${source ?? null}::text IS NULL OR ${source ?? null}='epic')
        AND (factory.research_vector(title,description) @@ input.q OR lower(title) % input.text OR lower(title)=input.text OR id::text=input.text)
      UNION ALL
      SELECT 'knowledge',id,title,current_body,updated_at,factory.research_vector(title,current_body)
      FROM factory.knowledge_page,input WHERE project_id=${projectID} AND state='active'
        AND (${source ?? null}::text IS NULL OR ${source ?? null}='knowledge')
        AND (factory.research_vector(title,current_body) @@ input.q OR lower(title) % input.text OR lower(title)=input.text OR id::text=input.text)
    ), ranked AS (
      SELECT DISTINCT ON(source,id) source,id,label,body,updated_at,
        (CASE WHEN lower(label)=input.text OR id::text=input.text OR 'tck-'||left(replace(id::text,'-',''),6)=input.text THEN 10 ELSE 0 END
        + ts_rank_cd(vector,input.q) + similarity(lower(label),input.text)) AS rank
      FROM candidates,input
      WHERE EXISTS(SELECT 1 FROM factory.administrator WHERE user_id=${userID}) OR
        EXISTS(SELECT 1 FROM factory.project_membership WHERE project_id=${projectID} AND user_id=${userID})
      ORDER BY source,id,rank DESC
    ) SELECT source,id,label,replace(replace(ts_headline('simple',body,(SELECT q FROM input),
      'MaxWords=60,MinWords=10,MaxFragments=1'),'<b>',''),'</b>','') AS excerpt
      FROM ranked ORDER BY rank DESC,updated_at DESC,id LIMIT 8`;
  return rows.map((row) => researchHit.parse({ ...row, excerpt: row.excerpt.slice(0, 1200) }));
}

export async function readResearch(
  database: Database,
  projectID: string,
  userID: string,
  source: Source,
  id: string,
  offset = 0,
  expectedVersion?: number,
) {
  z.number().int().min(0).max(2_000_000).parse(offset);
  return database.client.begin(async (sql) => {
    const { projectAuthorityIn } = await import("../access/controller");
    await projectAuthorityIn(sql, userID, projectID);
    const rows =
      source === "ticket"
        ? await sql`
      SELECT t.id,t.title AS label,t.version::integer AS version,t.description || E'\n' || coalesce(d.canonical_content,r.canonical_content,'') AS body
      FROM factory.ticket t LEFT JOIN LATERAL (SELECT canonical_content FROM factory.ticket_document_revision
        WHERE ticket_id=t.id ORDER BY ordinal DESC LIMIT 1) d ON true
      LEFT JOIN LATERAL (SELECT canonical_content FROM factory.requirement_revision WHERE ticket_id=t.id ORDER BY ordinal DESC LIMIT 1) r ON true
      WHERE t.id=${id} AND t.project_id=${projectID} AND t.state!='cancelled' AND t.trashed_at IS NULL AND t.converted_to_epic_id IS NULL`
        : source === "epic"
          ? await sql`SELECT id,title AS label,version::integer AS version,description AS body
        FROM factory.epic WHERE id=${id} AND project_id=${projectID}`
          : await sql`SELECT id,title AS label,version::integer AS version,current_body AS body
        FROM factory.knowledge_page WHERE id=${id} AND project_id=${projectID} AND state='active'`;
    const row = rows[0];
    if (!row) throw new CommandError("not-found", "Project source is unavailable");
    if (expectedVersion !== undefined && Number(row["version"]) !== expectedVersion)
      throw new CommandError("conflict", "Project source changed. Read its current first page");
    const relations =
      source === "ticket"
        ? await sql`
      SELECT 'epic'::text AS source,e.id,e.title AS label,'parent-epic'::text AS relationship FROM factory.epic e JOIN factory.ticket t ON t.epic_id=e.id WHERE t.id=${id} AND t.project_id=${projectID}
      UNION ALL SELECT 'ticket',t.id,t.title,CASE WHEN edge.ticket_id=${id} THEN 'prerequisite' ELSE 'dependent' END FROM factory.ticket_dependency edge JOIN factory.ticket t
        ON t.id=CASE WHEN edge.ticket_id=${id} THEN edge.prerequisite_id ELSE edge.ticket_id END
        WHERE edge.project_id=${projectID} AND (edge.ticket_id=${id} OR edge.prerequisite_id=${id}) AND t.trashed_at IS NULL AND t.state!='cancelled' AND t.converted_to_epic_id IS NULL LIMIT 40`
        : source === "epic"
          ? await sql`SELECT 'ticket'::text AS source,id,title AS label,'member-ticket'::text AS relationship FROM factory.ticket
        WHERE project_id=${projectID} AND epic_id=${id} AND trashed_at IS NULL AND state!='cancelled' AND converted_to_epic_id IS NULL ORDER BY created_at LIMIT 40`
          : await sql`SELECT 'knowledge'::text AS source,id,title AS label,CASE WHEN parent_id=${id} THEN 'child-page' ELSE 'parent-page' END AS relationship FROM factory.knowledge_page
        WHERE project_id=${projectID} AND state='active' AND (parent_id=${id} OR id=(SELECT parent_id FROM factory.knowledge_page WHERE id=${id} AND project_id=${projectID})) LIMIT 40`;
    const body = String(row["body"]);
    return researchDocument.parse({
      ...row,
      source,
      excerpt: body.slice(0, 1200),
      body: body.slice(offset, offset + 16000),
      truncated: body.length > offset + 16000,
      nextOffset: body.length > offset + 16000 ? offset + 16000 : null,
      relationships: relations,
    });
  });
}
