import { expect, test } from "bun:test";
import {
  browserMcpResult,
  decodeBuildBrowserCall,
  createBuildBrowserEndpoint,
} from "./browser-endpoint";
import { buildBrowserResultInput } from "../../../../packages/conversation-domain/src/browser-tools";
import { verificationToolCatalogue } from "../../../../packages/conversation-domain/src/verification";

test("the fixed MCP facade routes Verification reads with server-owned authority and rejects extra arguments", async () => {
  const turnID = crypto.randomUUID();
  const verificationID = crypto.randomUUID();
  const calls: unknown[] = [];
  const endpoint = createBuildBrowserEndpoint(
    {
      authorize: async (_id: string, bearer: string | null) =>
        bearer === "Bearer owned" ? { session: { turnID }, ownerToken: "owned-lease" } : null,
    } as unknown as Parameters<typeof createBuildBrowserEndpoint>[0],
    undefined,
    undefined,
    undefined,
    {
      tools: async (id) => {
        expect(id).toBe(turnID);
        return verificationToolCatalogue;
      },
      call: async (...args) => {
        calls.push(args);
        return { content: [{ type: "text", text: "bounded failed-step output" }] };
      },
    },
  );
  async function rpc(method: string, params: unknown, bearer = "Bearer owned") {
    return endpoint(
      new Request("https://factory.invalid/internal/build-browser/owned", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: bearer },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      }),
      "owned",
    );
  }
  const listed = await (await rpc("tools/list", {})).json();
  expect(
    listed.result.tools.some((tool: { name: string }) => tool.name === "verification_read"),
  ).toBe(true);
  const arguments_ = { verificationId: verificationID, jobId: 1, attempt: 2, step: 1 };
  const result = await (
    await rpc("tools/call", { name: "verification_read", arguments: arguments_ })
  ).json();
  expect(result.result.content[0].text).toBe("bounded failed-step output");
  expect(calls).toEqual([
    [turnID, "owned-lease", { name: "verification_read", arguments: { ...arguments_, offset: 0 } }],
  ]);
  const rejected = await (
    await rpc("tools/call", {
      name: "verification_read",
      arguments: { ...arguments_, url: "https://foreign.invalid" },
    })
  ).json();
  expect(rejected.error.code).toBe(-32602);
  expect(
    (
      await rpc(
        "tools/call",
        { name: "verification_read", arguments: arguments_ },
        "Bearer foreign",
      )
    ).status,
  ).toBe(403);
  expect(calls).toHaveLength(1);
});

test("native MCP metadata does not become tool arguments or Factory authority", () => {
  const call = { name: "browser_screenshot" as const, arguments: {} };
  expect(
    decodeBuildBrowserCall({
      ...call,
      _meta: { "ai.opencode/sessionID": "ses_foreign_metadata", progressToken: "owned-progress" },
    }),
  ).toEqual(call);
  for (const value of [
    { ...call, sessionID: "ses_other" },
    { ...call, arbitrary: true },
    { ...call, arguments: { url: "https://example.invalid" } },
    { ...call, arguments: { script: "return 1" } },
    { ...call, _meta: "not-an-object" },
    { name: "evaluate_script", arguments: {} },
  ])
    expect(decodeBuildBrowserCall(value)).toBeNull();
});

test("native tool content includes bounded trusted checkout provenance beside the unchanged image", () => {
  const context = {
    sessionId: crypto.randomUUID(),
    turnId: crypto.randomUUID(),
    runtimeAttemptId: crypto.randomUUID(),
    generation: 1,
    app: "app",
    headCommit: "a".repeat(40),
    workingTreeModified: true,
    observedAt: new Date().toISOString(),
  };
  const image = { type: "image" as const, mimeType: "image/jpeg" as const, data: "owned-image" };
  const result = browserMcpResult({
    structuredContent: context,
    content: [{ type: "text", text: "x".repeat(32_768) }, image],
  });
  expect(buildBrowserResultInput.safeParse(result).success).toBe(true);
  expect(result.structuredContent).toEqual(context);
  const text = result.content[0];
  if (text?.type !== "text") throw new Error("Missing visible browser context");
  expect(text.text).toContain(JSON.stringify(context));
  expect(text.text.length).toBe(32_768);
  expect(text.text).toEndWith("[Factory truncated this App observation]");
  expect(result.content[1]).toEqual(image);
  const multilingual = browserMcpResult({
    structuredContent: context,
    content: [{ type: "text", text: "界".repeat(12_000) }],
  }).content[0];
  if (multilingual?.type !== "text") throw new Error("Missing multilingual observation");
  expect(Buffer.byteLength(multilingual.text)).toBeLessThanOrEqual(32_768);
  expect(multilingual.text).not.toContain("\ufffd");
  const error = { isError: true, content: [{ type: "text" as const, text: "No App action ran" }] };
  expect(browserMcpResult(error)).toBe(error);
});
