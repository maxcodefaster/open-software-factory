import { factoryRequestURL } from "../../request-origin";
import {
  runtimeSourcePath,
  serveRuntimeRepository,
  validRuntimeSourceCapability,
} from "../../runtime/git-http";
import { personalGitRepository } from "../../workspace/personal-git";
import type { FactoryApplication } from "../application";

import { protocolFailure } from "./failure";

type InternalServices = Pick<
  FactoryApplication,
  | "buildBrowserEndpoint"
  | "database"
  | "mcpSourceEndpoint"
  | "projectPreparation"
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
    projectPreparation,
    relayModel,
    releaseController,
    runtimeEnvironmentEndpoint,
    workspaceSources,
    factoryOrigin,
  } = services;
  return async (request: Request): Promise<Response> => {
    try {
      const url = factoryRequestURL(request, factoryOrigin);
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
        return runtimeEnvironmentEndpoint(request, runtimeEnvironment[1]);
      const projectImage = url.pathname.match(/^\/internal\/project-image\/([0-9a-f-]{36})$/);
      if (projectImage?.[1]) return projectPreparation.endpoint(request, projectImage[1]);
      const _sourceEvent = url.pathname.match(/^\/api\/wiki\/source-events\/([0-9a-f-]{36})$/);
      const sourceRepository = url.pathname.match(
        /^\/internal\/workspace-source\/([0-9a-f-]{36})\/([1-9][0-9]*)\/([0-9a-f]{64})(?:\/|$)/,
      );
      if (sourceRepository?.[1] && sourceRepository[2] && sourceRepository[3]) {
        const prefix = `/internal/workspace-source/${sourceRepository[1]}/${sourceRepository[2]}/${sourceRepository[3]}`;
        return workspaceSources.repository(
          request,
          sourceRepository[1],
          sourceRepository[2],
          sourceRepository[3],
          prefix,
        );
      }
      const modelRelay = url.pathname.match(
        /^\/internal\/model\/([0-9a-f-]+)\/v1\/(chat\/completions|responses|messages)$/,
      );
      const browserTool = url.pathname.match(
        /^\/internal\/build-browser\/([0-9a-f-]+)\/([0-9a-f-]+)$/,
      );
      if (browserTool?.[1] && browserTool[2])
        return buildBrowserEndpoint(request, { attemptID: browserTool[1], turnID: browserTool[2] });
      const sourceTool = url.pathname.match(/^\/internal\/mcp\/([0-9a-f-]+)\/([0-9a-f-]+)$/);
      if (sourceTool?.[1] && sourceTool[2])
        return mcpSourceEndpoint(request, sourceTool[1], sourceTool[2]);
      if (modelRelay) {
        const [, attemptID, suffix] = modelRelay;
        if (!attemptID || !suffix) return new Response("Not found", { status: 404 });
        return relayModel(request, attemptID, suffix);
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
        return serveRuntimeRepository(
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
        const rows = await database.client<Array<{ repositoryUrl: string }>>`
        SELECT project.repository_url AS "repositoryUrl"
        FROM factory.runtime_attempt attempt
        JOIN factory.project project ON project.id = attempt.project_id
        WHERE attempt.id = ${attemptID}
          AND attempt.state IN ('create-intended', 'starting')
          AND attempt.stop_intended_at IS NULL
      `;
        const repository = rows[0];
        if (!repository) return new Response("Not found", { status: 404 });
        return serveRuntimeRepository(
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
