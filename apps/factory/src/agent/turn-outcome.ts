import { assessBuildCompletion, type BuildCompletionContract } from "./build-completion";
type TurnMessage = {
  readonly id: string;
  readonly type: string;
  readonly created: number;
  readonly completed?: number;
  readonly finish?: string;
  readonly error?: unknown;
  readonly content?: readonly { readonly type: string; readonly text?: string }[];
};

export function classifyAgentTurn(
  messages: readonly TurnMessage[],
  activeMessageID: string | null,
  sessionRunning: boolean,
  completionContract?: BuildCompletionContract,
) {
  if (!activeMessageID) return { state: "pending" as const };
  const userIndex = messages.findIndex(
    (message) => message.type === "user" && message.id === activeMessageID,
  );
  if (userIndex < 0 || sessionRunning) return { state: "pending" as const };
  // The pinned API returns newest-first messages. Only the interval after this
  // exact input belongs to it; timestamps can tie and are not causal identity.
  const interval = messages.slice(0, userIndex);
  if (interval.some((message) => message.type === "user")) return { state: "pending" as const };
  const assistant = interval.find((message) => message.type === "assistant");
  if (!assistant?.completed) return { state: "pending" as const };
  if (assistant.error || assistant.finish === "error") {
    return { state: "failed" as const, error: assistant.error };
  }
  if (assistant.finish === "stop") {
    const completion = assessBuildCompletion(
      completionContract,
      assistant.content
        ?.filter((part) => part.type === "text")
        .map((part) => part.text ?? "")
        .join("\n") ?? "",
    );
    return completion.ready
      ? {
          state: "succeeded" as const,
          ...(completion.summary ? { summary: completion.summary } : {}),
        }
      : { state: "failed" as const, error: completion.error };
  }
  if (["length", "content-filter", "unknown"].includes(assistant.finish ?? "")) {
    return {
      state: "failed" as const,
      error: `OpenCode stopped with ${assistant.finish}`,
    };
  }
  return { state: "pending" as const };
}
