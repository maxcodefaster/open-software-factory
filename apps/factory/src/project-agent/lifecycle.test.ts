import { expect, test } from "bun:test";
import type postgres from "postgres";
import { type createDatabase, drizzleTransaction } from "#db/client";
import { createProjectAgentController } from "./controller";

test("conversation mode cannot commission Coding without exact Implement admission", async () => {
  let transactions = 0;
  const database = {
    client: {
      async begin() {
        transactions++;
        throw new Error("Build mode cannot write a conversation or admit work");
      },
    },
  } as unknown as ReturnType<typeof createDatabase>;
  const controller = createProjectAgentController(database);
  try {
    await expect(
      controller.setMode(crypto.randomUUID(), crypto.randomUUID(), "build", crypto.randomUUID()),
    ).rejects.toMatchObject({
      code: "conflict",
      message: "Use Implement to approve the exact saved requirements and start Coding.",
    });
    expect(transactions).toBe(0);
  } finally {
    await controller.shutdown();
  }
});

test("Project recovery joins its outstanding database observation without dispatching replacement work", async () => {
  const entered = Promise.withResolvers<void>();
  const finish = Promise.withResolvers<void>();
  let queries = 0;
  const client = Object.assign(
    async () => {
      throw new Error("Recovery selection and history must use the Drizzle driver");
    },
    {
      unsafe() {
        queries++;
        return {
          values: async () => {
            if (queries === 1) return [["owned-turn"]];
            entered.resolve();
            await finish.promise;
            return [];
          },
        };
      },
    },
  ) as unknown as postgres.Sql;
  const database = {
    client,
    db: drizzleTransaction(client),
  } as unknown as ReturnType<typeof createDatabase>;
  const controller = createProjectAgentController(database);
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
