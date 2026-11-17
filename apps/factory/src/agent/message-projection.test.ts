import { expect, test } from "bun:test";
import { projectMessages } from "./message-projection";

function projectToolError(name: string, error: unknown) {
  return projectMessages({
    data: [
      {
        id: "assistant-browser",
        type: "assistant",
        time: { created: 1 },
        content: [
          {
            id: "browser-open",
            type: "tool",
            name,
            state: { status: "error", error },
            time: { created: 2 },
          },
          { type: "text", text: "The browser tool failed; I can still respond." },
        ],
      },
    ],
  });
}

test("browser_open transport failure does not blame a model provider that kept responding", () => {
  const [tool, assistant] = projectToolError("factory_browser_browser_open", "fetch failed");
  expect(tool).toMatchObject({
    id: "assistant-browser:tool:browser-open",
    role: "tool",
    text: "open",
    activity: {
      name: "browser",
      status: "error",
      detail:
        "Factory could not confirm the browser tool result. Check the browser connection and inspect the App before another UI action. Do not replay an unconfirmed UI mutation.",
    },
  });
  expect(tool?.activity?.detail).not.toContain("model provider");
  expect(assistant).toMatchObject({
    role: "assistant",
    text: "The browser tool failed; I can still respond.",
  });
});

test("native browser MCP connection errors have safe inspection guidance", () => {
  for (const error of [
    new Error("TypeError: fetch failed"),
    { message: "MCP connection failure" },
    { data: { message: "MCP error -32000: Connection closed" } },
    {
      type: "tool.execution",
      message:
        'MCP tool "browser_open" on server "factory_browser" failed: ECONNRESET: The socket connection was closed unexpectedly.',
    },
    "Failed to fetch",
    "Not connected",
  ]) {
    const [tool] = projectToolError("factory_browser_browser_open", error);
    const detail = tool?.activity?.detail;
    expect(detail).toContain("browser tool");
    expect(detail).toContain("inspect the App before another UI action");
    expect(detail).toContain("Do not replay an unconfirmed UI mutation");
    expect(detail).not.toContain("model provider");
    expect(detail).not.toContain("then retry");
    expect(detail).not.toContain("MCP");
  }
});

test("other tool transport and status failures do not inherit provider blame or leak diagnostics", () => {
  for (const name of ["factory_browser_browser_open", "source_read"]) {
    for (const error of [
      "fetch failed https://user:private-password@tools.invalid/?token=private-token",
      "MCP connection failure Authorization: Bearer private-token",
      "401 Incorrect API key provided: sk-private-key",
      "HTTP 429 Too Many Requests https://tools.invalid/?token=private-token",
      "insufficient_quota: private-account",
      "HTTP 503 service unavailable private-account",
      "maximum context length: private-prompt",
    ]) {
      const [tool] = projectToolError(name, error);
      const detail = tool?.activity?.detail;
      expect(detail).toContain(
        name === "source_read" ? "the tool result" : "the browser tool result",
      );
      expect(detail).not.toContain("model provider");
      expect(detail).not.toContain("private-");
      expect(detail).not.toContain("https://");
      expect(detail).not.toContain("sk-");
      expect(tool?.activity?.status).toBe("error");
    }
  }
});

test("tool errors retain authority, stop and unconfirmed-outcome guidance", () => {
  for (const [error, detail] of [
    [
      "Browser Build authority changed before dispatch",
      "The work changed while this was running. Check its current status, then try again.",
    ],
    [
      "Browser no longer owns this Build execution",
      "The work changed while this was running. Check its current status, then try again.",
    ],
    [
      "Factory Coding allowance paused subsequent inference. Existing code is retained; resume explicitly after reset or an allowance increase.",
      "The Coding allowance is used up. Your code is kept. Resume after the allowance resets or is raised.",
    ],
    [
      "MCP tool namespace collision",
      "Two connected tools have the same name. Disable one of them in Settings.",
    ],
    ["Browser tools preparation was stopped", "Browser tools preparation was stopped"],
    [
      "Browser recovery storage is unavailable. Unconfirmed requests are retained.",
      "Browser recovery storage is unavailable. Unconfirmed requests are retained.",
    ],
    [
      "Browser inspection was not confirmed. Do not replay a UI mutation without checking the App; start a new authorized turn if its browser has ended.",
      "Browser inspection was not confirmed. Do not replay a UI mutation without checking the App; start a new authorized turn if its browser has ended.",
    ],
    [
      "Inspect a fresh browser_snapshot after the failed interaction before issuing another UI action. Do not replay an unconfirmed mutation.",
      "Inspect a fresh browser_snapshot after the failed interaction before issuing another UI action. Do not replay an unconfirmed mutation.",
    ],
    ["Patch failed at line 500", "Patch failed at line 500"],
  ]) {
    for (const name of ["factory_browser_browser_open", "source_read"]) {
      const [tool] = projectToolError(name, error);
      expect(tool?.activity?.detail).toBe(detail);
    }
  }
});
