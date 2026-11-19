import { createHash } from "node:crypto";
import { z } from "zod";
import { bounded, readableError } from "./native-errors";
import { classifyAgentTurn } from "./turn-outcome";

const messageID = z.string().regex(/^msg_/).max(200);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
export const terminalOutcomeInput = z
  .object({
    version: z.literal(1),
    turnID: z.uuid(),
    attemptID: z.uuid(),
    sessionID: z.string().min(1).max(200),
    promptID: messageID,
    promptDigest: digest,
    assistantID: messageID,
    assistantDigest: digest,
    completed: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    modelRequestEpoch: z.string().regex(/^(0|[1-9][0-9]*)$/),
    shells: z
      .array(
        z
          .object({ id: z.string().min(1).max(200), sessionID: z.string().min(1).max(200) })
          .strict(),
      )
      .max(1_000),
    outcome: z.discriminatedUnion("state", [
      z
        .object({ state: z.literal("succeeded"), summary: z.string().max(2_000).optional() })
        .strict(),
      z.object({ state: z.literal("failed"), error: z.string().max(2_000) }).strict(),
    ]),
  })
  .strict()
  .refine((value) => Buffer.byteLength(JSON.stringify(value)) <= 8_192)
  .refine((value) => new Set(value.shells.map((shell) => shell.id)).size === value.shells.length);
export type TerminalOutcome = z.infer<typeof terminalOutcomeInput>;
export type TerminalInput = {
  turnID: string;
  changeID: string;
  attemptID: string | null;
  sessionID: string;
  promptID: string;
  text: string;
  criteria: number;
  submissionPolicy: "native" | null;
};
type Message = {
  id: string;
  type: string;
  time: { created: number; completed?: number };
  text?: string;
  finish?: string;
  error?: unknown;
  content?: readonly { type: string; text?: string }[];
};

function fingerprint(value: unknown) {
  // Native in-memory and restored JSON can have different property order.
  const encoded = JSON.stringify(value, (_key, item: unknown) =>
    item && typeof item === "object" && !Array.isArray(item)
      ? Object.fromEntries(
          Object.entries(item).sort(([left], [right]) =>
            left < right ? -1 : left > right ? 1 : 0,
          ),
        )
      : item,
  );
  return createHash("sha256").update(encoded).digest("hex");
}

function assistantFingerprint(message: Message) {
  return fingerprint({
    id: message.id,
    created: message.time.created,
    completed: message.time.completed,
    finish: message.finish,
    error: message.error,
    content: message.content,
  });
}

function inputInterval(input: TerminalInput, messages: readonly Message[]) {
  const index = messages.findIndex(
    (message) => message.type === "user" && message.id === input.promptID,
  );
  if (index < 0 || messages[index]?.text !== input.text)
    throw new Error("Recorded terminal input is not identifiable; no inference was repeated");
  const interval = messages.slice(0, index);
  if (interval.some((message) => message.type === "user"))
    throw new Error("A newer native user input prevents terminal cleanup and submission");
  return interval;
}

export function readTerminalOutcome(value: unknown, input: TerminalInput) {
  if (value === null) return null;
  const checkpoint = terminalOutcomeInput.parse(value);
  if (
    checkpoint.turnID !== input.turnID ||
    checkpoint.attemptID !== input.attemptID ||
    checkpoint.sessionID !== input.sessionID ||
    checkpoint.promptID !== input.promptID ||
    checkpoint.promptDigest !== fingerprint(input.text)
  )
    throw new Error("Terminal checkpoint does not match the recorded input and runtime");
  return checkpoint;
}

// Capture only an actually observed terminal assistant, never successful text
// alone. The relay epoch is sampled before native work/history and compared
// under the same Turn lock that serializes provider dispatch.
export function captureTerminalOutcome(
  input: TerminalInput,
  messages: readonly Message[],
  work: {
    sessionsRunning: boolean;
    unknownShell: boolean;
    shells: readonly { id: string; metadata: { sessionID?: string | undefined } }[];
  },
  modelRequestEpoch: string,
) {
  if (work.sessionsRunning || work.unknownShell) return null;
  const outcome = classifyAgentTurn(
    messages.map((message) => ({
      id: message.id,
      type: message.type,
      created: message.time.created,
      ...(message.type === "assistant"
        ? {
            completed: message.time.completed,
            finish: message.finish,
            error: message.error,
            content: message.content,
          }
        : {}),
    })),
    input.promptID,
    false,
    {
      prompt: input.text,
      criteria: input.criteria,
      ...(input.submissionPolicy === "native" ? { policy: "native" as const } : {}),
    },
  );
  if (outcome.state === "pending") return null;
  const assistant = inputInterval(input, messages).find((message) => message.type === "assistant");
  if (!assistant?.time.completed) throw new Error("Terminal assistant identity is unavailable");
  return terminalOutcomeInput.parse({
    version: 1,
    turnID: input.turnID,
    attemptID: input.attemptID,
    sessionID: input.sessionID,
    promptID: input.promptID,
    promptDigest: fingerprint(input.text),
    assistantID: assistant.id,
    assistantDigest: assistantFingerprint(assistant),
    completed: assistant.time.completed,
    modelRequestEpoch,
    shells: work.shells.map((shell) => ({ id: shell.id, sessionID: shell.metadata.sessionID })),
    outcome:
      outcome.state === "failed"
        ? { state: "failed", error: bounded(readableError(outcome.error), 2_000) }
        : outcome,
  });
}

// A checkpoint is not a blanket exception for aborted messages. Its original
// native terminal evidence must remain intact after this exact input, with
// no intervening user input. Later cleanup attempts cannot replace that proof.
export function validateTerminalMessages(
  checkpoint: TerminalOutcome,
  input: TerminalInput,
  messages: readonly Message[],
) {
  readTerminalOutcome(checkpoint, input);
  const assistant = inputInterval(input, messages).find(
    (message) => message.id === checkpoint.assistantID,
  );
  if (
    assistant?.type !== "assistant" ||
    assistant.time.completed !== checkpoint.completed ||
    assistantFingerprint(assistant) !== checkpoint.assistantDigest
  )
    throw new Error("The recorded native terminal assistant changed or is unavailable");
  return checkpoint.outcome.state === "failed"
    ? { state: "failed" as const, error: checkpoint.outcome.error }
    : {
        state: "succeeded" as const,
        ...(checkpoint.outcome.summary !== undefined
          ? { summary: checkpoint.outcome.summary }
          : {}),
      };
}
