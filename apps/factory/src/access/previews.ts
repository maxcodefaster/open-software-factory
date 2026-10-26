import type { createDatabase } from "../../../../packages/db/src/client";
import { createAccessController } from "./controller";
import { z } from "zod";

const declaredApps = z.array(z.string().regex(/^app(?:-[a-z][a-z0-9-]{0,26})?$/)).max(64);

export function createProjectAppPreviews(
  database: ReturnType<typeof createDatabase>,
  channels: (attemptID: string) => readonly string[],
) {
  const access = createAccessController(database);
  return async (projectID: string, userID: string) => {
    await access.requireProject(userID, projectID);
    const attempts = await database.client<
      { id: string; owner: string | null; title: string | null; apps: unknown }[]
    >`
      SELECT attempt.id,person.name AS owner,ticket.title,attempt.declared_apps AS apps
      FROM factory.runtime_attempt attempt
      JOIN factory.development_workspace workspace ON workspace.id=attempt.workspace_id
      LEFT JOIN auth."user" person ON person.id=workspace.owner_user_id
      LEFT JOIN factory.change change ON change.id=workspace.change_id
      LEFT JOIN factory.ticket ticket ON ticket.id=change.ticket_id
      WHERE attempt.project_id=${projectID} AND attempt.state IN ('ready','pausing','paused','resuming','starting')
        AND (workspace.kind='personal' OR change.runtime_attempt_id=attempt.id AND ticket.trashed_at IS NULL)
      ORDER BY attempt.created_at DESC LIMIT 100`;
    return attempts.flatMap((attempt) => {
      const retained = declaredApps.parse(attempt.apps);
      return (retained.length ? retained : channels(attempt.id)).map((channel) => ({
        attemptID: attempt.id,
        projectID,
        channel,
        label: `${attempt.title ?? attempt.owner ?? "Development"} · ${channel === "app" ? "App" : channel.slice(4)}`,
      }));
    });
  };
}
