import { z } from "zod";
import {
  type VerificationDiagnosis,
  type VerificationReceipt,
  verificationReceiptInput,
} from "../../conversation-domain/src/verification";
import { readVerificationDiagnostic, sanitizeVerificationOutput } from "./diagnostic-output";
import type { ForgeRepository } from "./forge";

export { sanitizeVerificationOutput } from "./diagnostic-output";

const runInput = z.object({
  id: z.number().int().positive(),
  commit_sha: z.string(),
  workflow_id: z.string(),
  event: z.string(),
  status: z.string(),
});
const jobInput = z.object({
  id: z.number().int().positive(),
  run_id: z.number().int().positive(),
  attempt: z.number().int().positive(),
  name: z.string().max(200),
  status: z.string(),
  steps: z
    .array(
      z.object({
        number: z.number().int().nonnegative(),
        name: z.string(),
        status: z.string(),
      }),
    )
    .optional(),
});
const terminal = new Set(["success", "failure", "cancelled", "skipped"]);
const excerpt = (text: string, bytes: number) =>
  Buffer.from(text).subarray(0, bytes).toString("utf8");

async function boundedBody(response: Response, limit: number) {
  const reader = response.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > limit) throw new Error("Forge diagnosis response exceeds its bound");
      chunks.push(chunk.value);
    }
    return Buffer.concat(chunks);
  } finally {
    await reader.cancel().catch(() => {});
  }
}

