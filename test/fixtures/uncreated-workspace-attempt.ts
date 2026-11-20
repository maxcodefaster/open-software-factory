import { z } from "zod";
import { freezeRuntimeEnvironment } from "../../apps/factory/src/environments/runtime";
import type { createDatabase } from "../../packages/db/src/client";
import { runtimeIdentity } from "../../packages/runtime-domain/src/identity";

const admission = z.strictObject({
  workspaceID: z.uuid(),
  generation: z.number().int().positive(),
  createdBy: z.uuid(),
  revision: z
    .string()
    .regex(/^[a-f0-9]{40}$/)
    .optional(),
  parentHash: z.string().regex(/^[a-f0-9]{64}$/),
  childHash: z.string().regex(/^[a-f0-9]{64}$/),
  connectorURL: z.url().refine((value) => {
    const url = new URL(value);
    return (
      url.protocol === "wss:" &&
      url.pathname === "/internal/runtime-connect" &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash
    );
  }),
  state: z.enum(["create-intended", "starting", "ready", "stopped", "failed"]).default("ready"),
  recordEnvironment: z.boolean().default(true),
});

// Controlled controller/transport data only, never native runtime acceptance.
// No native Create or Actor UID is recorded. Keep the real baseline binding
// and environment constraints instead of weakening them or using legacy rows.
export async function recordUncreatedWorkspaceAttempt(
  database: ReturnType<typeof createDatabase>,
  value: z.input<typeof admission>,
) {
  const input = admission.parse(value);
  const attemptID = runtimeIdentity(input.workspaceID, input.generation).attemptID;
  await database.client.begin(async (sql) => {
    const [scope] = await sql<
      { database: string; projectID: string; changeID: string | null; revision: string }[]
    >`SELECT current_database() AS database,project_id AS "projectID",
      change_id AS "changeID",source_revision AS revision
      FROM factory.development_workspace WHERE id=${input.workspaceID}`;
    if (!scope || !/^owned_[a-f0-9]{32}$/.test(scope.database))
      throw Error("Uncreated native fixture admission requires an owned database and Workspace");
    await sql`INSERT INTO factory.runtime_attempt(
      id,project_id,change_id,workspace_id,generation,revision,state,
      parent_connector_token_hash,child_connector_token_hash,create_intended_at,created_by)
      VALUES(${attemptID},${scope.projectID},${scope.changeID},${input.workspaceID},
        ${input.generation},${input.revision ?? scope.revision},'create-intended',
        ${input.parentHash},${input.childHash},now(),${input.createdBy})`;
    await sql`INSERT INTO factory.substrate_binding(runtime_attempt_id,atespace,actor_name,intent)
      VALUES(${attemptID},${`fa-${attemptID.replaceAll("-", "")}`},
        ${`runtime-${attemptID.replaceAll("-", "")}`},
        ${JSON.stringify({ connectorURL: input.connectorURL, egressHosts: [] })}::jsonb)`;
    if (input.recordEnvironment) await freezeRuntimeEnvironment(sql, attemptID);
    if (input.state !== "create-intended")
      await sql`UPDATE factory.runtime_attempt SET state=${input.state} WHERE id=${attemptID}`;
  });
  return attemptID;
}
