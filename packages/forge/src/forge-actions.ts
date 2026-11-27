import { z } from "zod";
import type { ActionRunState, ForgeRepository, RunnerRegistration } from "./contracts";
import {
  ForgeAmbiguousWriteError,
  type ForgeTransport,
  isAmbiguousError,
  readAfterWrite,
  repositoryPath,
  sha,
} from "./forge-http";

const actionRunResponse = z
  .object({
    id: z.number().int().positive(),
    html_url: z.string().url(),
    commit_sha: sha,
    workflow_id: z.string().min(1),
    event: z.string().min(1),
    status: z.string().min(1),
  })
  .loose();

const actionRunsResponse = z.object({ workflow_runs: z.array(actionRunResponse) }).loose();

const runnerRegistrationResponse = z.object({
  id: z.number().int().positive(),
  uuid: z.string().uuid(),
  token: z.string().min(20),
});

const runnerResponse = z
  .object({
    id: z.number().int().positive(),
    uuid: z.string().uuid(),
    name: z.string().min(1),
    ephemeral: z.boolean(),
    status: z.string(),
  })
  .loose();

export function createForgeActions(transport: ForgeTransport) {
  return {
    async listActionRuns(repository: ForgeRepository, commitSha: string) {
      const value = actionRunsResponse.parse(
        await transport.json(
          `${repositoryPath(repository)}/actions/runs?head_sha=${encodeURIComponent(commitSha)}&limit=20`,
        ),
      );
      // Forgejo's event filter omits synchronized PR runs. Check the returned exact context here.
      return value.workflow_runs
        .filter((run) => run.commit_sha === commitSha && run.event === "pull_request")
        .map(
          (run): ActionRunState => ({
            id: run.id,
            url: run.html_url,
            commitSha: run.commit_sha,
            workflowID: run.workflow_id,
            event: run.event,
            status: run.status,
          }),
        );
    },
    async verificationJobHandle(repository: ForgeRepository, runID: number, commitSha: string) {
      const run = z
        .object({
          id: z.literal(runID),
          commit_sha: z.literal(commitSha),
          workflow_id: z.literal("factory-verification.yml"),
          event: z.literal("pull_request"),
        })
        .parse(await transport.json(`${repositoryPath(repository)}/actions/runs/${runID}`));
      const jobs = z
        .array(
          z.object({
            run_id: z.literal(run.id),
            handle: z.string().regex(/^[A-Za-z0-9_-]{1,200}$/),
            runs_on: z.array(z.string()),
            status: z.string(),
          }),
        )
        .parse(await transport.json(`${repositoryPath(repository)}/actions/runs/${runID}/jobs`));
      const eligible = jobs.filter(
        (job) =>
          job.runs_on.includes("factory-verification") &&
          ["waiting", "running"].includes(job.status),
      );
      const selected = eligible.at(0);
      if (eligible.length !== 1 || !selected)
        throw new Error("Verification requires one exact native job handle before runner creation");
      return selected.handle;
    },
    async registerEphemeralRunner(
      repository: ForgeRepository,
      name: string,
    ): Promise<RunnerRegistration> {
      const register = async () =>
        runnerRegistrationResponse.parse(
          await transport.jsonBody(`${repositoryPath(repository)}/actions/runners`, "POST", {
            name,
            description: "Factory Verification Sandbox",
            ephemeral: true,
          }),
        );
      try {
        return await register();
      } catch (error) {
        if (!isAmbiguousError(error)) throw error;
        const existing = await readAfterWrite(
          error,
          async () =>
            z
              .array(runnerResponse)
              .parse(
                await transport.json(`${repositoryPath(repository)}/actions/runners?limit=100`),
              )
              .filter((runner) => runner.name === name),
          "Runner registration outcome is unknown",
        );
        for (const runner of existing) {
          await transport.response(`${repositoryPath(repository)}/actions/runners/${runner.id}`, {
            method: "DELETE",
          });
        }
        try {
          return await register();
        } catch (retryError) {
          if (isAmbiguousError(retryError)) {
            throw new ForgeAmbiguousWriteError("Runner registration outcome is unknown");
          }
          throw retryError;
        }
      }
    },
    async deleteRunner(repository: ForgeRepository, runnerID: number) {
      await transport.deleteOptional(`${repositoryPath(repository)}/actions/runners/${runnerID}`);
    },
  };
}
