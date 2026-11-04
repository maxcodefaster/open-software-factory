import type { ForgeRepository } from "./forge";

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
