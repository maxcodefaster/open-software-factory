import type { createDatabase } from "#db/client";
import { createForgejoAccess } from "#forge/access";
import { createAccessController } from "../access/controller";
import { createForgeAccessReconciliation } from "../access/forge";
import { createIdentityConfiguration } from "../access/identity-configuration";
import { createEnvironmentController } from "../environments/controller";
import { createOpenBaoEnvironmentSecrets } from "../environments/openbao";
import { reportFailure } from "../failure-log";
import { createLearningService } from "../learning/service";
import { createLearningWorker } from "../learning/worker";
import { createMCPConnections } from "../mcp/connections";
import { createMCPOAuthCallback } from "../mcp/oauth-callback";
import { createMCPSecrets } from "../mcp/secrets";
import { createModelConnections } from "../models/connections";
import { createModelSettingsController } from "../models/controller";
import { createOpenBaoModelSecrets } from "../models/secrets";
import { createModelService } from "../models/service";
import { createUIPreferenceController } from "../preferences/controller";
import { createSkillController } from "../skills/controller";
import { createSkillService } from "../skills/service";
import { createUsageService } from "../usage/service";
import type { ServerConfig } from "./config";

export type PlatformWiringInput = {
  config: ServerConfig;
  database: ReturnType<typeof createDatabase>;
  runtimeSecret: string;
};

/**
 * Wires foundational platform services: identity, access control, Forgejo
 * reconciliation, UI preferences, models, environments, skills, MCP, usage
 * and learning, running their startup bootstrap and recovery hooks in order.
 */
export async function wirePlatform({ config, database, runtimeSecret }: PlatformWiringInput) {
  const { factoryOrigin } = config;
  const {
    apiURL: forgeAPIURL,
    owner: forgeOwner,
    adminToken: forgeAdminToken,
    transportOrigin: forgeTransportOrigin,
    publicOrigin: forgePublicOrigin,
  } = config.forge;

  const factoryAuth = createIdentityConfiguration(database, runtimeSecret, undefined, [
    ...config.identityAllowedOrigins,
  ]);
  await factoryAuth.bootstrap();

  const accessController = createAccessController(database);
  const forgeAccess = forgeAdminToken
    ? createForgeAccessReconciliation({
        database,
        forge: createForgejoAccess({
          apiURL: forgeAPIURL,
          token: forgeAdminToken,
        }),
        owner: forgeOwner,
        origin: forgeTransportOrigin,
        publicOrigin: forgePublicOrigin,
      })
    : undefined;

  const uiPreferenceController = createUIPreferenceController(database);
  const modelSettingsController = createModelSettingsController(database);
  const modelConnections = createModelConnections(
    database,
    createOpenBaoModelSecrets(),
    runtimeSecret,
    [...config.modelAllowedOrigins],
  );
  const modelService = createModelService({
    settings: modelSettingsController,
    connections: modelConnections,
    access: accessController,
    signingKey: runtimeSecret,
  });
  await modelConnections
    .recover()
    .catch(reportFailure("Model connection save recovery is unavailable"));

  const environmentSecrets = createOpenBaoEnvironmentSecrets();
  const environmentController = createEnvironmentController(
    database,
    environmentSecrets,
    runtimeSecret,
  );
  await environmentController
    .recover()
    .catch(reportFailure("Environment save recovery is unavailable"));

  const skillService = createSkillService(createSkillController(database), accessController);
  const mcpConnections = createMCPConnections(
    database,
    createMCPSecrets(),
    runtimeSecret,
    factoryOrigin,
  );
  const mcpOAuthCallback = createMCPOAuthCallback(mcpConnections);
  await mcpConnections.recover().catch(reportFailure("MCP credential recovery is unavailable"));

  const usageService = createUsageService(database);
  const learningService = createLearningService(database);
  const learningWorker = createLearningWorker(database, { signingKey: runtimeSecret });

  async function requireSession(request: Request) {
    return factoryAuth.session(request);
  }

  return {
    factoryAuth,
    requireSession,
    accessController,
    forgeAccess,
    uiPreferenceController,
    modelSettingsController,
    modelConnections,
    modelService,
    environmentSecrets,
    environmentController,
    skillService,
    mcpConnections,
    mcpOAuthCallback,
    usageService,
    learningService,
    learningWorker,
  };
}

export type PlatformSubsystem = Awaited<ReturnType<typeof wirePlatform>>;
