import { expect, test } from "bun:test";
import { sanitizeVerificationOutput } from "./diagnostics";
import { createForgejoClient } from "./forge";

const repository = { owner: "owned", name: "app" };
const commit = "a".repeat(40);
const secret = "owned-private-credential-123456789012345";
function fixture(
  options: {
    status?: string;
    step?: number;
    logMissing?: boolean;
    wrongCommit?: boolean;
    wrongJob?: boolean;
    pending?: boolean;
    jobStatus?: string;
    extraJobs?: boolean;
    noSteps?: boolean;
    nextPage?: boolean;
    changedAttempt?: boolean;
    lateAttempt?: boolean;
    log?: string;
  } = {},
) {
  const calls: string[] = [];
  let jobLists = 0;
  const job = {
    id: 8,
    run_id: options.wrongJob ? 99 : 7,
    attempt: 2,
    name: "Project checks",
    status: options.pending ? "running" : (options.jobStatus ?? "failure"),
    steps: options.noSteps
      ? []
      : [
          { number: 0, name: "Set up job", status: options.step === 0 ? "failure" : "success" },
          {
            number: 1,
            name: "bun run test",
            status: options.step === 0 ? "skipped" : (options.jobStatus ?? "failure"),
          },
          { number: 2, name: "Complete job", status: "success" },
        ],
  };
  const client = createForgejoClient({
    apiURL: "https://forge.invalid/api/v1/",
    token: secret,
    fetch: async (input, init) => {
      const url = new URL(String(input));
      calls.push(url.pathname);
      if (url.pathname.endsWith("/runs/7"))
        return Response.json({
          id: 7,
          commit_sha: options.wrongCommit ? "b".repeat(40) : commit,
          workflow_id: "factory-verification.yml",
          event: "pull_request",
          status: options.status ?? "failure",
        });
      if (url.pathname.endsWith("/runs/7/jobs")) {
        jobLists++;
        return Response.json(
          options.extraJobs
            ? Array.from({ length: 9 }, (_, i) => ({ ...job, id: i + 8 }))
            : [{ ...job, ...(options.lateAttempt && jobLists > 1 ? { attempt: 3 } : {}) }],
          { headers: options.nextPage ? { link: '<https://forge.invalid/next>; rel="next"' } : {} },
        );
      }
      if (url.pathname.endsWith("/jobs/8"))
        return Response.json({
          ...job,
          ...(options.changedAttempt ? { attempt: 3 } : {}),
        });
      if (url.pathname.endsWith("/jobs/8/logs")) {
        expect(url.searchParams.get("attempt")).toBe("2");
        expect(url.searchParams.get("step")).toBe("1");
        expect(new Headers(init?.headers).get("range")).toMatch(/^bytes=/);
        if (options.log !== undefined) {
          const bytes = Buffer.from(options.log);
          const range = new Headers(init?.headers).get("range") ?? "";
          const suffix = range.match(/^bytes=-(\d+)$/);
          const start = suffix ? Math.max(0, bytes.length - Number(suffix[1])) : 0;
          return new Response(bytes.subarray(start), {
            status: 206,
            headers: { "content-range": `bytes ${start}-${bytes.length - 1}/${bytes.length}` },
          });
        }
        return options.logMissing
          ? new Response(null, { status: 404 })
          : new Response(`Run bun run test\nExpected 200, received 500\nAPI_KEY=${secret}\n`, {
              headers: { "content-type": "text/plain" },
            });
      }
      throw new Error("Unexpected Forge path");
    },
  });
  return { client, calls };
}
test("successful receipts retain exact native jobs and attempts, not logs or invented case totals", async () => {
  const { client, calls } = fixture({ status: "success", jobStatus: "success" });
  const receipt = await client.observeVerification(repository, 7, commit);
  expect(receipt).toMatchObject({
    commit,
    runId: 7,
    workflow: "factory-verification.yml",
    complete: true,
    status: "success",
    jobs: [
      {
        id: 8,
        attempt: 2,
        status: "success",
        steps: [
          { number: 0 },
          { number: 1, name: "bun run test", status: "success" },
          { number: 2 },
        ],
      },
    ],
  });
  expect(receipt.changes).toBeNull();
  expect(calls.some((path) => path.endsWith("/logs"))).toBe(false);
  expect(receipt).not.toHaveProperty("passed");
});
test.each([
  { wrongCommit: true },
  { wrongJob: true },
  { noSteps: true },
  { extraJobs: true },
  { nextPage: true },
  { pending: true },
  { changedAttempt: true },
  { lateAttempt: true },
  { status: "success", jobStatus: "failure" },
])("receipts keep unavailable, partial or contradictory checks incomplete: %j", async (options) => {
  const { client, calls } = fixture(options);
  expect((await client.observeVerification(repository, 7, commit)).complete).toBe(false);
  expect(calls.some((path) => path.endsWith("/logs"))).toBe(false);
});
test("a failed real step has exact job/attempt, useful output and redacted credentials", async () => {
  const { client } = fixture();
  const result = await client.diagnoseVerification(repository, 7, commit);
  expect(result.kind).toBe("check-failed");
  expect(result.jobs[0]).toMatchObject({ id: 8, attempt: 2, step: 1, stepName: "bun run test" });
  expect(result.jobs[0]?.output).toContain("Expected 200, received 500");
  expect(JSON.stringify(result)).not.toContain(secret);
});
test("a failure before later successful checks survives the compact diagnosis", async () => {
  const { client } = fixture({
    log:
      "2026-10-31T02:25:23Z Run repository checks\n" +
      "2026-10-31T02:25:24Z RequestError: expected 401 in a passing negative test\n" +
      "2026-10-31T02:25:24Z ✔ rejects unauthorized requests\n".repeat(100) +
      "2026-10-31T02:27:01Z AssertionError: required immutable CMS snapshot missing\n" +
      `2026-10-31T02:27:01Z API_KEY=${secret}\n` +
      "2026-10-31T02:27:01Z expected true, received false\n" +
      "2026-10-31T02:27:01Z pnpm test exit code: 1\n" +
      "2026-10-31T02:34:14Z ✔ unrelated successful check\n".repeat(2000) +
      "2026-10-31T02:34:14Z verify coder exit code: 0\n" +
      "2026-10-31T02:34:14Z runner: RUN exit status 1\n",
  });
  const result = await client.diagnoseVerification(repository, 7, commit);
  expect(result.kind).toBe("check-failed");
  expect(result.jobs[0]?.output).toContain("required immutable CMS snapshot missing");
  expect(result.jobs[0]?.output).toContain("expected true, received false");
  expect(result.jobs[0]?.output).toContain("byte");
  expect(result.jobs[0]?.output?.length).toBeLessThanOrEqual(2400);
  expect(JSON.stringify(result)).not.toContain(secret);
});
test.each(["cancelled", "skipped"])("%s is not a code defect and reads no logs", async (status) => {
  const { client, calls } = fixture({ status });
  expect((await client.diagnoseVerification(repository, 7, commit)).kind).toBe(status);
  expect(calls).toHaveLength(1);
});
test.each([
  [{ step: 0 }, "execution-failed"],
  [{ logMissing: true }, "unavailable"],
  [{ wrongCommit: true }, "unavailable"],
  [{ wrongJob: true }, "unavailable"],
  [{ pending: true }, "pending"],
] as const)("diagnosis fails safely for %j", async (options, kind) => {
  expect((await fixture(options).client.diagnoseVerification(repository, 7, commit)).kind).toBe(
    kind,
  );
});
test("log reads reject a foreign job before fetching output", async () => {
  const { client, calls } = fixture({ wrongJob: true });
  await expect(
    client.readVerificationLog(repository, {
      runID: 7,
      commit,
      jobID: 8,
      attempt: 2,
      step: 1,
      offset: 0,
    }),
  ).rejects.toThrow("changed");
  expect(calls.some((path) => path.endsWith("/logs"))).toBe(false);
});
test("log pages preserve a checked native byte cursor", async () => {
  const client = createForgejoClient({
    apiURL: "https://forge.invalid/api/v1/",
    token: secret,
    fetch: async (input) => {
      const url = String(input);
      if (url.includes("/runs/7"))
        return Response.json({
          id: 7,
          commit_sha: commit,
          workflow_id: "factory-verification.yml",
          event: "pull_request",
          status: "failure",
        });
      if (!url.includes("/logs"))
        return Response.json({
          id: 8,
          run_id: 7,
          attempt: 2,
          name: "Checks",
          status: "failure",
          steps: [{ number: 1, name: "test", status: "failure" }],
        });
      return new Response("next page", {
        status: 206,
        headers: { "content-range": "bytes 4096-4104/9000" },
      });
    },
  });
  expect(
    await client.readVerificationLog(repository, {
      runID: 7,
      commit,
      jobID: 8,
      attempt: 2,
      step: 1,
      offset: 4096,
    }),
  ).toEqual({ output: "next page", nextOffset: 4105 });
});
test("diagnostic output removes common secrets, URL credentials and terminal controls", () => {
  const output = sanitizeVerificationOutput(
    '\u001b[31mfail\u001b[0m\nAuthorization: Bearer opaque-value\nhttps://user:password@host/path\n{"client_secret":"private"}\nPASSWORD=hidden\n-----BEGIN PRIVATE KEY-----\nprivate\n-----END PRIVATE KEY-----',
    secret,
  );
  expect(output).toContain("fail");
  for (const value of ["opaque-value", "user:password", '"private"', "=hidden", "\u001b"])
    expect(output).not.toContain(value);
});
