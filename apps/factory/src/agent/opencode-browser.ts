import type { createOpenCodeClient } from "./opencode-client";

// Only Factory's restricted, turn-bound facade is registered. This is an
// in-memory upstream override, not Project configuration or a generic registry.
export async function connectOpenCodeBrowser(
  client: ReturnType<typeof createOpenCodeClient>,
  endpoint: string,
  bearer: string,
) {
  const location = { directory: "/workspace/project" };
  await client.mcp.add(
    {
      server: "factory_browser",
      location,
      config: {
        type: "remote",
        url: endpoint,
        headers: { Authorization: `Bearer ${bearer}` },
        oauth: false,
        codemode: false,
        protocol: "legacy",
        timeout: { startup: 10_000, catalog: 10_000, execution: 245_000 },
      },
    },
    { signal: AbortSignal.timeout(30_000) },
  );
  const servers = await client.mcp.list({ location }, { signal: AbortSignal.timeout(5_000) });
  if (
    !servers.data.some(
      (server) => server.name === "factory_browser" && server.status.status === "connected",
    )
  )
    throw new Error("The native Factory browser tools did not connect before Build dispatch");
}
