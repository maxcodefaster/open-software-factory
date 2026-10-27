import { type ActivityNavigation, activityNavigation } from "./activity-navigation";
import { buildCompletionText } from "./build-completion";
import { bounded, readableError } from "./native-errors";
type ActivityStatus = "pending" | "streaming" | "running" | "completed" | "error";

function activityStatus(value: string): ActivityStatus | undefined {
  switch (value) {
    case "pending":
    case "streaming":
    case "running":
    case "completed":
    case "error":
      return value;
    default:
      return undefined;
  }
}

type ProjectToolState = {
  status: string;
  input?: unknown | undefined;
  content?: ReadonlyArray<{ type: string; text?: string | undefined }> | undefined;
  metadata?: Record<string, unknown> | undefined;
};

type ProjectMessageContent = {
  id?: string | undefined;
  type: string;
  text?: string | undefined;
  name?: string | undefined;
  state?: ProjectToolState | undefined;
  time?: { created: number; completed?: number; ran?: number } | undefined;
};

type ProjectMessage = {
  id: string;
  type: string;
  time: { created: number; completed?: number; ran?: number };
  text?: string | undefined;
  metadata?: Record<string, unknown> | undefined;
  content?: ReadonlyArray<ProjectMessageContent> | undefined;
  status?: string | undefined;
  exit?: number | string | undefined;
  output?: { output?: string | undefined } | undefined;
  command?: string | undefined;
};

function isProjectMessage(value: unknown): value is ProjectMessage {
  if (!value || typeof value !== "object") return false;
  if (!("id" in value) || typeof value.id !== "string") return false;
  if (!("type" in value) || typeof value.type !== "string") return false;
  if (!("time" in value) || !value.time || typeof value.time !== "object") return false;
  if (!("created" in value.time) || typeof value.time.created !== "number") return false;
  return !("content" in value) || value.content === undefined || Array.isArray(value.content);
}

export type AgentProjectedMessage = {
  id: string;
  role: "user" | "assistant" | "tool";
  text: string;
  at: number;
  truncated?: boolean;
  activity?: {
    name: string;
    status: ActivityStatus;
    detail?: string;
    truncated?: boolean;
    navigation?: ActivityNavigation;
  };
};

export function navigationMessages(messages: AgentProjectedMessage[], allowed: boolean) {
  if (allowed) return messages;
  return messages.map((message) => {
    const activity = message.activity;
    if (!activity?.navigation) return message;
    return {
      ...message,
      activity: {
        name: activity.name,
        status: activity.status,
        ...(activity.detail !== undefined ? { detail: activity.detail } : {}),
        ...(activity.truncated !== undefined ? { truncated: activity.truncated } : {}),
      },
    };
  });
}

function objectString(value: unknown, key: string) {
  if (!value || typeof value !== "object") return null;
  const candidate = (value as Record<string, unknown>)[key];
  return typeof candidate === "string" && candidate.trim() ? candidate.trim() : null;
}

function toolSummary(name: string, input: unknown) {
  const path = objectString(input, "path") ?? objectString(input, "file");
  const command = objectString(input, "command");
  const query = objectString(input, "query") ?? objectString(input, "pattern");
  if (["write", "edit", "apply_patch"].includes(name) && path) return `Updated ${path}`;
  if (name === "read" && path) return `Read ${path}`;
  if (["bash", "shell"].includes(name) && command) return command;
  if (["grep", "glob", "search"].includes(name) && query) return `Searched for ${query}`;
  return name.replaceAll("_", " ");
}

function toolDetail(state: {
  status: string;
  content?: ReadonlyArray<{ type: string; text?: string | undefined }> | undefined;
  error?: unknown | undefined;
}) {
  const output = state.content
    ?.filter((item) => item.type === "text" && item.text?.trim())
    .map((item) => item.text?.trim())
    .join("\n");
  if (output) return { text: bounded(output, 4_000), truncated: output.length > 4_000 };
  if (state.status === "error" && state.error) {
    const error = readableError(state.error);
    return { text: bounded(error, 1_000), truncated: error.length > 1_000 };
  }
  return null;
}

