import { factoryProcess } from "./factory-process";
import { ownedPostgresServer } from "./postgres-server";

const postgres = process.env["FACTORY_TEST_POSTGRES"] ? undefined : await ownedPostgresServer();
if (postgres) process.env["FACTORY_TEST_POSTGRES"] = JSON.stringify(postgres.identity);
const fixture = await factoryProcess().catch(async (cause) => {
  await postgres?.dispose();
  throw cause;
});
try {
  await fixture.startPlanningCache();
  await fixture.start();
  console.log(
    JSON.stringify({ fixtureBase: fixture.base, id: fixture.id, databaseURL: fixture.databaseURL }),
  );
  await new Promise<void>((resolve) => {
    process.once("SIGTERM", resolve);
    process.once("SIGINT", resolve);
  });
} finally {
  try {
    await fixture.dispose();
  } finally {
    await postgres?.dispose();
  }
}
