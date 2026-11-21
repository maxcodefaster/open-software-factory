import { configuredSubstrateInstallation } from "./runtime/substrate-workspaces";
import { createFactoryApplication } from "./server/application";
import { startFactoryLifecycle } from "./server/lifecycle";
import { createStartupDispatchGate } from "./server/startup-dispatch";
import { startFactoryTransport } from "./server/transport";

const application = await createFactoryApplication();
const servers = startFactoryTransport(application);
const nativeInstallation = configuredSubstrateInstallation();
const closeBackgroundWork = startFactoryLifecycle(
  application,
  createStartupDispatchGate({
    required: Boolean(process.env["FACTORY_HELM_RELEASE"]),
    origin: application.factoryOrigin,
    nativeBinding: nativeInstallation,
    startupID: application.startupID,
    caFile: nativeInstallation?.factoryCAFile,
  }),
);
for (const server of servers) console.log(`Factory listening on ${server.url}`);

let stopping = false;
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.once(signal, () => {
    if (stopping) return;
    stopping = true;
    void (async () => {
      for (const server of servers) await server.stop(true);
      await closeBackgroundWork();
      await application.database.client.end();
    })().then(
      () => process.exit(0),
      (cause) => {
        console.error("Factory shutdown is incomplete", cause);
        process.exit(1);
      },
    );
  });
