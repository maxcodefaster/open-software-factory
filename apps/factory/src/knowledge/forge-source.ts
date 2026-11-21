import { type ForgeRepository } from "../../../../packages/forge/src/contracts";
import { boundForgeRepositoryFromURL } from "../../../../packages/forge/src/repository";
import { CommandError } from "../command-error";

export function factoryForgeSource(
  value: string,
  apiURL: string,
  allowedOwner: string,
  publicURL?: string,
): ForgeRepository {
  return boundForgeRepositoryFromURL(
    value,
    { apiURL, publicURL, owner: allowedOwner },
    () =>
      new CommandError(
        "forbidden",
        "Project source must belong to the configured Factory Forgejo.",
      ),
  );
}
