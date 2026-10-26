import type { TransactionSql } from "postgres";
import type { createDatabase } from "../../../../packages/db/src/client";
import {
  configuredFactoryboxRuntimeProfile,
  type FactoryboxRuntimeProfile,
  factoryboxRuntimeProfile,
} from "../../../../packages/runtime-kubernetes/src/factorybox-runtime";
import { freezeRuntimeEnvironment } from "../environments/runtime";

export type RuntimeArtifactRole = "development" | "build" | "verification" | "staging";
export interface RuntimeArtifactIntent {
  readonly workerID: string;
  readonly reserveSlotID: string | null;
  readonly role: RuntimeArtifactRole;
  readonly runtimeHostImage: string;
  readonly browserToolsImage: string | null;
  readonly environmentVersion: number;
  readonly factoryboxProfile: FactoryboxRuntimeProfile;
}
export interface RuntimeArtifactConfiguration {
  readonly factoryboxProfile?: FactoryboxRuntimeProfile;
  readonly hostImages: Readonly<Record<RuntimeArtifactRole, string | undefined>>;
  readonly browserToolsImage: string | undefined;
}

type SQL = ReturnType<typeof createDatabase>["client"] | TransactionSql;
function pinnedImage(value: string | undefined, label: string): string {
  if (!value || !/^[a-zA-Z0-9.:/-]+@sha256:[a-f0-9]{64}$/.test(value))
    throw new Error(`${label} must be configured with an exact image digest`);
  return value;
}

export async function freezeRuntimeArtifacts(
  sql: SQL,
  attemptID: string,
  configuration: RuntimeArtifactConfiguration,
): Promise<RuntimeArtifactIntent> {
  const environment = await freezeRuntimeEnvironment(sql, attemptID);
  const read = async () =>
    (
      await sql<RuntimeArtifactIntent[]>`
        SELECT artifact.role,artifact.runtime_host_image AS "runtimeHostImage",
          artifact.browser_tools_image AS "browserToolsImage",${environment.version}::float8 AS "environmentVersion",
          artifact.factorybox_profile AS "factoryboxProfile",attempt.factorybox_worker_id AS "workerID",
          slot.id AS "reserveSlotID"
        FROM factory.runtime_artifact_intent artifact
        JOIN factory.runtime_attempt attempt ON attempt.id=artifact.runtime_attempt_id
        LEFT JOIN factory.execution_slot slot ON slot.assigned_attempt_id=attempt.id
        WHERE artifact.runtime_attempt_id=${attemptID}`
    )[0];
  const retained = await read();
  if (retained) {
    factoryboxRuntimeProfile.parse(retained.factoryboxProfile);
    return retained;
  }
  const [attempt] = await sql<Array<{ role: RuntimeArtifactRole }>>`
    SELECT CASE WHEN isolated_kind IN ('verification','publication') THEN 'verification'
      WHEN isolated_kind='staging' THEN 'staging'
      WHEN change_id IS NOT NULL AND workspace_id IS NOT NULL THEN 'build'
      ELSE 'development' END AS role
    FROM factory.runtime_attempt WHERE id=${attemptID} AND state='create-intended'
      AND stop_intended_at IS NULL`;
  if (!attempt) throw new Error("Runtime artifact selection requires active create intent");
  const runtimeHostImage = pinnedImage(
    configuration.hostImages[attempt.role],
    `${attempt.role} runtime image`,
  );
  const browserToolsImage =
    attempt.role === "build"
      ? pinnedImage(configuration.browserToolsImage, "Build browser image")
      : null;
  const [slot] = await sql<
    Array<{ profile: unknown }>
  >`SELECT factorybox_profile AS profile FROM factory.execution_slot WHERE assigned_attempt_id=${attemptID}`;
  const profile = factoryboxRuntimeProfile.parse(
    slot?.profile ?? configuration.factoryboxProfile ?? configuredFactoryboxRuntimeProfile(),
  );
  await sql`
    INSERT INTO factory.runtime_artifact_intent(runtime_attempt_id,role,runtime_host_image,browser_tools_image,factorybox_profile)
    VALUES(${attemptID},${attempt.role},${runtimeHostImage},${browserToolsImage},${JSON.stringify(profile)}::text::jsonb)
    ON CONFLICT(runtime_attempt_id) DO NOTHING`;
  const intent = await read();
  if (!intent) throw new Error("Runtime artifact intent was not recorded");
  return intent;
}
