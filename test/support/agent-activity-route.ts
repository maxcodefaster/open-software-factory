import type { Route } from "@playwright/test";
import { createServer, type ServerResponse } from "node:http";
import type { AgentView } from "../../apps/factory/src/api-contracts";

// Controlled browser fixtures serve the same view through either the status
// read or the new read-only SSE endpoint. Commands still return ordinary JSON.
export function fulfillAgentView(route: Route, options: { json: unknown }) {
  if (!new URL(route.request().url()).pathname.endsWith("/agent/activity"))
    return route.fulfill(options);
  return route.fulfill({
    contentType: "text/event-stream",
    headers: { "cache-control": "no-store" },
    body: `retry: 250\ndata: ${JSON.stringify({ type: "snapshot", view: options.json })}\n\n`,
  });
}

export async function streamedAgentView(initial: AgentView, origin: string) {
  let view = initial;
  let requests = 0;
  const readers = new Set<ServerResponse>();
  const frame = () => `data: ${JSON.stringify({ type: "snapshot", view })}\n\n`;
  const server = createServer((_request, response) => {
    requests++;
    response.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-store",
      "access-control-allow-origin": origin,
      "access-control-allow-credentials": "true",
    });
    readers.add(response);
    response.write(frame());
    response.on("close", () => readers.delete(response));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Owned stream listener missing");
  return {
    url: `http://127.0.0.1:${address.port}/activity`,
    requests: () => requests,
    readers: () => readers.size,
    publish(next: AgentView) {
      view = next;
      for (const response of readers) response.write(frame());
    },
    disconnect() {
      for (const response of readers) response.destroy();
    },
    async dispose() {
      for (const response of readers) response.destroy();
      await new Promise<void>((resolve, reject) =>
        server.close((cause) => (cause ? reject(cause) : resolve())),
      );
    },
  };
}
