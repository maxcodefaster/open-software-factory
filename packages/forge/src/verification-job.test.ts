import { expect, test } from "bun:test";
import { createForgejoClient } from "./forge";

test("Verification binds the native job of its exact run rather than an older shared-label queue", async () => {
  const calls: string[] = [];
  const commit = "a".repeat(40);
  const forge = createForgejoClient({
    apiURL: "http://forge.invalid/api/v1/",
    token: "owned-unused",
    fetch: async (input) => {
      const path = new URL(String(input)).pathname;
      calls.push(path);
      return Response.json(
        path.endsWith("/jobs")
          ? [
              {
                run_id: 4,
                handle: "specific-native-job-attempt",
                runs_on: ["factory-verification"],
                status: "waiting",
              },
            ]
          : {
              id: 4,
              commit_sha: commit,
              event: "pull_request",
              workflow_id: "factory-verification.yml",
            },
      );
    },
  });
  expect(await forge.verificationJobHandle({ owner: "owned", name: "project" }, 4, commit)).toBe(
    "specific-native-job-attempt",
  );
  expect(calls).toEqual([
    "/api/v1/repos/owned/project/actions/runs/4",
    "/api/v1/repos/owned/project/actions/runs/4/jobs",
  ]);
  await expect(
    forge.verificationJobHandle({ owner: "owned", name: "project" }, 4, "b".repeat(40)),
  ).rejects.toThrow();
});

test("unavailable, completed or multiple native jobs never grant another label-only runner", async () => {
  const commit = "a".repeat(40);
  for (const jobs of [
    [],
    [{ run_id: 1, handle: "old", runs_on: ["factory-verification"], status: "success" }],
    [1, 2].map((id) => ({
      run_id: 1,
      handle: `job-${id}`,
      runs_on: ["factory-verification"],
      status: "waiting",
    })),
  ]) {
    const forge = createForgejoClient({
      apiURL: "http://forge.invalid/api/v1/",
      token: "owned-unused",
      fetch: async (input) =>
        Response.json(
          String(input).endsWith("/jobs")
            ? jobs
            : {
                id: 1,
                commit_sha: commit,
                event: "pull_request",
                workflow_id: "factory-verification.yml",
              },
        ),
    });
    await expect(
      forge.verificationJobHandle({ owner: "owned", name: "project" }, 1, commit),
    ).rejects.toThrow();
  }
});
