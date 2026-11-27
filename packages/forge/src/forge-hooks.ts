import { z } from "zod";
import type { ForgeRepository } from "./contracts";
import {
  ForgeAmbiguousWriteError,
  type ForgeTransport,
  isAmbiguousError,
  repositoryPath,
} from "./forge-http";

const hookResponse = z
  .object({
    id: z.number().int().positive(),
    active: z.boolean(),
    events: z.array(z.string()),
    config: z.record(z.string(), z.string()).optional(),
    url: z.string().optional(),
    branch_filter: z.string().optional(),
  })
  .loose();

export type RepositoryPushHook = {
  id: number;
  active: boolean;
  events: string[];
  targetURL: string;
  branchFilter: string;
};

function pushHookConfig(targetURL: string, secret: string, branch: string) {
  return {
    active: true,
    events: ["push"],
    branch_filter: branch,
    config: { url: targetURL, content_type: "json", secret },
  };
}

export function createForgeHooks(transport: ForgeTransport) {
  return {
    async listPushHooks(repository: ForgeRepository): Promise<RepositoryPushHook[]> {
      const hooks: RepositoryPushHook[] = [];
      for (let page = 1; page <= 20; page++) {
        const values = z
          .array(hookResponse)
          .parse(await transport.json(`${repositoryPath(repository)}/hooks?limit=50&page=${page}`));
        for (const value of values)
          hooks.push({
            id: value.id,
            active: value.active,
            events: value.events,
            targetURL: value.config?.["url"] ?? value.url ?? "",
            branchFilter: value.branch_filter ?? "",
          });
        if (values.length < 50) return hooks;
      }
      throw new Error("Repository hook inventory exceeds the supported limit");
    },
    async createPushHook(
      repository: ForgeRepository,
      targetURL: string,
      secret: string,
      branch: string,
    ) {
      try {
        return hookResponse.parse(
          await transport.jsonBody(`${repositoryPath(repository)}/hooks`, "POST", {
            type: "forgejo",
            ...pushHookConfig(targetURL, secret, branch),
          }),
        ).id;
      } catch (cause) {
        if (isAmbiguousError(cause))
          throw new ForgeAmbiguousWriteError("Push hook create outcome is unknown");
        throw cause;
      }
    },
    async configurePushHook(
      repository: ForgeRepository,
      id: number,
      targetURL: string,
      secret: string,
      branch: string,
    ) {
      return hookResponse.parse(
        await transport.jsonBody(
          `${repositoryPath(repository)}/hooks/${id}`,
          "PATCH",
          pushHookConfig(targetURL, secret, branch),
        ),
      ).id;
    },
  };
}
