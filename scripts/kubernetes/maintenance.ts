import { beginInstallationMaintenance } from "../../apps/factory/src/installation/maintenance";
import { createDatabase } from "../../packages/db/src/client";

const database = createDatabase(1);
try {
  const [schema] = await database.client<{ ready: boolean; baseline: boolean }[]>`
    SELECT to_regclass('factory.installation_maintenance') IS NOT NULL AS ready,
      to_regclass('factory.agent_turn') IS NOT NULL AS baseline`;
  if (!schema?.ready) {
    // Helm also runs pre-upgrade hooks when explicitly retrying a failed first
    // install. No application can start before the maintenance migration.
    if (schema?.baseline) {
      const [history] = await database.client<{ exists: boolean }[]>`
        SELECT EXISTS(SELECT 1 FROM factory.agent_turn) AS exists`;
      if (history?.exists)
        throw new Error(
          "The existing installation has work but no maintenance gate; upgrade refused",
        );
    }
    console.log(
      "First installation has not admitted application work; initialization may continue",
    );
  } else {
    await beginInstallationMaintenance(database);
    console.log("Saved work is settled; the installation is fenced for its maintenance upgrade");
  }
} finally {
  await database.client.end();
}
