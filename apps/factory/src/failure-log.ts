const MAX_FAILURE_LENGTH = 2000;
const MAX_EVENT_LENGTH = 256;
const MAX_FIELD_LENGTH = 256;
const MAX_KEY_LENGTH = 64;
const MAX_FIELDS = 24;

const secretPatterns: Array<[RegExp, string]> = [
  [/(factory-grant|token|secret|password|signature|api[-_]?key)=([^&\s"']+)/gi, "$1=[redacted]"],
  [/(authorization["']?[ \t]*:[ \t]*["']?)(bearer|basic)[ \t]+[^\s"'\r\n}]+/gi, "$1$2 [redacted]"],
  [/\b(bearer)\s+[A-Za-z0-9._~+/=-]{16,}/gi, "$1 [redacted]"],
  [/(\/\/[^/\s:@]+:)[^@\s/]+@/g, "$1[redacted]@"],
  [/(\bx[-_]api[-_]key"?[ \t]*:[ \t]*")[^"\r\n]*(")/gi, "$1[redacted]$2"],
  [/(\bx[-_]api[-_]key'?[ \t]*:[ \t]*')[^'\r\n]*(')/gi, "$1[redacted]$2"],
  [/(\bx[-_]api[-_]key:[ \t]*)[^\s,;"'\r\n}]+/gi, "$1[redacted]"],
  [/(\b(?:set-)?cookie"?[ \t]*:[ \t]*")[^"\r\n]*(")/gi, "$1[redacted]$2"],
  [/(\b(?:set-)?cookie'?[ \t]*:[ \t]*')[^'\r\n]*(')/gi, "$1[redacted]$2"],
  [/(\b(?:set-)?cookie["']?[ \t]*:[ \t]*\[)[^\]\r\n]*(\])/gi, '$1"[redacted]"$2'],
  [/(\b(?:set-)?cookie:[ \t]*)(?!["'[\r\n])[^\r\n]+/gi, "$1[redacted]"],
];

const reservedKeys = new Set(["timestamp", "level", "event", "cause"]);
const sensitiveKeyPattern =
  /^(?:authorization|cookie|set[-_]?cookie|x[-_]?api[-_]?key|api[-_]?key|password|secret|token|signature|factory[-_]?grant)$/i;

export type LogLevel = "info" | "warn" | "error";

export type LogContext = {
  requestId?: string | null | undefined;
  attemptId?: string | null | undefined;
  changeId?: string | null | undefined;
  workspaceId?: string | null | undefined;
  projectId?: string | null | undefined;
  userId?: string | null | undefined;
  component?: string | null | undefined;
  releaseId?: string | null | undefined;
  sessionId?: string | null | undefined;
  turnId?: string | null | undefined;
  actorId?: string | null | undefined;
  method?: string | null | undefined;
  path?: string | null | undefined;
  status?: number | null | undefined;
  durationMs?: number | null | undefined;
  [key: string]: unknown;
};

type SanitizedValue = string | number | boolean;

function boundText(text: string, maxLength: number): string {
  return text.length > maxLength ? `${text.slice(0, maxLength)}…` : text;
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

function isJsonLogFormat(): boolean {
  const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process
    ?.env;
  return env?.["FACTORY_LOG_FORMAT"]?.trim().toLowerCase() === "json";
}

/** Redacts credentials, tokens, and sensitive header values from log text. */
export function redactSecrets(text: string): string {
  let result = text;
  for (const [pattern, replacement] of secretPatterns)
    result = result.replace(pattern, replacement);
  return result;
}

function sanitizeTextField(text: string, maxLength = MAX_FIELD_LENGTH): string {
  return boundText(redactSecrets(text).replace(/[\r\n]+/g, " "), maxLength);
}

function sanitizeFields(fields?: LogContext): Record<string, SanitizedValue> {
  const sanitized: Record<string, SanitizedValue> = {};
  if (!fields) return sanitized;
  let count = 0;
  for (const [rawKey, value] of Object.entries(fields)) {
    if (count >= MAX_FIELDS) break;
    if (value === undefined || value === null) continue;
    const key = boundText(rawKey.trim().replace(/[\r\n]+/g, " "), MAX_KEY_LENGTH);
    if (!key || reservedKeys.has(key)) continue;
    if (sensitiveKeyPattern.test(key)) {
      sanitized[key] = "[redacted]";
      count++;
      continue;
    }
    if (typeof value === "string") {
      sanitized[key] = sanitizeTextField(value);
      count++;
    } else if (typeof value === "number") {
      if (!Number.isFinite(value)) continue;
      sanitized[key] = value;
      count++;
    } else if (typeof value === "boolean") {
      sanitized[key] = value;
      count++;
    } else if (value instanceof Error) {
      sanitized[key] = boundText(describeFailure(value).replace(/[\r\n]+/g, " "), MAX_FIELD_LENGTH);
      count++;
    } else {
      sanitized[key] = sanitizeTextField(safeStringify(value));
      count++;
    }
  }
  return sanitized;
}

function formatFieldValue(value: SanitizedValue): string {
  if (typeof value !== "string") return String(value);
  return value.length === 0 || /[\s="]/.test(value) ? JSON.stringify(value) : value;
}

function emit(level: LogLevel, line: string): void {
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.info(line);
}

/** A bounded, credential-free description of a failure that keeps its cause chain. */
export function describeFailure(cause: unknown, depth = 0): string {
  if (depth > 3) return "…";
  let text: string;
  if (cause instanceof Error) {
    const frames = (cause.stack ?? "")
      .split("\n")
      .filter((line) => line.trimStart().startsWith("at "))
      .slice(0, 4)
      .join("\n");
    if (/^Failed query:/i.test(cause.message)) {
      const code =
        cause.cause &&
        typeof cause.cause === "object" &&
        "code" in cause.cause &&
        typeof cause.cause.code === "string" &&
        /^[A-Z0-9]{5}$/.test(cause.cause.code)
          ? ` SQLSTATE ${cause.cause.code}`
          : "";
      text = `Database query failed${code}${frames ? `\n${frames}` : ""}`;
    } else {
      text = `${cause.name}: ${cause.message}${frames ? `\n${frames}` : ""}`;
      if (cause.cause !== undefined)
        text += `\ncaused by ${describeFailure(cause.cause, depth + 1)}`;
    }
  } else text = typeof cause === "string" ? cause : safeStringify(cause);
  return boundText(redactSecrets(text), MAX_FAILURE_LENGTH);
}

/** Emits a bounded, credential-free structured JSON or human-readable log entry. */
export function logEvent(
  level: LogLevel,
  event: string,
  fields?: LogContext & { cause?: unknown },
): void {
  const safeEvent = sanitizeTextField(event, MAX_EVENT_LENGTH);
  const sanitized = sanitizeFields(fields);
  const causeText =
    fields !== undefined && fields.cause !== undefined ? describeFailure(fields.cause) : undefined;

  if (isJsonLogFormat()) {
    const entry: Record<string, SanitizedValue> = {
      timestamp: new Date().toISOString(),
      level,
      event: safeEvent,
      ...sanitized,
    };
    if (causeText !== undefined) entry["cause"] = causeText;
    emit(level, JSON.stringify(entry));
    return;
  }

  const pairs = Object.entries(sanitized).map(
    ([key, value]) => `${key}=${formatFieldValue(value)}`,
  );
  const header =
    pairs.length > 0 ? `[factory] ${safeEvent} ${pairs.join(" ")}` : `[factory] ${safeEvent}`;
  emit(level, causeText !== undefined ? `${header}: ${causeText}` : header);
}

export function logFailure(context: string, cause: unknown, meta?: LogContext) {
  logEvent("error", context, meta ? { ...meta, cause } : { cause });
}

/** Replacement for `.catch(() => {})` on work that must not throw but must stay visible. */
export function reportFailure(context: string, meta?: LogContext) {
  return (cause: unknown) => logFailure(context, cause, meta);
}
