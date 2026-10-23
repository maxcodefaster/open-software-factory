import { createHash } from "node:crypto";

type ObjectValue = Record<string, unknown>;
function object(value: unknown): ObjectValue {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as ObjectValue)
    : {};
}
function text(...values: unknown[]) {
  for (const value of values)
    if ((typeof value === "string" || typeof value === "number") && String(value).trim())
      return String(value).trim();
  return "";
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object")
    return `{${Object.entries(value)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, value]) => `${JSON.stringify(key)}:${canonical(value)}`)
      .join(",")}}`;
  return JSON.stringify(value) ?? "null";
}
export const monitoringDigest = (value: unknown) =>
  createHash("sha256").update(canonical(value)).digest("hex");

// This removes named secret/user fields and structured HTTP requests, not every
// possible secret in free text. A plain-text request is product feedback.
// Providers must redact data before sending it to a shared Project.
const privateField =
  /(?:password|secret|token|authorization|credential|cookie|api.?key|private.?key)|^(?:headers|request|user|users|email|ip_address|session|env|callback|projectId|userId|connectionId|policyId)$/i;
const transientField =
  /^(?:timestamp|time|date|first_seen|last_seen|firstSeen|lastSeen|count|event_id|eventId|occurred_at|received_at)$/i;
function compact(value: unknown, depth = 0): unknown {
  if (depth > 7) return "[depth limit]";
  if (typeof value === "string") {
    if (/^https?:\/\//i.test(value)) {
      try {
        const url = new URL(value);
        url.username = "";
        url.password = "";
        url.search = "";
        url.hash = "";
        return url.href.slice(0, 2_000);
      } catch {}
    }
    return value.slice(0, 2_000);
  }
  if (typeof value === "number" || typeof value === "boolean" || value === null) return value;
  if (Array.isArray(value)) return value.slice(0, 20).map((item) => compact(item, depth + 1));
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .filter(
          ([key, item]) =>
            (!privateField.test(key) ||
              (key.toLowerCase() === "request" && typeof item === "string")) &&
            !transientField.test(key),
        )
        .slice(0, 50)
        .map(([key, item]) => [key.slice(0, 100), compact(item, depth + 1)]),
    );
  return null;
}
function reference(...values: unknown[]) {
  for (const value of values) {
    if (typeof value !== "string" || value.length > 2_000) continue;
    try {
      const url = new URL(value);
      if (url.protocol !== "https:" || url.username || url.password) continue;
      // Never retain URL query secrets. References are citations, never fetch targets.
      url.search = "";
      url.hash = "";
      return url.href;
    } catch {}
  }
  return null;
}

export type MonitoringSignal = {
  fingerprint: string;
  title: string;
  reference: string | null;
  context: string;
  ignored: boolean;
};

function signal(input: ObjectValue, group: ObjectValue): MonitoringSignal {
  const data = object(input["data"]);
  const event = object(data["event"]);
  const issue = object(data["issue"]);
  const essentials = object(data["essentials"]);
  const labels = object(input["labels"]);
  const annotations = object(input["annotations"]);
  const title = text(
    issue["title"],
    event["title"],
    event["message"],
    input["title"],
    input["event_title"],
    input["alert_title"],
    annotations["summary"],
    essentials["alertRule"],
    labels["alertname"],
    input["AlarmName"],
    input["message"],
    input["text"],
    input["subject"],
    input["task"],
  ).slice(0, 300);
  const state = text(
    input["status"],
    input["state"],
    input["action"],
    input["alert_transition"],
    essentials["monitorCondition"],
    input["NewStateValue"],
    group["status"],
  )
    .toLowerCase()
    .replace(/[\s-]+/g, "_");
  const context = compact({
    summary: text(
      issue["culprit"],
      input["message"],
      input["text"],
      input["description"],
      input["event_msg"],
      event["message"],
      essentials["description"],
      annotations["description"],
      input["AlarmDescription"],
      input["NewStateReason"],
    ),
    issue,
    identity: {
      issue: issue["id"] ?? event["issue_id"] ?? event["groupID"] ?? input["issue_id"],
      alert: input["alert_id"],
      aggregationKey: input["aggregation_key"] ?? input["aggreg_key"] ?? input["agg_key"],
      dedupKey: input["dedup_key"] ?? input["fingerprint"],
      scope: input["alert_scope"],
      alarmArn: input["AlarmArn"],
    },
    exception: event["exception"] ?? input["exception"],
    stacktrace: event["stacktrace"] ?? input["stacktrace"] ?? input["stack"],
    error: input["error"],
    context: input["context"],
    details: input["details"],
    service: input["service"],
    alertContext: data["alertContext"],
    customProperties: data["customProperties"],
    essentials,
    labels,
    annotations,
    payload: compact(input),
  });
  const explicit = text(
    input["fingerprint"],
    input["dedup_key"],
    input["aggregation_key"],
    input["aggreg_key"],
    input["agg_key"],
    input["alert_id"],
    issue["id"],
    event["issue_id"],
    event["groupID"],
    input["issue_id"],
    input["AlarmArn"],
    input["id"],
  );
  const azureIdentity = essentials["alertRule"]
    ? {
        rule: essentials["alertRule"],
        service: essentials["monitoringService"],
        targets: Array.isArray(essentials["alertTargetIDs"])
          ? [...essentials["alertTargetIDs"]].sort()
          : [],
      }
    : null;
  // Event IDs and delivery IDs identify occurrences, not defects. With no
  // incident identity, deliberately coalesce the same title/stack/labels.
  const fingerprint = monitoringDigest(
    explicit
      ? { explicit, scope: text(input["alert_scope"]) }
      : (azureIdentity ?? {
          title,
          labels: compact(labels),
          stack: compact(event["exception"] ?? input["stacktrace"] ?? input["stack"]),
          ...(!issue["id"] &&
          !event["exception"] &&
          !input["stacktrace"] &&
          !input["stack"] &&
          !essentials["alertRule"]
            ? { content: context }
            : {}),
        }),
  );
  const encoded = JSON.stringify(context);
  return {
    fingerprint,
    title: title || "Incoming request",
    reference: reference(
      issue["web_url"],
      issue["permalink"],
      issue["url"],
      event["web_url"],
      event["url"],
      input["url"],
      input["link"],
      input["generatorURL"],
      essentials["investigationLink"],
    ),
    context: encoded.length <= 16_000 ? encoded : `${encoded.slice(0, 15_980)} [truncated]`,
    ignored: /^(?:resolved|resolve|closed|recovered|recovery|ok|no_data)$/.test(state),
  };
}

export function monitoringSignals(value: unknown): MonitoringSignal[] {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Send a JSON object containing the incoming request");
  let input = object(value);
  // SNS confirmation is not an alert. Factory never follows a callback URL.
  if (input["Type"] === "SubscriptionConfirmation" || input["Type"] === "UnsubscribeConfirmation")
    return [];
  if (input["Type"] === "Notification" && typeof input["Message"] === "string") {
    try {
      const message: unknown = JSON.parse(input["Message"]);
      if (!message || typeof message !== "object" || Array.isArray(message))
        throw new Error("Invalid notification");
      input = object(message);
    } catch {
      throw new Error("The notification must contain a JSON alert object");
    }
  }
  if (Array.isArray(input["alerts"])) {
    if (input["alerts"].length > 20) throw new Error("Send at most 20 alerts per webhook request");
    return input["alerts"].map((alert) => {
      if (!alert || typeof alert !== "object" || Array.isArray(alert))
        throw new Error("Each alert must be a JSON object");
      return signal(object(alert), input);
    });
  }
  return [signal(input, {})];
}
