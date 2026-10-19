import { describe, expect, test } from "bun:test";
import { classifyAgentTurn, projectMessages } from "./controller";
import { agentMessageSchema } from "../api-contracts";

describe("Change Agent turn state", () => {
  const activeUser = { id: "message-new", type: "user", created: 200 };

  test("does not reuse an older completed turn", () => {
    expect(
      classifyAgentTurn(
        [
          activeUser,
          { id: "assistant-old", type: "assistant", created: 100, completed: 150, finish: "stop" },
        ],
        activeUser.id,
        false,
      ),
    ).toEqual({ state: "pending" });
  });

  test("equal timestamps do not make an older assistant belong to the new input", () => {
    expect(
      classifyAgentTurn(
        [
          activeUser,
          {
            id: "assistant-old",
            type: "assistant",
            created: activeUser.created,
            completed: 220,
            finish: "stop",
          },
        ],
        activeUser.id,
        false,
      ),
    ).toEqual({ state: "pending" });
  });

  test("another newer input prevents settling the recorded prompt's outcome", () => {
    expect(
      classifyAgentTurn(
        [
          {
            id: "assistant-other",
            type: "assistant",
            created: 220,
            completed: 230,
            finish: "stop",
          },
          { id: "user-other", type: "user", created: 210 },
          activeUser,
        ],
        activeUser.id,
        false,
      ),
    ).toEqual({ state: "pending" });
  });

  test("waits while OpenCode still owns the turn", () => {
    expect(
      classifyAgentTurn(
        [
          {
            id: "assistant-new",
            type: "assistant",
            created: 210,
            completed: 220,
            finish: "stop",
          },
          activeUser,
        ],
        activeUser.id,
        true,
      ),
    ).toEqual({ state: "pending" });
  });

  test("accepts a completed stop response", () => {
    expect(
      classifyAgentTurn(
        [
          {
            id: "assistant-new",
            type: "assistant",
            created: 210,
            completed: 220,
            finish: "stop",
          },
          activeUser,
        ],
        activeUser.id,
        false,
      ),
    ).toEqual({ state: "succeeded" });
  });

  test("a normal native finish cannot submit an explicitly incomplete implementation", () => {
    expect(
      classifyAgentTurn(
        [
          {
            id: "assistant-new",
            type: "assistant",
            created: 210,
            completed: 220,
            finish: "stop",
            content: [
              {
                type: "text",
                text: [
                  "The state module is written, but integration and tests are unfinished.",
                  "```factory-build-result",
                  JSON.stringify({
                    status: "incomplete",
                    summary: "Integration and deferred-response tests are unfinished.",
                    criteria: [],
                    checks: [],
                    remaining: ["Wire the component and run the deferred-response regressions."],
                  }),
                  "```",
                ].join("\n"),
              },
            ],
          },
          activeUser,
        ],
        activeUser.id,
        false,
        { prompt: "Factory Build completion report v1: criteria=2", criteria: 2 },
      ),
    ).toMatchObject({
      state: "failed",
      error: expect.stringContaining("Integration and deferred-response tests are unfinished"),
    });
  });

  test("reports a completed provider error", () => {
    const error = { message: "model rejected the request" };
    expect(
      classifyAgentTurn(
        [
          {
            id: "assistant-new",
            type: "assistant",
            created: 210,
            completed: 220,
            finish: "error",
            error,
          },
          activeUser,
        ],
        activeUser.id,
        false,
      ),
    ).toEqual({ state: "failed", error });
  });
});

