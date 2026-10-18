export class WikiTopicPlanError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WikiTopicPlanError";
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
