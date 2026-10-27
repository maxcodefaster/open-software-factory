import { expect, test } from "bun:test";
import type { createDatabase } from "../../../../packages/db/src/client";
import { createProjectAgentController } from "./controller";

test("Project recovery joins its outstanding database observation without dispatching replacement work", async () => {
  const entered = Promise.withResolvers<void>();
  const finish = Promise.withResolvers<void>();
  let queries = 0;
  const database = {
    client: async () => {
      queries++;
      if (queries === 1) return [{ id: "owned-turn" }];
      entered.resolve();
      await finish.promise;
      return [];
    },
  } as unknown as ReturnType<typeof createDatabase>;
  const controller = createProjectAgentController(database, {
    start: async () => {
      throw new Error("Shutdown cannot commission implementation");
    },
  });
  await controller.recover();
  await entered.promise;
  let drained = false;
  const closing = controller.shutdown().then(() => {
    drained = true;
  });
  expect(controller.shutdown()).toBe(controller.shutdown());
  await Bun.sleep(5);
  expect(drained).toBe(false);
  finish.resolve();
  await closing;
  await controller.recover();
  expect(drained).toBe(true);
  expect(queries).toBe(2);
});
