export function serveFactory<T>(
  hostname: string,
  options: Parameters<typeof Bun.serve<T>>[0] & { unix?: never },
) {
  const primaryHost = hostname === "localhost" ? "127.0.0.1" : hostname;
  const primary = Bun.serve<T>({ ...options, hostname: primaryHost });
  const port = primary.port;
  if (port === undefined) {
    primary.stop(true);
    throw new Error("Factory requires a TCP listener");
  }
  const companionHost =
    primaryHost === "127.0.0.1" || primaryHost === "0.0.0.0"
      ? "::1"
      : primaryHost === "::1"
        ? "127.0.0.1"
        : undefined;
  try {
    return companionHost
      ? [primary, Bun.serve<T>({ ...options, hostname: companionHost, port })]
      : [primary];
  } catch (error) {
    primary.stop(true);
    throw error;
  }
}
