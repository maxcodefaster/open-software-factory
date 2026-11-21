import type { ForgeRepository } from "./contracts";

/** Bind a Project URL to this installation's configured Forge transport/public origins and owner. */
export function boundForgeRepositoryFromURL(
  value: string,
  binding: { apiURL: string; publicURL?: string | undefined; owner: string },
  invalid: () => Error = () => new Error("Project repository is outside the configured forge"),
): ForgeRepository {
  // Inspect the original spelling before URL normalizes dot segments, backslashes
  // or control characters into an apparently allowed origin/path.
  const path = /^https?:\/\/([^/?#@%\\\s]+)(\/([\w.-]+)\/([\w.-]+))$/i.exec(value);
  if (
    !path ||
    [...value].some((character) => character.charCodeAt(0) <= 32 || character.charCodeAt(0) === 127)
  )
    throw invalid();
  let url: URL;
  let origins: Set<string>;
  try {
    url = new URL(value);
    origins = new Set([
      new URL(binding.apiURL).origin,
      ...(binding.publicURL ? [new URL(binding.publicURL).origin] : []),
    ]);
  } catch {
    throw invalid();
  }
  const owner = path[3];
  const name = path[4]?.replace(/\.git$/, "");
  if (
    !["http:", "https:"].includes(url.protocol) ||
    !origins.has(url.origin) ||
    url.pathname !== path[2] ||
    owner !== binding.owner ||
    !name ||
    name === "." ||
    name === ".."
  )
    throw invalid();
  return { owner: binding.owner, name };
}

/** Reads the owner and name from a Forge repository URL such as https://forge/owner/name.git. */
export function forgeRepositoryFromURL(
  value: string,
  invalid: () => Error = () => new Error("Project repository is not a Forge repository URL"),
): ForgeRepository {
  const parts = new URL(value).pathname
    .replace(/\.git$/, "")
    .split("/")
    .filter(Boolean);
  const owner = parts.at(-2);
  const name = parts.at(-1);
  if (!owner || !name) throw invalid();
  return { owner, name };
}