function isFactoryBootstrapMessage(message: { text: string; metadata?: Record<string, unknown> }) {
  return (
    message.metadata?.["factoryBootstrap"] === true ||
    (message.text.startsWith("Implement the approved ticket: ") &&
      message.text.includes("\nApproved specification:\n") &&
      message.text.endsWith(
        "Do not commit or push; the Factory does that after you finish successfully.",
      ))
  );
}

export function projectMessages(
  messages: unknown,
  admittedInputs?: ReadonlyMap<string, string | null>,
) {
  if (!messages || typeof messages !== "object" || !("data" in messages)) return [];
  if (!Array.isArray(messages.data)) return [];
  return messages.data
    .filter(isProjectMessage)
    .slice(0, 100)
    .reverse()
    .flatMap<AgentProjectedMessage>((message) => {
      if (message.type === "user") {
        if (typeof message.text !== "string") return [];
        const admittedText = admittedInputs?.get(message.id);
        if (admittedText === null) return [];
        if (
          admittedText === undefined &&
          isFactoryBootstrapMessage({
            text: message.text,
            ...(message.metadata ? { metadata: message.metadata } : {}),
          })
        ) {
          return [];
        }
        return [
          {
            id: message.id,
            role: "user",
            text: bounded(admittedText ?? message.text, 8_000),
            at: message.time.created,
          },
        ];
      }
      if (message.type === "assistant") {
        let textOrdinal = 0;
        let toolOrdinal = 0;
        return (message.content ?? []).flatMap<AgentProjectedMessage>((content) => {
          const ordinal =
            content.type === "text" ? textOrdinal++ : content.type === "tool" ? toolOrdinal++ : 0;
          if (content.type === "text" && content.text?.trim()) {
            const text = buildCompletionText(content.text);
            return [
              {
                id: `${message.id}:text:${ordinal}`,
                role: "assistant",
                text: bounded(text, 8_000),
                at: message.time.created,
                ...(text.length > 8_000 ? { truncated: true } : {}),
              },
            ];
          }
          if (content.type === "tool" && content.name && content.state && content.time) {
            const status = activityStatus(content.state.status);
            if (!status) return [];
            const browserPrefix = "factory_browser_browser_";
            const browserAction = content.name.startsWith(browserPrefix)
              ? content.name.slice(browserPrefix.length)
              : undefined;
            const input = status === "streaming" ? null : content.state.input;
            const detail = toolDetail(content.state);
            const summary = toolSummary(browserAction ?? content.name, input);
            const navigation =
              status === "completed"
                ? activityNavigation(content.name, input, content.state.metadata)
                : undefined;
            return [
              {
                id: `${message.id}:tool:${content.id ?? ordinal}`,
                role: "tool",
                text: bounded(summary, 500),
                at: content.time.created,
                activity: {
                  name: browserAction ? "browser" : content.name,
                  status,
                  ...(detail ? { detail: detail.text } : {}),
                  ...(summary.length > 500 || detail?.truncated ? { truncated: true } : {}),
                  ...(navigation ? { navigation } : {}),
                },
              },
            ];
          }
          return [];
        });
      }
      if (message.type === "shell") {
        if (!message.command) return [];
        const status: ActivityStatus =
          message.status === "running"
            ? "running"
            : message.status === "exited" && message.exit === 0
              ? "completed"
              : "error";
        const detail = message.output?.output?.trim();
        return [
          {
            id: message.id,
            role: "tool",
            text: bounded(message.command, 500),
            at: message.time.created,
            activity: {
              name: "shell",
              status,
              ...(detail ? { detail: bounded(detail, 4_000) } : {}),
              ...(message.command.length > 500 || (detail?.length ?? 0) > 4_000
                ? { truncated: true }
                : {}),
            },
          },
        ];
      }
      return [];
    });
}
