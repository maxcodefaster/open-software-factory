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
export type BuildCompletionContract = { prompt: string; criteria: number; policy?: "native" };

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
  if (!Number.isSafeInteger(criteria) || criteria < 1 || criteria > 100)
    throw new Error("Build completion requires between 1 and 100 approved criteria");
  return [
    `Factory Build completion report v1: criteria=${criteria}`,
    "Keep using your native tools until the approved work and normal repository checks are finished. A final answer ends execution; it is not a progress checkpoint. Do not invent a turn time or token limit.",
    "Before finishing, inspect the real component integration and current diff. Cover every approved acceptance criterion and the current correction request. Do not count an unused module or a changed test environment as proof of completion.",
    "Use the repository's normal check command without environment overrides that hide failures. For UI work inspect the declared App with Factory's browser, including its console and screenshot, and report any inspection failure.",
    "Exercise the changed user workflow in that browser. A landing or sign-in screen alone does not verify a feature behind it. Use exactly owned synthetic accounts and records where the workflow needs them; do not use unrelated user data. Check the approved interactions, empty/error states and any required keyboard or narrow layout, then read a screenshot of the changed screen. Distinguish browser-observed behavior from source inspection and automated test results in the criterion evidence.",
    "Fixable findings in the approved code, including minor UI or console issues, are work for your available native tools, not a genuine blocker. Fix them now, rerun affected checks and inspect again instead of ending incomplete with a to-do that you can carry out. Keep unrelated non-blocking advisories separate from acceptance; do not expand scope solely to clear every console message.",
    "If a genuine blocker prevents progress, identify it and preserve the checkout. Do not claim readiness or successful checks you did not run. Partial implementation is incomplete, not ready.",
    "End your final answer with exactly one fenced factory-build-result JSON block. Its fields are status (ready, incomplete or blocked), summary, criteria (one {criterion,evidence} per approved criterion, numbered from 1), checks (actual {command,passed} results), and remaining (unfinished items or blockers).",
    "criterion is the one-based position in the approved specification's acceptanceCriteria array, not a new breakdown of the work. Do not split, merge, reorder or renumber criteria, even when one approved item contains several requirements. Cover those requirements together in that item's evidence.",
    `Use exactly ${criteria} criterion entries, numbered 1 through ${criteria}. Replace every evidence placeholder in this exact-shape template with actual observations:`,
    JSON.stringify({
      status: "ready",
      summary: "Describe the actual result.",
      criteria: Array.from({ length: criteria }, (_, index) => ({
        criterion: index + 1,
        evidence: `Describe the actual observation for approved criterion ${index + 1}.`,
      })),
      checks: [{ command: "The exact normal check command you ran.", passed: true }],
      remaining: [],
    }),
    "Use ready only when all criteria and the correction request are satisfied, at least one normal check has passed on the final code, no check is still failing, and remaining is empty. Report the latest result of each check after fixing earlier failures. This report is an agent claim; it does not replace independent Verification or human approval.",
  ].join("\n");
}

export function buildGoalInstructions(criteria: number) {
  if (!Number.isSafeInteger(criteria) || criteria < 1 || criteria > 100)
    throw new Error("Build goal requires between 1 and 100 approved criteria");
  return [
    `Factory Build goal v1: criteria=${criteria}`,
    "Your goal is to satisfy the approved specification and the current correction request in this checkout. Treat every approved acceptance criterion as part of that goal, without adding unrelated work.",
    "Before editing, read the checkout's root and applicable nested AGENTS.md files with your normal tools. Project configuration discovery is disabled; absent automatic instructions are not proof that the repository has none.",
    "Use your native planning tools when useful to keep track of implementation and verification. Continue using native tools until the work and normal repository checks are finished or a genuine blocker prevents progress. Do not invent a turn time or token limit.",
    "Before finishing, inspect the current diff and actual component integration. An unused module or a test environment override that hides failures does not satisfy the goal. Fix findings within the approved scope and rerun the affected checks.",
    "For UI changes exercise the changed workflow in the declared App using Factory's browser. A landing or sign-in screen alone does not verify a feature behind it. Use exactly owned synthetic accounts and records, check required account transitions, empty/error states, keyboard behavior and narrow layout, inspect the console and read a screenshot of the changed screen.",
    "If blocked, preserve the checkout and clearly describe the actual blocker and unfinished work. Do not claim checks or browser observations that did not happen.",
    "Finish with an ordinary concise summary of what changed, what you actually tested, and anything unfinished. No JSON completion form is required. Your native final answer ends this attempt; it is not a progress checkpoint.",
    "Do not commit, push, approve or merge. Factory submits changed source for independent exact-commit Verification after native execution settles. Submission is not acceptance of the goal or human Delivery approval.",
  ].join("\n");
}

export function assessBuildCompletion(
  completion: BuildCompletionContract | undefined,
  text: string,
) {
  // "ready" here means eligible for submission, never acceptance or Delivery.
  // Native-goal admissions have no report contract. Historical admissions keep
  // their frozen interpretation; reconnect must not change dispatched work.
  if (completion?.policy === "native") return { ready: true as const };
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
  const reasons: string[] = [];
  if (!Number.isSafeInteger(count) || count < 1 || count > 100)
    reasons.push("the approved criterion count is invalid");
  else {
    const missing = Array.from({ length: count }, (_, index) => index + 1).filter(
      (index) => !indices.has(index),
    );
    if (missing.length) reasons.push(`missing evidence for criteria ${missing.join(", ")}`);
    if (indices.size !== evidence.criteria.length)
      reasons.push("criterion evidence contains duplicate numbers");
    if (evidence.criteria.some((item) => item.criterion > count))
      reasons.push("criterion evidence includes numbers outside the approved specification");
  }
  if (!evidence.checks.length) reasons.push("no passing repository check was reported");
  const failing = evidence.checks.filter((check) => !check.passed);
  if (failing.length)
    reasons.push(`checks still failing: ${failing.map((check) => check.command).join(", ")}`);
  if (evidence.remaining.length) reasons.push(`unfinished work: ${evidence.remaining.join("; ")}`);
  if (reasons.length)
    return {
      ready: false as const,
      error: `Implementation incomplete: ${reasons.join(". ").slice(0, 1_800)}. Source is retained; nothing was submitted.`,
    };
  return { ready: true as const, summary: evidence.summary };
}
