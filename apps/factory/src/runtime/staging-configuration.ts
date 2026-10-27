import { isDeepStrictEqual } from "node:util";
import type { TransactionSql } from "postgres";
import { z } from "zod";
import type { createDatabase } from "../../../../packages/db/src/client";

type SQL = ReturnType<typeof createDatabase>["client"] | TransactionSql;
export const stagingConfiguration = z.strictObject({
  devcontainerPath: z.string().min(1),
  channels: z
    .array(
      z.strictObject({
        name: z.string(),
        kind: z.literal("app"),
        target: z.string(),
        healthPath: z.string(),
      }),
    )
    .min(1)
    .max(4),
  processes: z
    .array(
      z.strictObject({
        name: z.string(),
        label: z.string().optional(),
        command: z.array(z.string()).min(1),
      }),
    )
    .min(1)
    .max(4),
});

// Keep only the public declaration actually sent to this Staging Attempt.
// In particular no repository capability URL, Connector token or Runtime
// Environment value belongs in the reusable template definition.
export async function freezeStagingConfiguration(
  sql: SQL,
  attemptID: string,
  resources: readonly unknown[],
) {
  const [attempt] = await sql<Array<{ projectID: string; revision: string; staging: boolean }>>`
    SELECT project_id AS "projectID",revision,isolated_kind='staging' AS staging
    FROM factory.runtime_attempt WHERE id=${attemptID}`;
  if (!attempt?.staging) return;
  const secret = resources
    .map((value) =>
      z
        .object({
          kind: z.string(),
          stringData: z.record(z.string(), z.string()).optional(),
        })
        .parse(value),
    )
    .find((value) => value.kind === "Secret" && value.stringData?.["assignment.json"]);
  const assignment = z
    .object({
      runtimeAttemptId: z.literal(attemptID),
      repositoryIdentity: z.literal(attempt.projectID),
      revision: z.literal(attempt.revision),
      devcontainerPath: z.string(),
      channels: z.array(z.unknown()),
      processes: z.array(z.unknown()),
    })
    .parse(JSON.parse(secret?.stringData?.["assignment.json"] ?? "null"));
  const declaration = stagingConfiguration.parse({
    devcontainerPath: assignment.devcontainerPath,
    channels: assignment.channels,
    processes: assignment.processes,
  });
  await sql`INSERT INTO factory.staging_configuration(runtime_attempt_id,declaration)
    VALUES(${attemptID},${JSON.stringify(declaration)}::text::jsonb) ON CONFLICT DO NOTHING`;
  const [saved] = await sql<Array<{ declaration: unknown }>>`
    SELECT declaration FROM factory.staging_configuration WHERE runtime_attempt_id=${attemptID}`;
  if (!isDeepStrictEqual(stagingConfiguration.parse(saved?.declaration), declaration))
    throw new Error("Staging configuration differs from its original execution declaration");
}
