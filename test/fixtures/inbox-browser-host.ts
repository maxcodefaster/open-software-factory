import { factoryProcess } from "./factory-process";
import { ownedPostgresServer } from "./postgres-server";

const shutdown = Promise.withResolvers<void>();
process.once("SIGTERM", () => shutdown.resolve());
process.once("SIGINT", () => shutdown.resolve());
const previous = process.env["FACTORY_TEST_POSTGRES"];
const postgres = previous ? undefined : await ownedPostgresServer();
if (postgres) process.env["FACTORY_TEST_POSTGRES"] = JSON.stringify(postgres.identity);
const identity = JSON.parse(process.env["FACTORY_TEST_POSTGRES"] ?? "null") as {
  owner: string;
} | null;
if (!identity) throw new Error("Owned browser PostgreSQL identity missing");
let fixture: Awaited<ReturnType<typeof factoryProcess>> | undefined;
try {
  fixture = await factoryProcess();
  await fixture.startPlanningCache(false, 1, `factory-test-postgres-${identity.owner}`);
  await fixture.start();
  console.log(
    JSON.stringify({ fixtureBase: fixture.base, id: fixture.id, databaseURL: fixture.databaseURL }),
  );
  await shutdown.promise;
} finally {
  if (previous === undefined) delete process.env["FACTORY_TEST_POSTGRES"];
  else process.env["FACTORY_TEST_POSTGRES"] = previous;
  await fixture?.dispose();
  await postgres?.dispose();
}
