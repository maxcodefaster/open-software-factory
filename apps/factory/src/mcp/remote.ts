import {
  Client,
  type FetchLike,
  type OAuthClientProvider,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { type MCPTool, mcpTool } from "#conversation-domain/mcp-library";
import { mcpDigest } from "./controller";
import { secureMCPFetch } from "./network";

export function createRemoteMCP(
  endpoint: string,
  authentication?: OAuthClientProvider | { token(): Promise<string | undefined> },
  fetcher: FetchLike = secureMCPFetch,
  signal?: AbortSignal,
) {
  const lifetime = new AbortController();
  const cancellation = signal ? AbortSignal.any([signal, lifetime.signal]) : lifetime.signal;
  const deadline = () => AbortSignal.any([cancellation, AbortSignal.timeout(30_000)]);
  const client = new Client({ name: "Factory", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(endpoint), {
    ...(authentication ? { authProvider: authentication } : {}),
    // OAuth discovery and renewal do not always use the transport's request signal.
    fetch: (input, init) => {
      const signal = init?.signal ? AbortSignal.any([init.signal, cancellation]) : cancellation;
      signal.throwIfAborted();
      return fetcher(input, { ...init, signal });
    },
    requestInit: { redirect: "error" },
    reconnectionOptions: {
      maxRetries: 0,
      initialReconnectionDelay: 1000,
      maxReconnectionDelay: 1000,
      reconnectionDelayGrowFactor: 1,
    },
  });
  return {
    client,
    transport,
    connect: async () => {
      cancellation.throwIfAborted();
      return client.connect(transport, { signal: deadline() });
    },
    close: () => {
      lifetime.abort();
      return client.close();
    },
    async tools(): Promise<MCPTool[]> {
      cancellation.throwIfAborted();
      const tools: MCPTool[] = [];
      let cursor: string | undefined;
      const seen = new Set<string>();
      const catalogueDeadline = deadline();
      let pages = 0;
      do {
        if (++pages > 16) throw new Error("MCP catalogue pagination exceeds its limit");
        const page = await client.listTools(cursor ? { cursor } : undefined, {
          signal: catalogueDeadline,
        });
        for (const tool of page.tools) {
          if (tools.length >= 256 || tools.some((old) => old.name === tool.name))
            throw new Error("MCP tool catalogue exceeds its bound or contains duplicate names");
          tools.push(
            mcpTool.parse({
              name: tool.name,
              description: (tool.description ?? "").slice(0, 8000),
              inputSchema: tool.inputSchema,
              digest: mcpDigest({
                name: tool.name,
                description: tool.description ?? "",
                inputSchema: tool.inputSchema,
                outputSchema: tool.outputSchema,
                annotations: tool.annotations,
              }),
              readOnlyHint: tool.annotations?.readOnlyHint === true,
            }),
          );
        }
        cursor = page.nextCursor;
        if (cursor && seen.has(cursor)) throw new Error("MCP catalogue pagination repeated");
        if (cursor) seen.add(cursor);
      } while (cursor);
      return tools;
    },
  };
}
