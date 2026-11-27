import { expect, test } from "bun:test";
import type { DeliveryView } from "../../apps/factory/src/delivery/contracts";
import { approveStarterDelivery } from "../fixtures/starter-delivery";

const changeID = "01994a7d-0000-7000-8000-000000000001";
const verificationID = "01994a7d-0000-7000-8000-000000000002";
const reviewID = "01994a7d-0000-7000-8000-000000000003";
const commitSha = "a".repeat(40);
const otherSha = "b".repeat(40);
const ready: DeliveryView = {
  verificationId: verificationID,
  verificationState: "succeeded",
  verificationCommitSha: commitSha,
  reviewId: reviewID,
  reviewState: "passed",
  reviewCurrent: true,
};

function controlledApproval(
  observations: DeliveryView[],
  options: { approved?: boolean; reviewSha?: string | null; approvalDenied?: boolean } = {},
) {
  const calls: Array<{ name: string; args: unknown; headers: HeadersInit | undefined }> = [];
  const queries: Array<{ sql: string; values: unknown[] }> = [];
  const events: string[] = [];
  let reads = 0;
  let approved = options.approved ?? false;
  const input: Parameters<typeof approveStarterDelivery>[0] = {
    base: "https://owned-factory.example",
    cookie: "owned-session=fixture-only",
    changeID,
    commitSha,
    database: {
      client: async (sql: TemplateStringsArray, ...values: unknown[]) => {
        const text = sql.join("?");
        queries.push({ sql: text, values });
        if (text.includes("factory.delivery_approval"))
          return approved ? [{ id: "existing-approval" }] : [];
        if (text.includes("factory.candidate_review")) {
          events.push("review-identity");
          return options.reviewSha === null ? [] : [{ sha: options.reviewSha ?? commitSha }];
        }
        throw Error("Unexpected database access");
      },
    } as unknown as Parameters<typeof approveStarterDelivery>[0]["database"],
  };
  const call = (async (
    base: string,
    name: string,
    args: unknown,
    headers: HeadersInit | undefined,
  ) => {
    expect(base).toBe(input.base);
    calls.push({ name, args, headers });
    events.push(name);
    if (name === "getDelivery") {
      const delivery = observations[reads++];
      if (!delivery) throw Error("Scripted observations exhausted");
      return { ok: true, value: delivery };
    }
    if (name === "approveDelivery") {
      if (options.approvalDenied)
        return { ok: false, status: 409, message: "Resolve open review Threads before Delivery." };
      approved = true;
      return { ok: true, value: ready };
    }
    throw Error(`Unexpected Factory command: ${name}`);
  }) as Parameters<typeof approveStarterDelivery>[1];
  return {
    run: () => approveStarterDelivery(input, call),
    calls,
    queries,
    events,
  };
}

const blocked: Array<[string, DeliveryView]> = [
  ["missing review", { ...ready, reviewId: undefined, reviewState: undefined }],
  ["missing Verification identity", { ...ready, verificationId: undefined }],
  ["pending", { ...ready, reviewState: "pending" }],
  ["running", { ...ready, reviewState: "running" }],
  ["failed", { ...ready, reviewState: "failed" }],
  ["stopped", { ...ready, reviewState: "stopped" }],
  ["uncertain", { ...ready, reviewState: "uncertain" }],
  ["incomplete", { ...ready, reviewState: "incomplete" }],
  ["changes requested", { ...ready, reviewState: "changes-requested" }],
  ["rejected", { ...ready, reviewState: "rejected" }],
  ["stale", { ...ready, reviewCurrent: false }],
  ["unknown currentness", { ...ready, reviewCurrent: undefined }],
  ["changed commit", { ...ready, verificationCommitSha: otherSha }],
  ["missing commit", { ...ready, verificationCommitSha: undefined }],
  ["Verification running", { ...ready, verificationState: "running" }],
  ["Verification failed", { ...ready, verificationState: "failed" }],
];

test.each(blocked)("%s never triggers human Delivery approval", async (_name, delivery) => {
  const f = controlledApproval([delivery]);
  await expect(f.run()).rejects.toThrow("Scripted observations exhausted");
  expect(f.calls.every((call) => call.name === "getDelivery")).toBe(true);
  expect(f.events).not.toContain("review-identity");
});

test("pending and stale reviews wait until a current successful same-commit review", async () => {
  const f = controlledApproval([
    { ...ready, reviewState: "pending" },
    { ...ready, reviewState: "running" },
    { ...ready, reviewCurrent: false },
    ready,
  ]);
  await f.run();
  expect(f.events).toEqual([
    "getDelivery",
    "getDelivery",
    "getDelivery",
    "getDelivery",
    "review-identity",
    "approveDelivery",
  ]);
  expect(f.calls.every((call) => JSON.stringify(call.args) === JSON.stringify([changeID]))).toBe(
    true,
  );
  expect(
    f.calls.every(
      (call) => new Headers(call.headers).get("cookie") === "owned-session=fixture-only",
    ),
  ).toBe(true);
  expect(f.queries.at(-1)?.values).toEqual([reviewID, verificationID, changeID]);
});

test.each([
  ["different canonical review commit", otherSha],
  ["missing canonical review", null],
] as const)("%s never triggers approval", async (_name, reviewSha) => {
  const f = controlledApproval([ready], { reviewSha });
  await expect(f.run()).rejects.toThrow("Scripted observations exhausted");
  expect(f.events).toEqual(["getDelivery", "review-identity", "getDelivery"]);
});

test("current passed same-commit review approves once and retained approval remains idempotent", async () => {
  const f = controlledApproval([ready]);
  await f.run();
  await f.run();
  expect(f.events).toEqual(["getDelivery", "review-identity", "approveDelivery"]);
  expect(f.queries.filter((query) => query.sql.includes("factory.delivery_approval"))).toHaveLength(
    2,
  );
});

test("existing approval does not repeat the human decision or require a new review", async () => {
  const f = controlledApproval([], { approved: true });
  await f.run();
  expect(f.calls).toHaveLength(0);
  expect(f.queries).toHaveLength(1);
  expect(f.queries[0]?.values).toEqual([changeID]);
});

test("authenticated approval denial is preserved without retries or blocker auto-approval", async () => {
  const f = controlledApproval([ready], { approvalDenied: true });
  await expect(f.run()).rejects.toThrow("Resolve open review Threads before Delivery.");
  expect(f.events).toEqual(["getDelivery", "review-identity", "approveDelivery"]);
});
