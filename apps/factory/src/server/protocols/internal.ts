import { projectDevelopmentAuthorityIn } from "../../access/controller";
import { factoryRequestURL } from "../../request-origin";
import {
  runtimeSourcePath,
  serveRuntimeRepository,
  validRuntimeSourceCapability,
} from "../../runtime/git-http";
import { substrateTicketSourceIn } from "../../runtime/substrate-grant";
import { substratePrebuildSourceIn } from "../../runtime/substrate-prebuild-grant";
import { substrateVerificationSourceIn } from "../../runtime/substrate-verification-grant";
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
      const nativePreservation = url.pathname.match(
        /^\/internal\/substrate-source\/([0-9a-f-]{36})\/preserve$/,
      );
      if (nativePreservation?.[1])
        return workspaceSources.nativePreservation(request, nativePreservation[1]);
      const nativeSource = url.pathname.match(/^\/internal\/substrate-source\/([0-9a-f-]{36})$/);
      if (nativeSource?.[1]) return workspaceSources.nativeRestore(request, nativeSource[1]);
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
        const rows = await database.client<
          Array<{
            repositoryUrl: string;
            substrate: boolean;
            userID: string;
            projectID: string;
            nativeBound: boolean;
            verificationID: string | null;
            isolatedKind: string | null;
          }>
        >`
        SELECT project.repository_url AS "repositoryUrl",attempt.substrate,attempt.created_by AS "userID",attempt.project_id AS "projectID",attempt.verification_id AS "verificationID",attempt.isolated_kind AS "isolatedKind",
          EXISTS(SELECT 1 FROM factory.development_workspace w JOIN factory.substrate_binding b ON b.runtime_attempt_id=attempt.id
            JOIN factory.substrate_workspace p ON p.workspace_id=w.id
            WHERE w.id=attempt.workspace_id AND w.substrate AND w.kind='personal' AND w.owner_user_id=attempt.created_by
              AND p.intent->>'repositoryURL'=project.repository_url
              AND b.actor_uid IS NOT NULL AND NOT b.create_rejected AND b.delete_intended_at IS NULL
              AND NOT EXISTS(SELECT 1 FROM factory.runtime_attempt newer WHERE newer.workspace_id=w.id AND newer.generation>attempt.generation)) AS "nativeBound"
        FROM factory.runtime_attempt attempt
        JOIN factory.project project ON project.id = attempt.project_id
        WHERE attempt.id = ${attemptID}
          AND attempt.state IN ('create-intended', 'starting')
          AND attempt.stop_intended_at IS NULL
      `;
        const repository = rows[0];
        if (!repository) return new Response("Not found", { status: 404 });
        if (repository.substrate) {
          const granted = await database.client
            .begin(async (sql) => {
              if (repository.isolatedKind === "prebuild")
                return (
                  (await substratePrebuildSourceIn(sql, attemptID)) === repository.repositoryUrl
                );
              if (repository.verificationID)
                return (
                  (await substrateVerificationSourceIn(sql, attemptID)) === repository.repositoryUrl
                );
              if (!repository.nativeBound)
                return (
                  (await substrateTicketSourceIn(database, sql, attemptID)) ===
                  repository.repositoryUrl
                );
              await projectDevelopmentAuthorityIn(sql, repository.userID, repository.projectID);
              return true;
            })
            .catch(() => false);
          if (!granted) return new Response("Not found", { status: 404 });
        }
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