export function createForgejoDiagnostics(
  send: (path: string, init?: RequestInit) => Promise<Response>,
  credential: string,
) {
  const path = (repo: ForgeRepository) =>
    `repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}/actions`;
  async function json(route: string) {
    return JSON.parse(Buffer.from(await boundedBody(await send(route), 256 * 1024)).toString());
  }
  async function run(repo: ForgeRepository, id: number, commit: string) {
    const value = runInput.parse(await json(`${path(repo)}/runs/${id}`));
    if (
      value.id !== id ||
      value.commit_sha !== commit ||
      value.workflow_id !== "factory-verification.yml" ||
      value.event !== "pull_request"
    )
      throw new Error("Verification run does not match its admitted candidate");
    return value;
  }
  async function job(repo: ForgeRepository, runID: number, id: number, attempt: number) {
    const value = jobInput.parse(await json(`${path(repo)}/jobs/${id}`));
    if (value.id !== id || value.run_id !== runID || value.attempt !== attempt)
      throw new Error("Verification job or attempt changed");
    return value;
  }
  async function observedJobs(repo: ForgeRepository, runID: number) {
    const response = await send(`${path(repo)}/runs/${runID}/jobs?limit=9&page=1`);
    const items = z
      .array(jobInput)
      .parse(JSON.parse(Buffer.from(await boundedBody(response, 256 * 1024)).toString()));
    const total = response.headers.get("x-total-count");
    if (
      !items.length ||
      items.length > 8 ||
      /rel="next"/.test(response.headers.get("link") ?? "") ||
      (total !== null && (!/^\d+$/.test(total) || Number(total) !== items.length)) ||
      new Set(items.map((item) => item.id)).size !== items.length ||
      items.some((item) => item.run_id !== runID)
    )
      throw new Error("Verification job observations are incomplete");
    return items;
  }
  async function output(
    repo: ForgeRepository,
    id: number,
    attempt: number,
    step: number,
    offset?: number,
  ) {
    const range = offset === undefined ? "bytes=-8192" : `bytes=${offset}-${offset + 4095}`;
    const response = await send(`${path(repo)}/jobs/${id}/logs?attempt=${attempt}&step=${step}`, {
      headers: { accept: "text/plain", range },
    });
    const contentRange = response.headers.get("content-range")?.match(/^bytes (\d+)-(\d+)\/(\d+)$/);
    if (response.status === 206) {
      if (!contentRange || (offset !== undefined && Number(contentRange[1]) !== offset))
        throw new Error("Verification log range changed");
    } else if (offset) throw new Error("Forge did not honor the log offset");
    const bytes = await boundedBody(response, offset === undefined ? 8192 : 4096);
    const text = sanitizeVerificationOutput(Buffer.from(bytes).toString("utf8"), credential);
    const end = contentRange ? Number(contentRange[2]) + 1 : bytes.length;
    return {
      output: text,
      nextOffset: contentRange && end < Number(contentRange[3]) ? end : null,
    };
  }
  return {
    async observeVerification(
      repo: ForgeRepository,
      runID: number,
      commit: string,
    ): Promise<VerificationReceipt> {
      const receipt: VerificationReceipt = {
        commit,
        runId: runID,
        workflow: "factory-verification.yml",
        status: "unknown",
        complete: false,
        jobs: [],
        changes: null,
      };
      const status = (value: string): VerificationReceipt["status"] =>
        terminal.has(value)
          ? (value as VerificationReceipt["status"])
          : ["running", "waiting", "blocked"].includes(value)
            ? "pending"
            : "unknown";
      try {
        const current = await run(repo, runID, commit);
        receipt.status = status(current.status);
        // A bounded first page is evidence only when the server confirms no next page.
        const listed = await observedJobs(repo, runID);
        let complete = terminal.has(current.status);
        for (const item of listed) {
          const detail = await job(repo, runID, item.id, item.attempt);
          const steps = detail.steps ?? [];
          complete &&=
            detail.status === item.status &&
            terminal.has(detail.status) &&
            steps.length > 0 &&
            steps.length <= 16 &&
            new Set(steps.map((step) => step.number)).size === steps.length &&
            steps.every((step) => terminal.has(step.status)) &&
            (current.status !== "success" ||
              detail.status === "success" ||
              detail.status === "skipped") &&
            (detail.status !== "success" ||
              steps.every((step) => ["success", "skipped"].includes(step.status)));
          receipt.jobs.push({
            id: detail.id,
            attempt: detail.attempt,
            name: excerpt(sanitizeVerificationOutput(detail.name, credential), 120),
            status: status(detail.status),
            steps: steps.slice(0, 16).map((step) => ({
              number: step.number,
              name: excerpt(sanitizeVerificationOutput(step.name, credential), 120),
              status: status(step.status),
            })),
          });
        }
        const confirmedJobs = await observedJobs(repo, runID);
        const identities = (items: z.infer<typeof jobInput>[]) =>
          items
            .map((item) => `${item.id}:${item.attempt}:${item.status}`)
            .sort()
            .join(",");
        const confirmed = await run(repo, runID, commit);
        receipt.status = status(confirmed.status);
        receipt.complete =
          complete &&
          confirmed.status === current.status &&
          identities(listed) === identities(confirmedJobs);
      } catch {
        // Missing observations never become invented passing checks or log scraping.
        receipt.complete = false;
      }
      return verificationReceiptInput.parse(receipt);
    },
    async diagnoseVerification(
      repo: ForgeRepository,
      runID: number,
      commit: string,
    ): Promise<VerificationDiagnosis> {
      const jobs: VerificationDiagnosis["jobs"] = [];
      try {
        const current = await run(repo, runID, commit);
        if (current.status === "cancelled" || current.status === "skipped")
          return {
            kind: current.status,
            summary: `Verification was ${current.status}. No application defect was established.`,
            jobs,
          };
        const listed = z.array(jobInput).parse(await json(`${path(repo)}/runs/${runID}/jobs`));
        if (!listed.length || listed.some((item) => item.run_id !== runID))
          throw new Error("Verification jobs are unavailable or mismatched");
        if (!terminal.has(current.status) || listed.some((item) => !terminal.has(item.status)))
          return {
            kind: "pending",
            summary: "Waiting for the exact Verification jobs to finish.",
            jobs,
          };
        const failed = listed.filter((item) => item.status === "failure");
        if (current.status !== "failure" || !failed.length || failed.length > 8)
          throw new Error("No bounded failed workflow step was established");
        let executionFailed = false;
        for (const item of failed) {
          const detail = await job(repo, runID, item.id, item.attempt);
          if (detail.status !== "failure")
            return {
              kind: "pending",
              summary: "The Verification job changed while its diagnosis was being read.",
              jobs: [],
            };
          const steps = detail.steps ?? [];
          const last = Math.max(0, ...steps.map((step) => step.number));
          const failure = steps.find(
            (step) => step.status === "failure" && step.number > 0 && step.number < last,
          );
          if (!failure) {
            executionFailed = true;
            jobs.push({
              id: item.id,
              attempt: item.attempt,
              name: excerpt(sanitizeVerificationOutput(item.name, credential), 200),
            });
            continue;
          }
          const diagnostic = await readVerificationDiagnostic(
            await send(
              `${path(repo)}/jobs/${item.id}/logs?attempt=${item.attempt}&step=${failure.number}`,
              { headers: { accept: "text/plain", range: "bytes=0-" } },
            ),
            credential,
          );
          if (!diagnostic.trim()) throw new Error("Failed step output is unavailable");
          jobs.push({
            id: item.id,
            attempt: item.attempt,
            name: excerpt(sanitizeVerificationOutput(item.name, credential), 200),
            step: failure.number,
            stepName: excerpt(sanitizeVerificationOutput(failure.name, credential), 200),
            output: diagnostic,
          });
        }
        return {
          kind: executionFailed ? "execution-failed" : "check-failed",
          summary: executionFailed
            ? "Verification could not execute its checks successfully. Inspect the runner or job setup; no automatic code correction was started."
            : `Verification failed in ${excerpt(jobs.map((item) => `${item.name}: ${item.stepName}`).join("; "), 850)}.`,
          jobs,
        };
      } catch {
        return {
          kind: "unavailable",
          summary:
            "Verification failed, but its exact failed-step diagnosis is unavailable. No automatic code correction was started.",
          jobs: [],
        };
      }
    },
    async readVerificationLog(
      repo: ForgeRepository,
      input: {
        runID: number;
        commit: string;
        jobID: number;
        attempt: number;
        step: number;
        offset: number;
      },
    ) {
      await run(repo, input.runID, input.commit);
      const detail = await job(repo, input.runID, input.jobID, input.attempt);
      if (!detail.steps?.some((step) => step.number === input.step && step.status === "failure"))
        throw new Error("This is not the recorded failed step");
      return output(repo, input.jobID, input.attempt, input.step, input.offset);
    },
  };
}
