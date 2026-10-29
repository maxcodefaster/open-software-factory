import { expect, test } from "bun:test";
import { factoryProcess } from "../fixtures/factory-process";

test("the actual cache reaches its private database and the loopback Factory callback without starting work", async () => {
  const owned = await factoryProcess();
  const database = owned.connect();
  try {
    const cache = await owned.startPlanningCache();
    await owned.start();
    await owned.signIn();
    const probe = Bun.spawn(
      [
        "docker",
        "exec",
        cache.name,
        "node",
        "--input-type=module",
        "-e",
        `const target = new URL(process.env.ZERO_QUERY_URL);
if (target.pathname !== "/api/zero/query") throw new Error("Wrong owned query route");
target.pathname = "/health/ready";
const response = await fetch(target);
console.log(JSON.stringify({status:response.status, contentType:response.headers.get("content-type")}));`,
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    const [stdout, stderr, status] = await Promise.all([
      new Response(probe.stdout).text(),
      new Response(probe.stderr).text(),
      probe.exited,
    ]);
    expect({ status, stderr }).toEqual({ status: 0, stderr: "" });
    expect(JSON.parse(stdout)).toMatchObject({
      status: 200,
      contentType: expect.stringContaining("application/json"),
    });
    const [work] = await database.client<{ turns: number; attempts: number }[]>`
      SELECT (SELECT count(*)::int FROM factory.agent_turn) AS turns,
        (SELECT count(*)::int FROM factory.runtime_attempt) AS attempts`;
    expect(work).toEqual({ turns: 0, attempts: 0 });
  } finally {
    await database.client.end({ timeout: 2 });
    await owned.dispose();
  }
});
