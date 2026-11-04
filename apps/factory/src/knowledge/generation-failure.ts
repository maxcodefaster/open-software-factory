import { modelProbeFailure } from "../models/probe";
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
    // A Forge or storage HTTP refusal is not a model failure. Only the native
    // provider error may select these static, content-free diagnostics.
    if ("name" in current && current.name === "AI_APICallError") {
      const status = "statusCode" in current ? current.statusCode : undefined;
      if (typeof status === "number" && status >= 500 && status <= 599)
        return "The Wiki provider could not complete its request because of a server error. Factory did not automatically repeat the request. Saved pages are retained.";
      switch (modelProbeFailure(current)) {
        case "invalid-credentials":
          return "The Wiki provider rejected its configured credentials. Check the model connection. Saved pages are retained.";
        case "model-denied":
          return "The Wiki model is not available on the configured connection or access was refused. Saved pages are retained.";
        case "rate-limited":
          return "The Wiki provider rate limit was reached. Saved pages are retained. Retry the update when capacity is available.";
        case "unsupported":
          return "The Wiki provider rejected the request for the configured model. Check the model connection and selected model. Saved pages are retained.";
      }
    }
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

export type StructuredFailure = {
  kind: "truncated" | "empty" | "invalid" | "malformed";
  /** Zod issue paths and codes only, never the model's text. */
  issues: string[];
  chars?: number;
};

/**
 * Why a structured result was refused. A cut-off answer (finish reason length) and an empty one
 * (the whole output budget spent before any JSON) need a larger budget and a shorter answer,
 * not another identical request.
 */
export function structuredFailure(cause: unknown): StructuredFailure {
  const issues: string[] = [];
  let kind: StructuredFailure["kind"] = "malformed";
  let chars: number | undefined;
  let current = cause;
  for (let depth = 0; depth < 8 && current && typeof current === "object"; depth++) {
    const record = current as Record<string, unknown>;
    const id = record["id"];
    const details = record["details"];
    if (details && typeof details === "object") {
      const value = (details as Record<string, unknown>)["value"];
      if (typeof value === "string") chars ??= value.length;
    }
    if (id === "STRUCTURED_OUTPUT_TRUNCATED") kind = "truncated";
    else if (id === "STRUCTURED_OUTPUT_OBJECT_UNDEFINED" && kind === "malformed") kind = "empty";
    else if (id === "STRUCTURED_OUTPUT_SCHEMA_VALIDATION_FAILED" && kind === "malformed")
      kind = "invalid";
    const zodIssues = record["issues"];
    if (Array.isArray(zodIssues) && !issues.length) {
      if (kind === "malformed") kind = "invalid";
      for (const issue of zodIssues.slice(0, 6)) {
        const item = issue as { path?: unknown; code?: unknown };
        const path = Array.isArray(item.path) ? item.path.join(".") : "";
        issues.push(`${path || "result"}:${String(item.code ?? "invalid")}`);
      }
    }
    // The SDK error lists each failed path in its text; keep the paths and drop the messages.
    const message = record["message"];
    if (typeof message === "string" && !issues.length && kind === "invalid")
      for (const match of message.matchAll(/^- (\S+?): (\S+(?: \S+){0,3})/gm))
        if (issues.length < 6) issues.push(`${match[1]}:${match[2]?.slice(0, 40)}`);
    current = record["cause"];
  }
  // No object at all reaches validation as one root-level type error: the model spent its
  // output budget before writing any JSON.
  if (kind === "invalid" && issues.length === 1 && issues[0] === "result:invalid_type")
    kind = "empty";
  return { kind, issues, ...(chars === undefined ? {} : { chars }) };
}

export function describeStructuredFailure(failure: StructuredFailure) {
  return `${failure.kind}${failure.chars === undefined ? "" : ` chars=${failure.chars}`}${
    failure.issues.length ? ` issues=${failure.issues.join(",")}` : ""
  }`;
}
