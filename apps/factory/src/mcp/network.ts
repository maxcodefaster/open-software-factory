import { lookup } from "node:dns/promises";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import type { FetchLike } from "@modelcontextprotocol/client";
import { mcpEndpoint } from "../../../../packages/conversation-domain/src/mcp-library";

// Public unicast only. Pin the checked address on the actual TLS request, not a
// separate preflight followed by another DNS resolution.
export function publicMCPAddress(value: string): boolean {
  if (isIP(value) === 4) {
    const [a = 0, b = 0, c = 0] = value.split(".").map(Number);
    return !(
      a === 0 ||
      a === 10 ||
      a === 127 ||
      a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && (b === 0 || b === 168 || (b === 88 && c === 99))) ||
      (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
      (a === 203 && b === 0 && c === 113)
    );
  }
  // Accept global unicast, excluding documentation and transition mechanisms.
  if (isIP(value) !== 6) return false;
  const ip = new URL(`https://[${value}]/`).hostname.slice(1, -1);
  const segments = ip.split(":");
  return (
    /^[23]/.test(ip) &&
    !ip.startsWith("2002:") &&
    !ip.startsWith("3fff:") &&
    !(
      segments[0] === "2001" &&
      (Number.parseInt(segments[1] || "0", 16) < 0x200 || segments[1] === "db8")
    )
  );
}

export const secureMCPFetch: FetchLike = async (input, init) => {
  const request = new Request(input instanceof URL ? input.href : input, init);
  const url = new URL(mcpEndpoint.parse(request.url));
  if (url.port && url.port !== "443") throw new Error("MCP endpoints must use HTTPS port 443");
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  const addresses = isIP(hostname)
    ? [{ address: hostname, family: isIP(hostname) }]
    : await lookup(hostname, { all: true, verbatim: true });
  if (!addresses.length || addresses.some((address) => !publicMCPAddress(address.address)))
    throw new Error("MCP endpoints cannot access private, local or reserved networks");
  const pinned = addresses.find((address) => address.family === 4) ?? addresses[0];
  if (!pinned) throw new Error("MCP endpoint has no public address");
  const body = request.body ? Buffer.from(await request.arrayBuffer()) : undefined;
  if (body && body.length > 262144) throw new Error("MCP request is too large");
  return new Promise<Response>((resolve, reject) => {
    const signal = AbortSignal.any([request.signal, AbortSignal.timeout(30_000)]);
    const outgoing = httpsRequest(
      url,
      {
        method: request.method,
        headers: Object.fromEntries(request.headers),
        agent: false,
        family: pinned.family,
        signal,
        lookup: (_host, _options, callback) => callback(null, pinned.address, pinned.family),
      },
      (incoming) => {
        const status = incoming.statusCode ?? 502;
        if (status >= 300 && status < 400) {
          incoming.destroy();
          reject(new Error("MCP redirects are not allowed"));
          return;
        }
        const headers = new Headers();
        for (const [name, value] of Object.entries(incoming.headers))
          if (value !== undefined)
            headers.set(name, Array.isArray(value) ? value.join(", ") : value);
        let bytes = 0;
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            incoming.on("data", (chunk: Buffer) => {
              bytes += chunk.length;
              if (bytes > 2_097_152) {
                incoming.destroy(new Error("MCP response is too large"));
                return;
              }
              controller.enqueue(new Uint8Array(chunk));
            });
            incoming.on("end", () => controller.close());
            incoming.on("error", (error) => controller.error(error));
          },
          cancel() {
            incoming.destroy();
          },
        });
        resolve(
          new Response([204, 205, 304].includes(status) ? null : stream, { status, headers }),
        );
      },
    );
    outgoing.on("error", reject);
    outgoing.end(body);
  });
};
