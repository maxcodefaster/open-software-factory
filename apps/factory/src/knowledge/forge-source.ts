import type { ForgeRepository } from "../../../../packages/forge/src/forge";
import { CommandError } from "../command-error";

export function factoryForgeSource(
  value: string,
  apiURL: string,
  allowedOwner: string,
  publicURL?: string,
): ForgeRepository {
  const url = new URL(value);
  const origins = new Set([
    new URL(apiURL).origin,
    ...(publicURL ? [new URL(publicURL).origin] : []),
  ]);
  const path = /^\/([\w.-]+)\/([\w.-]+)$/.exec(url.pathname);
  const owner = path?.[1];
  const name = path?.[2]?.replace(/\.git$/, "");
  if (
    !["http:", "https:"].includes(url.protocol) ||
    !origins.has(url.origin) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    owner !== allowedOwner ||
    !name
  )
    throw new CommandError(
      "forbidden",
      "Project source must belong to the configured Factory Forgejo.",
    );
  return { owner: allowedOwner, name };
}
