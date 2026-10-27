import { expect, test } from "bun:test";
import { startOwnedPostgres } from "../fixtures/postgres-server";
import { fixtureValue } from "../fixtures/value";

test("a lost test-daemon create acknowledgement observes the same pinned owned container without another create", async () => {
  const owner = crypto.randomUUID();
  const calls: string[][] = [];
  const lost = new Error("Infrastructure command timed out; outcome is unconfirmed");
  await startOwnedPostgres(owner, async (args) => {
    calls.push(args);
    if (args[0] === "run") throw lost;
    expect(args[0]).toBe("inspect");
    expect(args.at(-1)).toBe(`factory-test-postgres-${owner}`);
    return JSON.stringify({
      owner,
      image: fixtureValue(calls[0], "calls[0]")[
        fixtureValue(calls[0], "calls[0]").indexOf("postgres") - 1
      ],
      state: "running",
    });
  });
  expect(calls.map((args) => args[0])).toEqual(["run", "inspect"]);
});

test("test-daemon recovery never adopts a foreign, replaced, pending or unobservable resource", async () => {
  for (const state of ["foreign-owner", "wrong-image", "created", "missing"]) {
    const owner = crypto.randomUUID();
    const lost = new Error("Unconfirmed test daemon create");
    let creates = 0;
    let image = "";
    await expect(
      startOwnedPostgres(owner, async (args) => {
        if (args[0] === "run") {
          creates++;
          image = fixtureValue(
            args[args.indexOf("postgres") - 1],
            'args[args.indexOf("postgres") - 1]',
          );
          throw lost;
        }
        if (state === "missing") throw new Error("Not observed");
        return JSON.stringify({
          owner: state === "foreign-owner" ? crypto.randomUUID() : owner,
          image: state === "wrong-image" ? "postgres:latest" : image,
          state: state === "created" ? "created" : "running",
        });
      }),
    ).rejects.toBe(lost);
    expect(creates).toBe(1);
  }
});
