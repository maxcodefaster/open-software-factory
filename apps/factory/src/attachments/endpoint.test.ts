import { expect, test } from "bun:test";
import { createBuildBrowserEndpoint } from "../agent/browser-endpoint";
import { attachmentToolCatalogue } from "../../../../packages/conversation-domain/src/attachments";

test("native attachment calls strip MCP progress metadata without accepting extra authority arguments", async () => {
  const id = crypto.randomUUID();
  const calls: unknown[] = [];
  const endpoint = createBuildBrowserEndpoint(
    {
      authorize: async (_id, authorization) =>
        authorization === "Bearer owned"
          ? {
              session: {
                id,
                ordinal: 1,
                turnID: id,
                changeID: id,
                attemptID: id,
                generation: 1,
                agentSessionID: "ses_owned",
                ownerID: id,
                state: "active" as const,
              },
              ownerToken: "owned",
            }
          : null,
      authorizeRuntime: async () => null,
      call: async () => {
        throw new Error("No browser action");
      },
    },
    undefined,
    undefined,
    {
      tools: () => attachmentToolCatalogue,
      discover: async () => {},
      call: async (turnID, token, call) => {
        calls.push({ turnID, token, call });
        return { content: [{ type: "text", text: "Owned attachment" }] };
      },
    },
  );
  const request = (args: unknown) =>
    new Request("http://owned/fixed", {
      method: "POST",
      headers: { authorization: "Bearer owned", "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "attachment_read",
          arguments: args,
          _meta: { progressToken: 7 },
        },
      }),
    });
  const accepted = await (await endpoint(request({ id }), id)).json();
  expect(accepted.result.content[0].text).toBe("Owned attachment");
  expect(calls).toHaveLength(1);
  const rejected = await (await endpoint(request({ id, ownerToken: "forged" }), id)).json();
  expect(rejected.error.code).toBe(-32602);
  expect(calls).toHaveLength(1);
});
