export function isolatedRuntimeOrigin(factoryOrigin: string, label: string) {
  const origin = new URL(factoryOrigin);
  if (
    !["http:", "https:"].includes(origin.protocol) ||
    origin.username ||
    origin.password ||
    origin.search ||
    origin.hash ||
    !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)
  )
    throw new Error("Invalid isolated runtime origin");
  const local =
    ["127.0.0.1", "localhost", "[::1]"].includes(origin.hostname) ||
    origin.hostname.endsWith(".localhost");
  const domain = local ? "runtime.localhost" : `runtime.${origin.hostname}`;
  origin.hostname = `${label}.${domain}`;
  if (origin.hostname.length > 253) throw new Error("Runtime hostname exceeds the DNS limit");
  return origin.origin;
}

export function appRuntimeOrigin(factoryOrigin: string, attemptID: string, channel: "app" | "ide") {
  return isolatedRuntimeOrigin(factoryOrigin, `${attemptID.replaceAll("-", "")}-${channel}`);
}
