import { and, eq, inArray, isNull } from "drizzle-orm";
import { project, runtimeAttempt } from "#db/schema";
import { factoryRequestURL } from "../../request-origin";
import {
  runtimeSourcePath,
  serveRuntimeRepository,
  validRuntimeSourceCapability,
} from "../../runtime/git-http";
import { substrateWorkspaceSourceIn } from "../../runtime/substrate-grant";
import { substrateIsolatedSourceIn } from "../../runtime/substrate-isolated-grant";
import { substrateVerificationSourceIn } from "../../runtime/substrate-verification-grant";
import { personalGitRepository } from "../../workspace/personal-git";
import type { FactoryApplication } from "../application";

import { protocolFailure } from "./failure";

type InternalServices = Pick<
  FactoryApplication,
  | "buildBrowserEndpoint"
  | "database"
  | "mcpSourceEndpoint"
  | "relayModel"
  | "releaseController"
  | "runtimeEnvironmentEndpoint"
  | "workspaceSources"
  | "factoryOrigin"
>;
export function createInternalProtocol(services: InternalServices) {
  const {
    buildBrowserEndpoint,
    database,
    mcpSourceEndpoint,
    relayModel,
    releaseController,
    runtimeEnvironmentEndpoint,
    workspaceSources,
    factoryOrigin,
  } = services;
  return async (request: Request): Promise<Response> => {
    try {
      const url = factoryRequestURL(request, factoryOrigin);
      const nativeSource = url.pathname.match(/^\/internal\/substrate-source\/([0-9a-f-]{36})$/);
      if (nativeSource?.[1]) return await workspaceSources.nativeRestore(request, nativeSource[1]);
      const publicationCredentials = new URL(request.url).pathname.match(
        /^\/internal\/releases\/([0-9a-f-]{36})\/credentials$/,
      );
      if (publicationCredentials?.[1]) {
        return releaseController
          .credentials(request, publicationCredentials[1])
          .catch(
            () => new Response(null, { status: 503, headers: { "cache-control": "no-store" } }),
          );
      }
      const runtimeEnvironment = url.pathname.match(
        /^\/internal\/runtime-environment\/([0-9a-f-]{36})$/,
      );
      if (runtimeEnvironment?.[1])
        return await runtimeEnvironmentEndpoint(request, runtimeEnvironment[1]);
      const _sourceEvent = url.pathname.match(/^\/api\/wiki\/source-events\/([0-9a-f-]{36})$/);
      const modelRelay = url.pathname.match(
        /^\/internal\/model\/([0-9a-f-]+)\/v1\/(chat\/completions|responses|messages)$/,
      );
      const browserTool = url.pathname.match(
        /^\/internal\/build-browser\/([0-9a-f-]+)\/([0-9a-f-]+)$/,
      );
      if (browserTool?.[1] && browserTool[2])
        return await buildBrowserEndpoint(request, {
          attemptID: browserTool[1],
          turnID: browserTool[2],
        });
      const sourceTool = url.pathname.match(/^\/internal\/mcp\/([0-9a-f-]+)\/([0-9a-f-]+)$/);
      if (sourceTool?.[1] && sourceTool[2])
        return await mcpSourceEndpoint(request, sourceTool[1], sourceTool[2]);
      if (modelRelay) {
        const [, attemptID, suffix] = modelRelay;
        if (!attemptID || !suffix) return new Response("Not found", { status: 404 });
        return await relayModel(request, attemptID, suffix);
      }
      const personalGitSource = url.pathname.match(
        /^\/internal\/personal-git\/([a-f0-9-]{36})\/([a-f0-9]{64})(\/.*)?$/,
      );
      if (personalGitSource?.[1] && personalGitSource[2]) {
        const [, commandID, capability] = personalGitSource;
        if (!validRuntimeSourceCapability(`personal-git:${commandID}`, capability))
          return new Response("Not found", { status: 404 });
        const repository = await personalGitRepository(database, commandID);
        if (!repository) return new Response("Not found", { status: 404 });
        return await serveRuntimeRepository(
          request,
          repository,
          `/internal/personal-git/${commandID}/${capability}`,
        );
      }
      const runtimeSource = url.pathname.match(
        /^\/internal\/runtime-source\/([a-z0-9-]+)\/([0-9a-f]{64})(\/.*)?$/,
      );
      if (runtimeSource) {
        const attemptID = runtimeSource[1];
        const capability = runtimeSource[2];
        if (!attemptID || !capability || !validRuntimeSourceCapability(attemptID, capability))
          return new Response("Not found", { status: 404 });
        const [repository] = await database.db
          .select({
            repositoryUrl: project.repositoryUrl,
            verificationID: runtimeAttempt.verificationId,
            isolatedKind: runtimeAttempt.isolatedKind,
          })
          .from(runtimeAttempt)
          .innerJoin(project, eq(project.id, runtimeAttempt.projectId))
          .where(
            and(
              eq(runtimeAttempt.id, attemptID),
              inArray(runtimeAttempt.state, ["create-intended", "starting"]),
              isNull(runtimeAttempt.stopIntendedAt),
            ),
          )
          .limit(1);
        if (!repository) return new Response("Not found", { status: 404 });
        const granted = await database.client
          .begin(async (sql) => {
            if (repository.isolatedKind === "staging" || repository.isolatedKind === "publication")
              return (await substrateIsolatedSourceIn(sql, attemptID)) === repository.repositoryUrl;
            if (repository.verificationID)
              return (
                (await substrateVerificationSourceIn(sql, attemptID)) === repository.repositoryUrl
              );
            return (
              (await substrateWorkspaceSourceIn(database, sql, attemptID)) ===
              repository.repositoryUrl
            );
          })
          .catch(() => false);
        if (!granted) return new Response("Not found", { status: 404 });
        return await serveRuntimeRepository(
          request,
          repository.repositoryUrl.startsWith("file://")
            ? `file://${runtimeSourcePath(attemptID)}`
            : repository.repositoryUrl,
          `/internal/runtime-source/${attemptID}/${capability}`,
        );
      }
      return new Response("Not found", { status: 404 });
    } catch (cause) {
      return protocolFailure(request, cause);
    }
  };
}
