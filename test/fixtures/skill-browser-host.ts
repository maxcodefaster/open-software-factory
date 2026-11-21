import { factoryProcess } from "./factory-process";
import { ownedPostgresServer } from "./postgres-server";

const started = performance.now();
const phase = (name: string) =>
  console.info(`Owned Skill host phase: ${name} ${Math.round(performance.now() - started)}ms`);
const shutdown = Promise.withResolvers<void>();
let stopping = false;
for (const signal of ["SIGTERM", "SIGINT"] as const)
  process.once(signal, () => {
    stopping = true;
    shutdown.resolve();
  });
phase("postgres-starting");
const previous = process.env["FACTORY_TEST_POSTGRES"];
let postgres: Awaited<ReturnType<typeof ownedPostgresServer>> | undefined;
let fixture: Awaited<ReturnType<typeof factoryProcess>> | undefined;
try {
  postgres = previous ? undefined : await ownedPostgresServer();
  phase("postgres-ready");
  if (postgres) process.env["FACTORY_TEST_POSTGRES"] = JSON.stringify(postgres.identity);
  if (!stopping) {
    phase("factory-preparing");
    fixture = await factoryProcess();
    phase("factory-prepared");
  }
  if (fixture && !stopping) {
    phase("cache-starting");
    await fixture.startPlanningCache();
    phase("cache-ready");
  }
  if (fixture && !stopping) {
    phase("application-starting");
    await fixture.start();
    phase("application-ready");
    if (!stopping)
      console.log(
        JSON.stringify({
          fixtureBase: fixture.base,
          id: fixture.id,
          databaseURL: fixture.databaseURL,
        }),
      );
    await shutdown.promise;
  }
} finally {
  phase("cleanup-starting");
  try {
    await fixture?.dispose();
  } finally {
    await postgres?.dispose();
    if (previous === undefined) delete process.env["FACTORY_TEST_POSTGRES"];
    else process.env["FACTORY_TEST_POSTGRES"] = previous;
  }
  phase("cleanup-complete");
}