describe("Change Agent activity projection", () => {
  test("native browser activity keeps its identity without putting its namespace in the compact label", () => {
    const [message] = projectMessages({
      data: [
        {
          id: "assistant_native",
          type: "assistant",
          time: { created: 1 },
          content: [
            {
              id: "call_snapshot",
              type: "tool",
              name: "factory_browser_browser_screenshot",
              state: { status: "completed" },
              time: { created: 1 },
            },
          ],
        },
      ],
    });
    expect(message).toMatchObject({
      id: "assistant_native:tool:call_snapshot",
      text: "screenshot",
      activity: { name: "browser", status: "completed" },
    });
  });
  test("tool identities and text slots survive inserted reasoning and tool reordering", () => {
    const text = { type: "text", text: "Working" };
    const tool = {
      type: "tool",
      id: "native_call",
      name: "read",
      state: { status: "running", input: { path: "owned.ts" } },
      time: { created: 2 },
    };
    const project = (content: unknown[]) =>
      projectMessages({
        data: [{ id: "assistant_owned", type: "assistant", time: { created: 1 }, content }],
      });
    const before = project([text, tool]);
    const after = project([{ type: "reasoning", text: "Thinking" }, tool, text]);
    expect(before.map((part) => part.id).sort()).toEqual(after.map((part) => part.id).sort());
    expect(after.find((part) => part.role === "tool")?.id).toBe("assistant_owned:tool:native_call");
  });
  test("uses exact admitted human messages rather than injected Skill and browser instructions", () => {
    const messages = projectMessages(
      {
        data: [
          {
            id: "steer",
            type: "user",
            text: "Keep the dashboard.\n\nInjected internal context",
            time: { created: 2 },
          },
          {
            id: "bootstrap",
            type: "user",
            text: "Internal implementation instructions",
            time: { created: 1 },
          },
        ],
      },
      new Map([
        ["bootstrap", null],
        ["steer", "Keep the dashboard."],
      ]),
    );
    expect(messages).toEqual([{ id: "steer", role: "user", text: "Keep the dashboard.", at: 2 }]);
  });
  test("pending native tool activity remains readable and unknown states are not published", () => {
    const projected = projectMessages({
      data: [
        {
          id: "assistant-pending",
          type: "assistant",
          time: { created: 1 },
          content: [
            {
              type: "tool",
              name: "read",
              state: { status: "pending", input: { path: "src/version.txt" } },
              time: { created: 1 },
            },
            { type: "tool", name: "read", state: { status: "unrecognized" }, time: { created: 2 } },
          ],
        },
      ],
    });
    expect(agentMessageSchema.array().parse(projected)).toEqual([
      {
        id: "assistant-pending:tool:0",
        role: "tool",
        text: "Read src/version.txt",
        at: 1,
        activity: { name: "read", status: "pending" },
      },
    ]);
  });
  test("hides the internal Build bootstrap while retaining user-authored steering", () => {
    const messages = projectMessages({
      data: [
        {
          id: "user-steer",
          type: "user",
          time: { created: 220 },
          text: "Keep the existing API compatible.",
        },
        {
          id: "user-bootstrap",
          type: "user",
          time: { created: 200 },
          text: [
            "Implement the approved ticket: Hide bootstrap prompts",
            "",
            "Keep internal handoff context out of the visible chat.",
            "",
            "Approved specification:",
            '{"summary":"Hide bootstrap prompts"}',
            "",
            "Work only in the current checkout. Run the repository's local checks. Do not commit or push; the Factory does that after you finish successfully.",
          ].join("\n"),
        },
      ],
    });

    expect(messages).toEqual([
      {
        id: "user-steer",
        role: "user",
        text: "Keep the existing API compatible.",
        at: 220,
      },
    ]);
  });

  test("keeps the useful build-step details without exposing raw tool input", () => {
    const messages = projectMessages({
      data: [
        {
          id: "assistant-1",
          type: "assistant",
          time: { created: 200, completed: 240 },
          content: [
            {
              type: "tool",
              id: "tool-write",
              name: "write",
              state: {
                status: "completed",
                input: { path: "src/version.txt", content: "secret source body" },
                content: [{ type: "text", text: "Wrote 6 bytes" }],
              },
              time: { created: 210, completed: 220 },
            },
            {
              type: "tool",
              id: "tool-check",
              name: "bash",
              state: {
                status: "running",
                input: { command: "bun test" },
                metadata: {},
              },
              time: { created: 225, ran: 226 },
            },
          ],
        },
      ],
    });

    expect(messages).toEqual([
      {
        id: "assistant-1:tool:tool-write",
        role: "tool",
        text: "Updated src/version.txt",
        at: 210,
        activity: {
          name: "write",
          status: "completed",
          detail: "Wrote 6 bytes",
        },
      },
      {
        id: "assistant-1:tool:tool-check",
        role: "tool",
        text: "bun test",
        at: 225,
        activity: {
          name: "bash",
          status: "running",
        },
      },
    ]);
    expect(JSON.stringify(messages)).not.toContain("secret source body");
  });
});
