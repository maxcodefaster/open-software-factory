import type { createOpenCodeClient } from "./opencode-adapter";

// Only Factory's restricted, turn-bound facades are registered. This is an
// in-memory upstream override, not Project configuration or a generic registry.
const facades = {
  factory_browser: {
    timeout: { startup: 10_000, catalog: 10_000, execution: 245_000 },
    failure: "The native Factory browser tools did not connect before Build dispatch",
  },
  factory_sources: {
    timeout: { startup: 10_000, catalog: 15_000, execution: 35_000 },
    failure: "The admitted MCP source tools did not connect before Build dispatch",
  },
};

async function registerOpenCodeFacade(
  client: ReturnType<typeof createOpenCodeClient>,
  server: keyof typeof facades,
  endpoint: string,
  bearer: string,
) {
  const location = { directory: "/workspace/project" };
  const facade = facades[server];
  await client.experimental.mcp.add(
    {
      server,
      location,
      config: {
        type: "remote",
        url: endpoint,
        headers: { Authorization: `Bearer ${bearer}` },
        oauth: false,
        codemode: false,
        protocol: "legacy",
        timeout: facade.timeout,
      },
    },
    { signal: AbortSignal.timeout(30_000) },
  );
  // OpenCode 2.3.2's SessionContext.select calls McpTool.flush before taking its
  // tool snapshot, including on warm sessions. The public API exposes connection
  // status, not registry readiness; a fixed wait cannot establish the latter.
  const servers = await client.mcp.list({ location }, { signal: AbortSignal.timeout(5_000) });
  if (!servers.data.some((entry) => entry.name === server && entry.status.status === "connected"))
    throw new Error(facade.failure);
}

export function connectOpenCodeBrowser(
  client: ReturnType<typeof createOpenCodeClient>,
  endpoint: string,
  bearer: string,
) {
  return registerOpenCodeFacade(client, "factory_browser", endpoint, bearer);
}

export function connectOpenCodeSources(
  client: ReturnType<typeof createOpenCodeClient>,
  endpoint: string,
  bearer: string,
) {
  return registerOpenCodeFacade(
    client,
    "factory_sources",
    endpoint.replace("/internal/build-browser/", "/internal/mcp/"),
    bearer,
  );
}
