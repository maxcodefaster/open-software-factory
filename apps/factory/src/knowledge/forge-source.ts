import type { ForgeRepository } from "../../../../packages/forge/src/forge";
import { CommandError } from "../command-error";

export function factoryForgeSource(
  value: string,
  apiURL: string,
  allowedOwner: string,
): ForgeRepository {
  const url = new URL(value);
  const forge = new URL(apiURL);
  const parts = url.pathname
    .replace(/\.git$/, "")
    .split("/")
    .filter(Boolean);
  if (
    url.origin !== forge.origin ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    parts.length !== 2 ||
    parts[0] !== allowedOwner ||
    !parts[1] ||
    !/^[\w.-]+$/.test(parts[1])
  )
    throw new CommandError(
      "forbidden",
      "Project source must belong to the configured Factory Forgejo.",
    );
  return { owner: allowedOwner, name: parts[1] };
}
