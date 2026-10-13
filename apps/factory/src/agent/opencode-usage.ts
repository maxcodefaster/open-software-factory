import { z } from "zod";
import {
  type TurnUsage,
  unavailableTurnUsage,
} from "../../../../packages/conversation-domain/src/turn-usage";

const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const tokensInput = z.object({
  input: count,
  output: count,
  reasoning: count,
  cache: z.object({ read: count, write: count }),
});
type Message = {
  id: string;
  type: string;
  time: { created: number; completed?: number };
  tokens?: unknown;
};

// Pinned OpenCode messages are newest first. Never use a Session-wide total for a Turn.
export function observeOpenCodeUsage(messages: readonly Message[], promptID: string): TurnUsage {
  const boundary = messages.findIndex(
    (message) => message.id === promptID && message.type === "user",
  );
  if (boundary < 0) return unavailableTurnUsage();
  const newerInput = messages
    .slice(0, boundary)
    .findLastIndex((message) => message.type === "user");
  const interval = messages.slice(newerInput + 1, boundary);
  // Title and compaction have separate upstream accounting and are not included here.
  const assistants = interval.filter((message) => message.type === "assistant");
  const counts = assistants.flatMap((message) => {
    if (!message.time.completed) return [];
    const parsed = tokensInput.safeParse(message.tokens);
    // OpenCode also initializes usage to zero before any provider observation.
    if (
      !parsed.success ||
      !Object.values(parsed.data.cache)
        .concat(parsed.data.input, parsed.data.output, parsed.data.reasoning)
        .some((value) => value > 0)
    )
      return [];
    return [parsed.data];
  });
  if (!counts.length) return unavailableTurnUsage();
  const sum = (read: (tokens: z.infer<typeof tokensInput>) => number) => {
    const total = counts.reduce((total, tokens) => total + read(tokens), 0);
    return Number.isSafeInteger(total) ? total : null;
  };
  return {
    source: "opencode-provider",
    coverage: counts.length === assistants.length ? "complete" : "partial",
    inputTokens: sum((tokens) => tokens.input),
    outputTokens: sum((tokens) => tokens.output),
    reasoningTokens: sum((tokens) => tokens.reasoning),
    cacheReadTokens: sum((tokens) => tokens.cache.read),
    cacheWriteTokens: sum((tokens) => tokens.cache.write),
    observedAt: new Date().toISOString(),
  };
}
