import { z } from "zod";

const report = z.strictObject({
  status: z.enum(["ready", "incomplete", "blocked"]),
  summary: z.string().trim().min(1).max(1_000),
  criteria: z
    .array(
      z.strictObject({
        criterion: z.number().int().positive(),
        evidence: z.string().trim().min(1).max(1_000),
      }),
    )
    .max(100),
  checks: z
    .array(
      z.strictObject({
        command: z.string().trim().min(1).max(1_000),
        passed: z.boolean(),
      }),
    )
    .max(32),
  remaining: z.array(z.string().trim().min(1).max(1_000)).max(100),
});

const contract = /^Factory Build completion report v1: criteria=(\d+)$/gm;
const reportBlock = /^```factory-build-result\r?\n([\s\S]*?)\r?\n```[ \t]*$/gm;
export type BuildCompletionContract = { prompt: string; criteria: number };

export function buildCompletionText(text: string) {
  const blocks = [...text.matchAll(reportBlock)];
  const [block] = blocks;
  if (blocks.length !== 1 || !block) return text;
  const offset = block.index ?? 0;
  if (text.slice(offset + block[0].length).trim()) return text;
  try {
    const value = report.safeParse(JSON.parse(block[1] ?? ""));
    if (!value.success) return text;
    return text.slice(0, offset).trim() || [value.data.summary, ...value.data.remaining].join("\n");
  } catch {
    return text;
  }
}

export function buildCompletionInstructions(criteria: number) {
  return [
    `Factory Build completion report v1: criteria=${criteria}`,
    "Keep using your native tools until the approved work and normal repository checks are finished. A final answer ends execution; it is not a progress checkpoint. Do not invent a turn time or token limit.",
    "Before finishing, inspect the real component integration and current diff. Cover every approved acceptance criterion and the current correction request. Do not count an unused module or a changed test environment as proof of completion.",
    "Use the repository's normal check command without environment overrides that hide failures. For UI work inspect the declared App with Factory's browser, including its console and screenshot, and report any inspection failure.",
    "If a genuine blocker prevents progress, identify it and preserve the checkout. Do not claim readiness or successful checks you did not run. Partial implementation is incomplete, not ready.",
    "End your final answer with exactly one fenced factory-build-result JSON block. Its fields are status (ready, incomplete or blocked), summary, criteria (one {criterion,evidence} per approved criterion, numbered from 1), checks (actual {command,passed} results), and remaining (unfinished items or blockers).",
    "criterion is an integer index, not the criterion text. JSON shape, with example descriptions to replace with actual evidence and all approved criteria to include:",
    JSON.stringify({
      status: "ready",
      summary: "Describe the actual result.",
      criteria: [{ criterion: 1, evidence: "Describe the actual observation for criterion 1." }],
      checks: [{ command: "The exact normal check command you ran.", passed: true }],
      remaining: [],
    }),
    "Use ready only when all criteria and the correction request are satisfied, at least one normal check has passed, no check failed, and remaining is empty. This report is an agent claim; it does not replace independent Verification or human approval.",
  ].join("\n");
}

export function assessBuildCompletion(
  completion: BuildCompletionContract | undefined,
  text: string,
) {
  // Frozen admissions without this contract keep their original semantics.
  // Reconnect must not impose new instructions on already dispatched work.
  if (!completion || ![...completion.prompt.matchAll(contract)].length)
    return { ready: true as const };
  const blocks = [...text.matchAll(reportBlock)];
  const [block] = blocks;
  if (blocks.length !== 1 || !block || text.slice((block.index ?? 0) + block[0].length).trim())
    return {
      ready: false as const,
      error:
        "Implementation incomplete: the agent ended without one final completion report. Source is retained; nothing was submitted.",
    };
  let value: unknown;
  try {
    value = JSON.parse(block[1] ?? "");
  } catch {
    value = null;
  }
  const outcome = report
    .pick({ status: true, summary: true, remaining: true })
    .loose()
    .safeParse(value);
  if (outcome.success && outcome.data.status !== "ready")
    return {
      ready: false as const,
      error:
        `Implementation ${outcome.data.status}: ${outcome.data.summary} ${outcome.data.remaining.join(" ")}`.slice(
          0,
          2_000,
        ),
    };
  const result = report.safeParse(value);
  if (!result.success)
    return {
      ready: false as const,
      error:
        "Implementation incomplete: the agent's completion report was invalid. Source is retained; nothing was submitted.",
    };
  const evidence = result.data;
  // Coverage comes from the immutable approved revision, never numbers quoted
  // in Project context or lower-priority Skill advertisements in the prompt.
  const count = completion.criteria;
  const indices = new Set(evidence.criteria.map((item) => item.criterion));
  if (
    !Number.isSafeInteger(count) ||
    count < 1 ||
    indices.size !== count ||
    evidence.criteria.length !== count ||
    evidence.criteria.some((item) => item.criterion > count) ||
    !evidence.checks.length ||
    evidence.checks.some((check) => !check.passed) ||
    evidence.remaining.length
  )
    return {
      ready: false as const,
      error:
        "Implementation incomplete: readiness requires evidence for every approved criterion, passing checks and no unfinished items. Source is retained; nothing was submitted.",
    };
  return { ready: true as const, summary: evidence.summary };
}
