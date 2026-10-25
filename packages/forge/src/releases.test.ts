import { expect, test } from "bun:test";
import { createForgejoReleases, type PublicationRun } from "./releases";

const expected: PublicationRun = {
  id: 51,
  index_in_repo: 7,
  commit_sha: "a".repeat(40),
  event: "workflow_dispatch",
  event_payload: "{}",
  workflow_id: "factory-release.yml",
  status: "running",
  html_url: "https://forge.example/actions/runs/7",
  trigger_user: { login: "factory" },
};
test("job labels alone cannot authorize publication credentials", async () => {
  let taskRun = 8;
  let sha = expected.commit_sha;
  const adapter = createForgejoReleases({
    apiURL: "https://forge.example/api/v1/",
    token: "synthetic-test-token",
    fetch: (async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/runners/jobs"))
        return Response.json([
          {
            id: 81,
            handle: "opaque-attempt-handle",
            name: "publish",
            task_id: 18,
            runs_on: ["factory-publication"],
            status: "running",
          },
        ]);
      return Response.json({
        workflow_runs: [
          {
            id: 18,
            run_number: taskRun,
            head_sha: sha,
            event: "workflow_dispatch",
            workflow_id: expected.workflow_id,
            status: "running",
          },
        ],
      });
    }) as typeof fetch,
  });
  const repo = { owner: "factory", name: "project" };
  expect(await adapter.attestTask(repo, "opaque-attempt-handle", expected)).toBe(false);
  taskRun = 7;
  sha = "b".repeat(40);
  expect(await adapter.attestTask(repo, "opaque-attempt-handle", expected)).toBe(false);
  sha = expected.commit_sha;
  expect(await adapter.attestTask(repo, "opaque-attempt-handle", expected)).toBe(true);
  expect(await adapter.attestTask(repo, "wrong-attempt-handle", expected)).toBe(false);
});
test("the pinned native dispatch trigger is normalized without inventing a webhook event", async () => {
  const client = createForgejoReleases({
    apiURL: "https://forge.example/api/v1/",
    token: "synthetic-test-token",
    fetch: (async () =>
      Response.json({
        ...expected,
        event: "",
        trigger_event: "workflow_dispatch",
      })) as unknown as typeof fetch,
  });
  expect((await client.run({ owner: "factory", name: "project" }, 51))?.event).toBe(
    "workflow_dispatch",
  );
});
