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

export function appRuntimeOrigin(factoryOrigin: string, attemptID: string, channel: string) {
  if (
    !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(attemptID) ||
    !/^(?:ide|app(?:-[a-z][a-z0-9-]{0,26})?)$/.test(channel)
  )
    throw new Error("Invalid runtime App identity");
  const identity = attemptID.replaceAll("-", "");
  // Named Apps use all 32 UUID digits and their complete channel in one
  // DNS label, including the longest admitted 31-character channel.
  return isolatedRuntimeOrigin(
    factoryOrigin,
    channel.startsWith("app-") ? `${identity}${channel}` : `${identity}-${channel}`,
  );
}

export function runtimeAppOriginRoute(factoryOrigin: string, url: URL) {
  const suffix = new URL(isolatedRuntimeOrigin(factoryOrigin, "request")).hostname.slice(7);
  if (!url.hostname.endsWith(suffix)) return undefined;
  const label = url.hostname.slice(0, -suffix.length);
  const match = label.match(/^([a-f0-9]{32})(?:-(app)|(app-[a-z][a-z0-9-]{0,26}))$/);
  if (!match?.[1]) return undefined;
  const hex = match[1];
  const attemptID = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  const channel = match[2] ?? match[3];
  if (!channel || url.origin !== appRuntimeOrigin(factoryOrigin, attemptID, channel))
    return undefined;
  return { attemptID, channel };
}
