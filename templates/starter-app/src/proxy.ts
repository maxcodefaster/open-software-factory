import type { IncomingHttpHeaders } from "node:http";

// Factory strips caller-provided forwarding headers before proxying an App.
// Bind its browser host and path to the same Runtime Attempt, including when
// the public Factory runs behind ordinary wildcard DNS and TLS.
export function appProxyContext(headers: IncomingHttpHeaders | Headers) {
  const header = (name: string) => (headers instanceof Headers ? headers.get(name) : headers[name]);
  const host = header("x-forwarded-host");
  const protocol = header("x-forwarded-proto");
  const prefix = header("x-forwarded-prefix");
  if (
    typeof host !== "string" ||
    !["http", "https"].includes(String(protocol)) ||
    typeof prefix !== "string"
  )
    return;
  const path = prefix.match(
    /^\/runtime\/([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})\/(app|preview\/app(?:-[a-z][a-z0-9-]{0,26})?)$/,
  );
  if (!path?.[1]) return;
  try {
    const origin = new URL(`${protocol}://${host}`);
    if (origin.host !== host || origin.pathname !== "/" || origin.search || origin.hash) return;
    const label = `${path[1].replaceAll("-", "")}-app.runtime.`;
    if (!origin.hostname.startsWith(label) || origin.hostname.length > 253) return;
    const domain = origin.hostname.slice(label.length);
    if (
      !domain.split(".").every((value) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(value)) ||
      (domain !== "localhost" && protocol !== "https")
    )
      return;
    return { origin: origin.origin, basePath: prefix };
  } catch {
    return;
  }
}
