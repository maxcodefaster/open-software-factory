import { expect, test } from "bun:test";
import { factoryProcess } from "../fixtures/factory-process";

test("owned proof continuation retains its database and listener identity without creating paid work", async () => {
  const original = await factoryProcess();
  let retained: Awaited<ReturnType<typeof factoryProcess>> | undefined;
  let sibling: Awaited<ReturnType<typeof factoryProcess>> | undefined;
  const database = original.connect();
  try {
    await original.start();
    await original.signIn();
    const before = await database.client<
      { id: string; email: string }[]
    >`SELECT id,email FROM auth."user" ORDER BY id`;
    sibling = await factoryProcess();
    expect(sibling.databaseURL).not.toBe(original.databaseURL);
    const isolated = sibling.connect(1);
    try {
      expect(await isolated.client`SELECT id FROM auth."user"`).toHaveLength(0);
    } finally {
      await isolated.client.end();
    }
    await original.pause();
    retained = await factoryProcess(undefined, undefined, {
      id: original.id,
      base: original.base,
    });
    expect(retained.databaseURL).toBe(original.databaseURL);
    expect(retained.base).toBe(original.base);
    await retained.start();
    expect((await retained.signIn()).startsWith("factory.session_token=")).toBe(true);
    const after = await database.client<
      { id: string; email: string }[]
    >`SELECT id,email FROM auth."user" ORDER BY id`;
    expect([...after]).toEqual([...before]);
    expect(await database.client`SELECT id FROM factory.agent_turn`).toHaveLength(0);
    await expect(
      factoryProcess(undefined, undefined, {
        id: crypto.randomUUID(),
        base: original.base,
      }),
    ).rejects.toThrow();
  } finally {
    await database.client.end({ timeout: 2 });
    await sibling?.dispose();
    await (retained ?? original).dispose();
  }
}, 90_000);
