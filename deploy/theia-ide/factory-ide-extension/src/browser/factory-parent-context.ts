export async function authorizedFactoryOrigin(
  href: string,
  referrer: string,
  fetcher: (input: URL, init?: RequestInit) => Promise<Response> = globalThis.fetch.bind(
    globalThis,
  ),
): Promise<string | undefined> {
  const location = new URL(href);
  if (!location.pathname.startsWith("/editor/"))
    return referrer ? new URL(referrer).origin : undefined;
  // Grant redemption intentionally suppresses referrers. The authenticated edge owns this origin.
  const response = await fetcher(new URL("__factory/context", new URL("./", location)), {
    credentials: "same-origin",
    cache: "no-store",
  });
  if (!response.ok) throw new Error("Editor context is unavailable");
  const value: unknown = await response.json();
  if (
    typeof value !== "object" ||
    value === null ||
    !("factoryOrigin" in value) ||
    typeof value.factoryOrigin !== "string"
  )
    throw new Error("Editor context is invalid");
  const origin = new URL(value.factoryOrigin);
  if (!["http:", "https:"].includes(origin.protocol) || origin.origin !== value.factoryOrigin)
    throw new Error("Editor origin is invalid");
  return origin.origin;
}
