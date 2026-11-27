import { createHash } from "node:crypto";
import { parseSubstrateProjectTemplate } from "#runtime-kubernetes/substrate-project-template";
import type { SourceStartupConfiguration } from "../workspace/source-api";

export type FrozenProjectTemplate = NonNullable<SourceStartupConfiguration["actorTemplate"]>;
export type ProjectConfigurationReader = (
  repository: string,
  revision: string,
  actorTemplatePath: string,
) => Promise<SourceStartupConfiguration>;

export async function nativeProjectConfiguration(
  retained: FrozenProjectTemplate | undefined,
  read: ProjectConfigurationReader | undefined,
  repository: string,
  revision: string,
  path: string,
) {
  if (!retained && !read)
    throw new Error("Native execution requires the normal exact-revision Project reader");
  const frozen = retained ?? (await read?.(repository, revision, path))?.actorTemplate;
  if (!frozen) throw new Error(`Saved ${path} is required for native execution`);
  if (
    frozen.path !== path ||
    createHash("sha256").update(frozen.content).digest("hex") !== frozen.sha256
  )
    throw new Error("Project ActorTemplate version is unconfirmed");
  return { frozen, template: parseSubstrateProjectTemplate(frozen.content) };
}
