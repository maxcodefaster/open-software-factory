const digestReference = /^[a-zA-Z0-9.:/-]+@sha256:[a-f0-9]{64}$/;

export async function inspectCurrentContainers<T>(
  list: () => Promise<string[]>,
  inspect: (ids: string[]) => Promise<T[]>,
) {
  let pending = await list();
  // IDs are immutable. Reconcile the original snapshot by removing only IDs
  // confirmed gone. Every retry strictly shrinks it, so unrelated container
  // churn cannot make this loop unbounded or bypass a real inspection error.
  while (pending.length) {
    try {
      return await inspect(pending);
    } catch (cause) {
      const current = new Set(await list());
      const remaining = pending.filter((id) => current.has(id));
      if (remaining.length === pending.length) throw cause;
      pending = remaining;
    }
  }
  return [];
}

export function requirePinnedImage(value: unknown) {
  if (typeof value !== "string" || !digestReference.test(value))
    throw new Error(
      "Factory requires an exact image digest; publish the approved runtime images first",
    );
}

export function requireModelConfiguration(environment: Record<string, string | undefined>) {
  for (const key of [
    "FACTORY_MODEL_BASE_URL",
    "FACTORY_MODEL_API_KEY",
    "FACTORY_AGENT_MODEL_ID",
    "FACTORY_PROJECT_AGENT_MODEL",
    "FACTORY_KNOWLEDGE_MODEL",
  ]) {
    const value = environment[key]?.trim();
    if (!value || /^(replace-me|model-id)$/.test(value) || value.includes("provider.example"))
      throw new Error(
        `Configure ${key} in the protected local environment before disposable startup`,
      );
  }
  let url: URL;
  try {
    url = new URL(environment["FACTORY_MODEL_BASE_URL"] ?? "");
  } catch {
    throw new Error("FACTORY_MODEL_BASE_URL must be a valid provider URL");
  }
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !(
      url.protocol === "https:" ||
      (url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname))
    )
  )
    throw new Error(
      "Provider URL must use HTTPS or a loopback test endpoint, without credentials, query or fragment",
    );
}

export function requireComposePins(config: { services: Record<string, { image?: unknown }> }) {
  const names = Object.keys(config.services).sort();
  if (names.join(",") !== "forgejo,postgres,zero-cache")
    throw new Error(
      "Factory local Compose must contain only its pinned PostgreSQL, Forgejo and Zero services",
    );
  for (const service of Object.values(config.services)) requirePinnedImage(service.image);
}
