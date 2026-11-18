import { beginInstallationMaintenance } from "../../apps/factory/src/installation/maintenance";
import { RuntimeHub } from "../../apps/factory/src/runtime/hub";
import { createSubstrateWorkspaces } from "../../apps/factory/src/runtime/substrate-workspaces";
import { factorySigningSecret } from "../../packages/auth/src/signing-secret";
import { createDatabase } from "../../packages/db/src/client";
import { waitForDatabase } from "../../packages/db/src/wait";
import {
  createSubstrateControl,
  type SubstrateCall,
} from "../../packages/runtime-kubernetes/src/substrate-control";
import { requireNativeInstallation } from "../factory/native-installation";

const database = createDatabase(1);
try {
  await waitForDatabase(database.client);
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
    await beginInstallationMaintenance(database, async (sql, target) => {
      const namespace = process.env["FACTORY_NAMESPACE"];
      const serviceAccount = process.env["FACTORY_SERVICE_ACCOUNT"];
      if (!namespace || !serviceAccount)
        throw new Error("Paused Stop maintenance requires its original native Editor identity");
      const configuration = requireNativeInstallation(process.env, {
        editorPrincipal: `user:system:serviceaccount:${namespace}:${serviceAccount}`,
      });
      const native = createSubstrateControl(configuration.connection);
      const readNative: SubstrateCall = (method, request) => {
        if (!["GetAtespace", "GetActorTemplate", "GetActor"].includes(method))
          throw new Error("Maintenance cannot dispatch native mutations");
        return native(method, request);
      };
      const owner = createSubstrateWorkspaces(
        database,
        new RuntimeHub(async () => {}),
        factorySigningSecret(),
        { ...configuration, projectID: target.projectID },
        readNative,
        async () => {
          throw new Error("Maintenance has no native Owner authority");
        },
      );
      const execution = await owner.forAttempt(target.attemptID, sql);
      return (await execution?.pausedStopRetainedIn(sql, target.stopID)) ?? false;
    });
    console.log(
      "The installation is fenced for upgrade. Any retained paused Coding Stop remains unconfirmed and is not replayed.",
    );
  }
} finally {
  await database.client.end();
}
