import { z } from "zod";
import type { SessionLogOutput } from "@opencode/client";
import {
  unknownCounters,
  type UsageCounters,
} from "../../../../packages/conversation-domain/src/usage";
import type { UsageEntry } from "./journal";

const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const tokens = z.object({
  input: count,
  output: count,
  reasoning: count,
  cache: z.object({ read: count, write: count }),
});
export const codingAllowanceDenial =
  "Factory Coding allowance paused subsequent inference. Existing code is retained; resume explicitly after reset or an allowance increase.";
export function openCodeCounters(input: unknown): UsageCounters {
  const parsed = tokens.safeParse(input);
  if (!parsed.success) return unknownCounters();
  const value = parsed.data;
  // OpenCode maps unreported fields to zero. An entirely zero object proves no counters.
  if (!(value.input + value.output + value.reasoning + value.cache.read + value.cache.write))
    return unknownCounters();
  const output = value.output + value.reasoning;
  if (!Number.isSafeInteger(output)) return unknownCounters();
  // OpenCode's output is visible-only; Factory's billing output includes reasoning exactly once.
  return {
    input: value.input,
    output,
    reasoning: value.reasoning,
    cacheRead: value.cache.read,
    cacheWrite: value.cache.write,
  };
}
export function openCodeUsageEntry(event: SessionLogOutput, sessionID: string): UsageEntry | null {
  if (
    event.type === "log.synced" ||
    event.data.sessionID !== sessionID ||
    event.durable.aggregateID !== sessionID
  )
    return null;
  if (
    event.type === "session.step.failed" &&
    event.data.error.status === 403 &&
    event.data.error.message.includes(codingAllowanceDenial)
  )
    return null;
  if (
    event.type !== "session.step.ended" &&
    event.type !== "session.step.failed" &&
    event.type !== "session.usage.recorded"
  )
    return null;
  return {
    eventID: event.id,
    source: event.type === "session.usage.recorded" ? event.data.source : "step",
    outcome:
      event.type === "session.step.failed" ||
      (event.type === "session.step.ended" && event.data.finish === "error")
        ? "failed"
        : "completed",
    counters: openCodeCounters(event.data.tokens),
    occurredAt: new Date(event.created).toISOString(),
  };
}

// Replay is additive only for native consumption events from this exact Session after admission.
// Compaction messages, cumulative Session usage and forked historical messages are never added.
export async function drainOpenCodeUsage(input: {
  sessionID: string;
  after: number;
  log(after: number): AsyncIterable<SessionLogOutput>;
  record(entry: UsageEntry, sequence: number): Promise<void>;
  advance(sequence: number): Promise<void>;
}) {
  let sequence = input.after;
  for await (const event of input.log(input.after)) {
    if (event.type === "log.synced") {
      if (event.aggregateID !== input.sessionID)
        throw new Error("Usage log returned another Session");
      if (event.seq !== undefined) sequence = Math.max(sequence, event.seq);
      await input.advance(sequence);
      return sequence;
    }
    if (event.durable.aggregateID !== input.sessionID || event.data.sessionID !== input.sessionID)
      throw new Error("Usage event returned another Session");
    if (event.durable.seq <= sequence) continue;
    const entry = openCodeUsageEntry(event, input.sessionID);
    if (entry) await input.record(entry, event.durable.seq);
    sequence = event.durable.seq;
  }
  throw new Error("Usage log ended before its replay watermark");
}
