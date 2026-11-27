import { expect, test } from "bun:test";
import type { createDatabase } from "#db/client";
import type { createForgejoClient } from "#forge/forge";
import { createDeliveryController } from "./controller";

test("Delivery shutdown joins a directly admitted observation and refuses new observations", async () => {
  const entered = Promise.withResolvers<void>();
  const finish = Promise.withResolvers<void>();
  let queries = 0;
  const query = async () => {
    queries++;
    entered.resolve();
    await finish.promise;
    return [];
  };
  const database = {
    client: Object.assign(query, { unsafe: () => ({ values: query }) }),
  } as unknown as ReturnType<typeof createDatabase>;
  const controller = createDeliveryController(
    database,
    {
      startVerification: async () => null,
      startStagingReplacement: async () => null,
      pause: async () => {
        throw new Error("Observation must not pause Workspace compute");
      },
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
