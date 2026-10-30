import { isStructuredOutputFailure } from "../project-agent/structured-output";

export class WikiHumanEditConflict extends Error {
  constructor() {
    super("Wiki generation overlaps human text edits");
    this.name = "WikiHumanEditConflict";
  }
}

export class WikiStructuredResultError extends Error {
  constructor() {
    super("Structured output validation failed for the Wiki result");
    this.name = "WikiStructuredResultError";
  }
}

export class WikiTopicPlanError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WikiTopicPlanError";
  }
}

export class WikiTopicCoverageError extends WikiTopicPlanError {
  constructor(issues: readonly string[]) {
    super(`Wiki topic plan omits essential reader coverage: ${issues.join("\n")}`);
    this.name = "WikiTopicCoverageError";
  }
}

export class WikiTopicQualityError extends Error {
  constructor(
    readonly slug: string,
    readonly issues: readonly string[],
  ) {
    super("Wiki topic failed bounded quality checks");
    this.name = "WikiTopicQualityError";
  }
}

export class WikiSourceEvidenceError extends Error {
  constructor(paths: readonly string[]) {
    super(`Research cites unread source: ${paths.slice(0, 8).join(", ")}`);
    this.name = "WikiSourceEvidenceError";
  }
}

// These are Factory-owned failures. Never publish model prose, provider errors,
// source paths, request bodies or credentials as a generation diagnostic.
export function wikiGenerationFailureMessage(cause: unknown, fallback: string) {
  if (cause instanceof WikiHumanEditConflict)
    return "A Wiki update overlaps human edits. That page was not overwritten. Review its text before retrying.";
  if (cause instanceof WikiStructuredResultError || isStructuredOutputFailure(cause))
    return "The Wiki result did not match its required format. Saved pages are retained; retry the update.";
  if (cause instanceof WikiTopicCoverageError)
    return "The Wiki plan did not cover essential reader guidance. Saved pages are retained; retry the update.";
  if (cause instanceof WikiTopicPlanError)
    return "The Wiki topic plan references unavailable source or pages. Saved pages are retained; retry the update.";
  if (cause instanceof WikiTopicQualityError)
    return "A Wiki draft did not pass source and quality checks. Saved pages are retained; retry the update.";
  if (cause instanceof WikiSourceEvidenceError)
    return "Wiki research cited source it had not inspected. Saved pages are retained; retry the update.";
  let current = cause;
  for (let depth = 0; depth < 8 && current && typeof current === "object"; depth++) {
    if ("name" in current && current.name === "ModelExecutionBoundError")
      return "The Wiki update reached its configured model execution bounds. No additional provider request was started. Saved pages are retained.";
    current = "cause" in current ? current.cause : undefined;
  }
  return fallback;
}

export function rejectedWikiStructuredResult(cause: unknown): unknown {
  if (!isStructuredOutputFailure(cause) || !cause || typeof cause !== "object") return undefined;
  const details = "details" in cause ? cause.details : undefined;
  const value =
    details && typeof details === "object" && "value" in details ? details.value : undefined;
  // Match the existing per-step input bound. Do not truncate a rejected result
  // or let diagnostics bypass the next model step's normal byte guard.
  if (typeof value !== "string" || Buffer.byteLength(value) > 1024 * 1024) return undefined;
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}
