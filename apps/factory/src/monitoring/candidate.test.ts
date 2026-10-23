import { expect, test } from "bun:test";
import { monitoringCandidate } from "./candidate";

test("Autofix inventory comparison rejects unchanged candidates and deleted regression tests", async () => {
  const repository = { owner: "owned", name: "candidate" };
  const base = "a".repeat(40),
    candidate = "b".repeat(40);
  const source = { path: "src/invoice.ts", sha: "c".repeat(40), size: 10 };
  const regression = { path: "test/invoice.test.ts", sha: "d".repeat(40), size: 10 };
  await expect(
    monitoringCandidate(
      {
        listFiles: async () => [source, regression],
      },
      repository,
      base,
      candidate,
    ),
  ).rejects.toThrow("application-code");
  await expect(
    monitoringCandidate(
      {
        listFiles: async (_repository, ref) =>
          ref === base ? [source, regression] : [{ ...source, sha: "e".repeat(40) }],
      },
      repository,
      base,
      candidate,
    ),
  ).rejects.toThrow("application-code");
  const digest = await monitoringCandidate(
    {
      listFiles: async (_repository, ref) => [
        ref === base ? source : { ...source, sha: "e".repeat(40) },
        regression,
      ],
    },
    repository,
    base,
    candidate,
  );
  expect(digest).toMatch(/^[a-f0-9]{64}$/);
});
