import { expect, test } from "bun:test";
import {
  captureTerminalOutcome,
  readTerminalOutcome,
  type TerminalInput,
  terminalOutcomeInput,
  validateTerminalMessages,
} from "./terminal-outcome";

const input: TerminalInput = {
  turnID: "078c949f-0458-4834-9382-a59268aa360c",
  changeID: "378df2cb-67f5-4cf3-b632-0df4df6bc12a",
  attemptID: "18464305-553e-484b-9383-29d7c6deea66",
  sessionID: "ses_owned",
  promptID: "msg_owned_input",
  text: "Owned exact input",
  criteria: 1,
  submissionPolicy: "native",
};
const final = {
  id: "msg_owned_final",
  type: "assistant",
  time: { created: 2, completed: 3 },
  finish: "stop",
  content: [{ type: "text", text: "Owned finished source and checks" }],
};
const user = { id: input.promptID, type: "user", time: { created: 1 }, text: input.text };
const work = {
  sessionsRunning: false,
  unknownShell: false,
  shells: [{ id: "sh_owned", metadata: { sessionID: input.sessionID } }],
};

function capture() {
  const result = captureTerminalOutcome(input, [final, user], work, "7");
  if (!result) throw new Error("Owned successful terminal evidence was not captured");
  return result;
}

test("the compact checkpoint binds exact native terminal evidence without retaining a transcript", () => {
  const checkpoint = capture();
  expect(checkpoint).toMatchObject({
    turnID: input.turnID,
    promptID: input.promptID,
    assistantID: final.id,
    modelRequestEpoch: "7",
    outcome: { state: "succeeded" },
  });
  expect(JSON.stringify(checkpoint)).not.toContain(input.text);
  expect(JSON.stringify(checkpoint)).not.toContain(final.content[0]?.text ?? "missing");
  expect(readTerminalOutcome(JSON.parse(JSON.stringify(checkpoint)), input)).toEqual(checkpoint);
});

test("a persisted checkpoint, not a global aborted-error rule, preserves success across cleanup", () => {
  const checkpoint = capture();
  const cleanup = {
    id: "msg_cleanup",
    type: "assistant",
    time: { created: 5, completed: 6 },
    finish: "error",
    error: { type: "aborted", message: "Step interrupted" },
  };
  const notification = {
    id: "msg_shell_notification",
    type: "synthetic",
    time: { created: 4 },
    text: "Owned shell was removed",
  };
  expect(
    validateTerminalMessages(JSON.parse(JSON.stringify(checkpoint)), input, [
      cleanup,
      notification,
      final,
      user,
    ]),
  ).toEqual({ state: "succeeded" });
});

for (const error of [
  { type: "aborted", message: "Step interrupted" },
  { type: "provider.internal", message: "Owned provider failure" },
])
  test(`pre-cleanup ${error.type} remains failed`, () => {
    const checkpoint = captureTerminalOutcome(
      input,
      [{ ...final, finish: "error", error }, user],
      work,
      "7",
    );
    expect(checkpoint?.outcome).toEqual({ state: "failed", error: error.message });
  });

test("active inference, unknown shells and later user messages cannot create a checkpoint", () => {
  expect(
    captureTerminalOutcome(input, [final, user], { ...work, sessionsRunning: true }, "7"),
  ).toBeNull();
  expect(
    captureTerminalOutcome(input, [final, user], { ...work, unknownShell: true }, "7"),
  ).toBeNull();
  expect(
    captureTerminalOutcome(
      input,
      [{ ...user, id: "msg_new_user", time: { created: 4 } }, final, user],
      work,
      "7",
    ),
  ).toBeNull();
});

test("a newer native user input or changed/missing final invalidates checkpoint settlement", () => {
  const checkpoint = capture();
  expect(() =>
    validateTerminalMessages(checkpoint, input, [
      { ...user, id: "msg_new_user", time: { created: 4 } },
      final,
      user,
    ]),
  ).toThrow("newer native user input");
  expect(() => validateTerminalMessages(checkpoint, input, [user])).toThrow(
    "changed or is unavailable",
  );
  expect(() =>
    validateTerminalMessages(checkpoint, input, [
      { ...final, error: { type: "provider.internal", message: "Changed original terminal" } },
      user,
    ]),
  ).toThrow("changed or is unavailable");
  expect(() => readTerminalOutcome(checkpoint, { ...input, text: "Different input" })).toThrow(
    "does not match",
  );
  expect(() =>
    readTerminalOutcome(checkpoint, { ...input, attemptID: crypto.randomUUID() }),
  ).toThrow("does not match");
});

test("equivalent restored native JSON property order does not change the terminal proof", () => {
  const checkpoint = capture();
  const reordered = {
    content: final.content.map((part) => ({ text: part.text, type: part.type })),
    finish: final.finish,
    time: { completed: 3, created: 2 },
    type: final.type,
    id: final.id,
  };
  expect(validateTerminalMessages(checkpoint, input, [reordered, user])).toEqual({
    state: "succeeded",
  });
});

test("checkpoint validation rejects extra transcript fields and duplicate shell ownership", () => {
  const checkpoint = capture();
  expect(() => terminalOutcomeInput.parse({ ...checkpoint, transcript: "not retained" })).toThrow();
  expect(() =>
    terminalOutcomeInput.parse({
      ...checkpoint,
      shells: [...checkpoint.shells, ...checkpoint.shells],
    }),
  ).toThrow();
});
