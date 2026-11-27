import { factorySigningSecret } from "#auth/signing-secret";
import { createDatabase } from "#db/client";
import { waitForDatabase } from "#db/wait";
import { createSubstrateControl, type SubstrateCall } from "#runtime-kubernetes/substrate-control";
import { beginInstallationMaintenance } from "../../apps/factory/src/installation/maintenance";
import { RuntimeHub } from "../../apps/factory/src/runtime/hub";
import { createSubstrateWorkspaces } from "../../apps/factory/src/runtime/substrate-workspaces";
import { createSubstrateSources } from "../../apps/factory/src/workspace/substrate-source";
import { requireNativeInstallation } from "../factory/native-installation";

const database = createDatabase(1);
try {
  await waitForDatabase(database.client);
  const [schema] = await database.client<{ ready: boolean; baseline: boolean }[]>`
    SELECT to_regclass('factory.operation') IS NOT NULL
      AND EXISTS(SELECT 1 FROM factory.operation WHERE kind='installation.maintenance' AND idempotency_key='installation.maintenance:singleton') AS ready,
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
    await beginInstallationMaintenance(database, async (sql, target) => {
      const namespace = process.env["FACTORY_NAMESPACE"];
      const serviceAccount = process.env["FACTORY_SERVICE_ACCOUNT"];
      if (!namespace || !serviceAccount)
        throw new Error("Retained Stop maintenance requires its original native Editor identity");
      const configuration = requireNativeInstallation(process.env, {
        editorPrincipal: `user:system:serviceaccount:${namespace}:${serviceAccount}`,
      });
      const native = createSubstrateControl(configuration.connection);
      const readNative: SubstrateCall = (method, request) => {
        if (!["GetAtespace", "GetActorTemplate", "GetActor"].includes(method))
          throw new Error("Maintenance cannot dispatch native mutations");
        return native(method, request);
      };
      const hub = new RuntimeHub(async () => {});
      // Reconstruct the same Source-enabled immutable binding, not another
      // execution profile. Construction starts no Source service or storage IO.
      const sources = createSubstrateSources(database, hub);
      try {
        const owner = createSubstrateWorkspaces(
          database,
          hub,
          factorySigningSecret(),
          { ...configuration, projectID: target.projectID },
          readNative,
          async () => {
            throw new Error("Maintenance has no native Owner authority");
          },
          undefined,
          sources,
        );
        const execution = await owner.forAttempt(target.attemptID, sql);
        return (await execution?.stoppedWorkRetainedIn(sql, target.stopID)) ?? false;
      } finally {
        await sources.close();
      }
    });
    console.log(
      "The installation is fenced for upgrade. Any retained Coding Stop remains unconfirmed and is not replayed.",
    );
  }
} finally {
  await database.client.end();
}
