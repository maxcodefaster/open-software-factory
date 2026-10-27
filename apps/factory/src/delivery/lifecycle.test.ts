import { expect, test } from "bun:test";
import type { createDatabase } from "../../../../packages/db/src/client";
import type { createForgejoClient } from "../../../../packages/forge/src/forge";
import { createDeliveryController } from "./controller";

test("Delivery shutdown joins a directly admitted observation and refuses new observations", async () => {
  const entered = Promise.withResolvers<void>();
  const finish = Promise.withResolvers<void>();
  let queries = 0;
  const database = {
    client: async () => {
      queries++;
      entered.resolve();
      await finish.promise;
      return [];
    },
  } as unknown as ReturnType<typeof createDatabase>;
  const controller = createDeliveryController(
    database,
    {
      startVerification: async () => null,
      startStagingReplacement: async () => null,
      stop: async () => null,
    },
    { prompt: async () => {} },
    async () => {},
    {
      owner: "owned",
      client: {} as ReturnType<typeof createForgejoClient>,
    },
  );
  const work = controller.reconcile("owned-change");
  await entered.promise;
  let drained = false;
  const closing = controller.close().then(() => {
    drained = true;
  });
  expect(controller.close()).toBe(controller.close());
  await controller.reconcile("another-change");
  await Bun.sleep(5);
  expect(queries).toBe(1);
  expect(drained).toBe(false);
  finish.resolve();
  await Promise.all([work, closing]);
  expect(drained).toBe(true);
});
