import { factoryProcess } from "./factory-process";
const fixture = await factoryProcess();
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
  await fixture.dispose();
}
