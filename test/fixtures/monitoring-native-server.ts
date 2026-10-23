import { mock } from "bun:test";
import { appendFile, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { McpServer, createMcpHandler } from "@modelcontextprotocol/server";
import { z } from "zod";
import { monitoringNativeSource } from "./monitoring-native";

const sourceFile = resolve(process.argv[2] ?? "");
if (!sourceFile.startsWith(resolve(".factory/test-results/monitoring/native") + "/"))
  throw new Error("An owned monitoring source fixture is required");
const source = monitoringNativeSource.parse(JSON.parse(await readFile(sourceFile, "utf8")));
const handler = createMcpHandler(() => {
  const server = new McpServer({ name: "Owned monitoring source", version: "1" });
  server.registerTool(
    "read_issue",
    {
      description: "Read the monitored invoice exception by its exact issue identifier.",
      inputSchema: z.object({ id: z.literal("42").describe("Issue identifier from the alert.") }),
      annotations: { readOnlyHint: true },
    },
    async () => ({
      content: [
        {
          type: "text",
          text: "Synthetic owned incident 42. GET /invoices/missing returns 500 with TypeError: Cannot read properties of undefined (reading 'total'), at invoiceTotal in src/invoice.mjs:3. Reproduction: invoiceTotal('missing') throws. A missing invoice must return null so the existing HTTP handler returns 404. A known invoice must still return total 12. This is application code, not infrastructure. Preserve runtime configuration and dependencies. Add regression coverage for missing and known IDs.",
        },
      ],
    }),
  );
  return server;
});

// Substitute only the external provider in this owned child process. Authentication,
// library review/grants, OpenBao, tool contracts, the real SDK, models, runtime, Git,
// Verification, independent review and Delivery all use the production composition.
const egress = await import("../../apps/factory/src/mcp/network");
const original = { ...egress };
mock.module("../../apps/factory/src/mcp/network", () => ({
  ...original,
  secureMCPFetch: async (input: string | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    if (request.url !== source.endpoint) return original.secureMCPFetch(input, init);
    const authorized = request.headers.get("authorization") === `Bearer ${source.bearer}`;
    const rpc = await request
      .clone()
      .json()
      .catch(() => null);
    await appendFile(
      source.observations,
      `${JSON.stringify({
        authorized,
        method: rpc?.method,
        tool: rpc?.params?.name,
      })}\n`,
      { mode: 0o600 },
    );
    if (!authorized) return new Response(null, { status: 401 });
    return handler.fetch(request);
  },
}));
await import("../../apps/factory/src/server");
