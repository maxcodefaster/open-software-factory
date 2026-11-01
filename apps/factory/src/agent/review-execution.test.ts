import { expect, test } from "bun:test";
import {
  executionInputChunk,
  projectExecutionActions,
  sanitizeExecutionInput,
} from "./review-execution";

test("execution inputs remove protected values and standard credential syntax before chunking", () => {
  const input = {
    command:
      "curl http://admin:private-url-password@localhost/path?token=private-query-token -H 'Authorization: Bearer private-bearer' -H 'Ocp-Apim-Subscription-Key: private-apim' && API_KEY='private-assignment' pnpm test",
    nested: { password: "private-property", ordinary: "known-runtime-secret" },
  };
  const safe = sanitizeExecutionInput(input, ["known-runtime-secret"]);
  for (const secret of [
    "private-url-password",
    "private-query-token",
    "private-bearer",
    "private-apim",
    "private-assignment",
    "private-property",
    "known-runtime-secret",
  ])
    expect(safe.text).not.toContain(secret);
  expect(safe.redacted).toBe(true);
  expect(safe.text).toContain("pnpm test");
  expect(safe.text).toContain("localhost");
  expect(safe.omitted).toBe(false);
  let restored = "";
  let offset = 0;
  for (;;) {
    const chunk = executionInputChunk(safe.text, offset, 19);
    restored += chunk.input;
    if (chunk.nextInputOffset === null) break;
    offset = chunk.nextInputOffset;
  }
  expect(restored).toBe(safe.text);
});

test("execution input chunks preserve UTF-8 and expose bounded, advancing offsets", () => {
  const value = "ä🙂".repeat(4_000);
  let offset = 0;
  let restored = "";
  for (;;) {
    const chunk = executionInputChunk(value, offset, 1_024);
    expect(Buffer.byteLength(chunk.input)).toBeLessThanOrEqual(1_024);
    expect(chunk.input).not.toContain("\ufffd");
    restored += chunk.input;
    if (chunk.nextInputOffset === null) break;
    expect(chunk.nextInputOffset).toBeGreaterThan(offset);
    offset = chunk.nextInputOffset;
  }
  expect(restored).toBe(value);
});

test("native action projection retains IDs and failure states but omits prose, outputs and patch bodies", () => {
  const page = {
    data: [
      { id: "prompt", type: "user", text: "private-prompt" },
      {
        id: "message",
        type: "assistant",
        content: [
          { type: "reasoning", text: "private-reasoning" },
          {
            id: "shell",
            type: "tool",
            name: "shell",
            state: {
              status: "error",
              input: { command: "pnpm test" },
              content: [{ text: "private-native-output" }],
              error: "private-native-error",
            },
          },
          {
            id: "patch",
            type: "tool",
            name: "patch",
            state: {
              status: "completed",
              input: { patchText: "*** Update File: src/app.ts\n+private-patch-body" },
            },
          },
          {
            id: "fill",
            type: "tool",
            name: "factory_browser_browser_fill",
            state: { status: "completed", input: { ref: "field", value: "private-typed-value" } },
          },
          { type: "tool", name: "unknown tool", state: {} },
        ],
      },
    ],
    cursor: { next: "next-native-page" },
  };
  const projected = projectExecutionActions(page, []);
  expect(projected.actions).toHaveLength(3);
  expect(projected.actions[0]).toMatchObject({
    messageID: "message",
    partID: "shell",
    tool: "shell",
    state: "error",
  });
  expect(projected.actions[0]?.inputSHA256).toMatch(/^[a-f0-9]{64}$/);
  expect(projected.actions[1]?.input).toContain("src/app.ts");
  expect(projected.actions[2]?.inputOmitted).toBe(true);
  expect(JSON.stringify(projected)).not.toContain("private-");
  expect(projected.unclassified).toBe(1);
  expect(projected.nextCursor).toBe("next-native-page");
});

test("candidate action history discloses missing timestamps and excludes later implementation", () => {
  const action = (id: string, time?: { created: number; completed: number }) => ({
    id,
    type: "tool",
    name: "shell",
    state: { status: "completed", input: { command: `echo ${id}` } },
    ...(time ? { time } : {}),
  });
  const projected = projectExecutionActions(
    {
      data: [
        {
          id: "owned",
          type: "assistant",
          content: [
            action("candidate", { created: 1, completed: 2 }),
            action("later", { created: 4, completed: 5 }),
            action("unknown"),
          ],
        },
      ],
      cursor: {},
    },
    [],
    3,
  );
  expect(projected.actions.map((item) => item.partID)).toEqual(["candidate"]);
  expect(projected.unclassified).toBe(1);
  expect(projected.laterActions).toBe(1);
});

test("credential properties and keys themselves cannot bypass exact-value redaction", () => {
  const safe = sanitizeExecutionInput(
    {
      apiKey: "private-property",
      "opaque-configuration-value": "ordinary",
    },
    ["opaque-configuration-value"],
  );
  expect(safe.text).not.toContain("private-property");
  expect(safe.text).not.toContain("opaque-configuration-value");
  expect(safe.text).toContain("ordinary");
  expect(safe.redacted).toBe(true);
});

test("overlapping protected values are fully masked without rewriting redaction markers", () => {
  const safe = sanitizeExecutionInput("prefix abcde suffix", ["a", "abcde", "D"]);
  expect(safe.text).toBe('"prefix <REDACTED> suffix"');
});
