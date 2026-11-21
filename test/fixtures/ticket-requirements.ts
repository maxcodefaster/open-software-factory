import { createAccessController } from "../../apps/factory/src/access/controller";
import { type TicketDetail } from "../../apps/factory/src/change/contracts";
import { createChangeController } from "../../apps/factory/src/change/controller";
import { createTicketService } from "../../apps/factory/src/change/service";
import { serverCall } from "../../apps/factory/src/server-functions/result";
import type { createDatabase } from "../../packages/db/src/client";
import type { createForgejoClient } from "../../packages/forge/src/forge";
import type { RequirementContent } from "../../packages/requirement-domain/src/content";
import type { TicketDocumentInput } from "../../packages/requirement-domain/src/document";
import { callFactoryFunction } from "./server-functions";

export function ticketRequirementsInput(
  detail: TicketDetail,
  requirement: RequirementContent,
  commandId: string,
): TicketDocumentInput {
  const input: TicketDocumentInput = {
    commandId,
    expectedVersion: detail.ticket.version,
    expectedDocumentId: detail.documentRevisions[0]?.id ?? null,
    requirementRevisionId:
      detail.revisions.find((revision) => revision.approvalId)?.id ??
      detail.revisions[0]?.id ??
      null,
    title: detail.ticket.title,
    description: detail.ticket.description,
    requirement: structuredClone(requirement),
  };
  if (!input.requirement) throw new Error("Fixture requirements are missing");
  Object.freeze(input.requirement.acceptanceCriteria);
  Object.freeze(input.requirement.nonGoals);
  Object.freeze(input.requirement);
  return Object.freeze(input);
}

export async function saveTicketRequirements(
  base: string,
  ticketID: string,
  requirement: RequirementContent,
  headers: HeadersInit,
) {
  const detail = await serverCall(
    callFactoryFunction(base, "getTicketDetail", [ticketID], headers),
  );
  const saved = await serverCall(
    callFactoryFunction(
      base,
      "saveTicketDocument",
      [ticketID, ticketRequirementsInput(detail, requirement, crypto.randomUUID())],
      headers,
    ),
  );
  if (!saved.requirementRevisionId) throw new Error("Saved fixture requirements are incomplete");
  return { id: saved.requirementRevisionId };
}

// UI proofs run actual Requirements admission against their owned database.
// They replace the Forge read only and cannot commission runtime/model work.
export async function queuedTicketImplementation(
  database: ReturnType<typeof createDatabase>,
  userID: string,
  projectID: string,
) {
  const origin = "https://owned-queued-requirements.invalid";
  const [owned] = await database.client`
    UPDATE factory.project SET repository_url=${`${origin}/owned/requirements.git`}
    WHERE id=${projectID} AND created_by=${userID}
      AND NOT EXISTS(SELECT 1 FROM factory.change WHERE project_id=${projectID})
      AND NOT EXISTS(SELECT 1 FROM factory.runtime_attempt WHERE project_id=${projectID})
    RETURNING id`;
  if (!owned) throw new Error("Queued Requirements fixture does not own this unused Project");
  const configuration = {
    FACTORY_FORGEJO_API_URL: `${origin}/api/v1/`,
    FACTORY_FORGEJO_TOKEN: "owned-unused-token",
    FACTORY_FORGEJO_OWNER: "owned",
  };
  const previous = Object.fromEntries(
    Object.keys(configuration).map((key) => [key, process.env[key]]),
  );
  let changes: ReturnType<typeof createChangeController>;
  const unused = async () => {
    throw new Error("Queued Requirements fixture cannot start execution");
  };
  try {
    Object.assign(process.env, configuration);
    changes = createChangeController(database, { stop: unused }, unused, unused, {
      getDefaultBranch: async () => ({ name: "main", headSha: "a".repeat(40) }),
      getBranch: unused,
      ensureBranch: unused,
    } as unknown as ReturnType<typeof createForgejoClient>);
  } finally {
    for (const [key, value] of Object.entries(previous))
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
  }
  const tickets = createTicketService({
    database,
    access: createAccessController(database),
    documents: { save: unused, followUp: unused },
    trash: { trash: unused, restore: unused },
    changes,
    agent: { admitStartIn: unused },
  });
  return {
    implement: (
      _fixtureActor: string,
      ticketID: string,
      input: Parameters<typeof tickets.implement>[2],
    ) => tickets.implement(userID, ticketID, input),
  };
}
