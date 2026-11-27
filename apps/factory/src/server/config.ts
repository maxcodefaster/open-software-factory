import { z } from "zod";
import { projectImportOrigins } from "#project-domain/setup";

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);
const DEFAULT_IDENTITY_ALLOWED_ORIGINS = ["https://login.microsoftonline.com"] as const;

function parseCommaList(raw: string | undefined): string[] {
  return (
    raw
      ?.split(",")
      .map((value) => value.trim())
      .filter(Boolean) ?? []
  );
}

const urlOriginSchema = z.string().transform((value, ctx) => {
  try {
    return new URL(value).origin;
  } catch {
    ctx.addIssue({ code: "custom", message: `Invalid URL: ${value}` });
    return z.NEVER;
  }
});

export type ServerConfig = {
  readonly factoryHost: string;
  readonly factoryPort: string;
  readonly factoryOrigin: string;
  readonly startupID: string;
  readonly forge: {
    readonly apiURL: string;
    readonly owner: string;
    readonly token: string;
    readonly adminToken?: string;
    readonly transportOrigin: string;
    readonly publicOrigin: string;
    readonly discoveryURL: string;
  };
  readonly identityAllowedOrigins: readonly string[];
  readonly modelAllowedOrigins: readonly string[];
  readonly gitImportOrigins: ReturnType<typeof projectImportOrigins>;
  readonly wiki: {
    readonly receiverURL: string;
    readonly webhookSecret?: string;
  };
  readonly planningCacheURL: string;
  readonly planningCacheEpoch?: string;
  readonly fallbackModelConfigured: boolean;
  readonly helmRelease?: string;
};

/**
 * Parses and validates Factory's server startup environment once at boot.
 * Preserves exact startup invariants (loopback auth guard, required Forgejo settings).
 */
export function readServerConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const factoryHost = env["FACTORY_HOST"] ?? "127.0.0.1";
  const factoryPort = env["FACTORY_PORT"] ?? "3000";
  const factoryOrigin = urlOriginSchema.parse(env["FACTORY_BASE_URL"] ?? "http://127.0.0.1:3000");

  const forgeAPIURL = env["FACTORY_FORGEJO_API_URL"];
  if (!forgeAPIURL) {
    throw new Error("Configure the Factory Forgejo API before starting the server");
  }
  const forgeOwner = env["FACTORY_FORGEJO_OWNER"];
  const forgeToken = env["FACTORY_FORGEJO_TOKEN"];
  if (!forgeOwner || !forgeToken) {
    throw new Error("Configure the Factory Forgejo owner and token before starting the server");
  }
  const forgeAdminToken = env["FACTORY_FORGEJO_ADMIN_TOKEN"];
  const forgeTransportOrigin = urlOriginSchema.parse(forgeAPIURL);
  const forgePublicOrigin = urlOriginSchema.parse(env["FACTORY_FORGEJO_PUBLIC_URL"] ?? forgeAPIURL);

  if (
    !LOOPBACK_HOSTS.has(factoryHost) &&
    (!env["FACTORY_AUTH_SECRET"] || !env["FACTORY_ADMIN_PASSWORD"])
  ) {
    throw new Error(
      "FACTORY_AUTH_SECRET and FACTORY_ADMIN_PASSWORD are required outside a loopback listener",
    );
  }

  const startupID = env["FACTORY_STARTUP_ID"] ?? crypto.randomUUID();
  const planningCacheURL =
    env["FACTORY_ZERO_CACHE_PUBLIC_URL"] ??
    env["FACTORY_ZERO_CACHE_URL"] ??
    "http://127.0.0.1:4948";
  const planningCacheEpoch = env["FACTORY_PLANNING_CACHE_EPOCH"];
  const webhookSecret = env["FACTORY_WIKI_WEBHOOK_SECRET"];
  const helmRelease = env["FACTORY_HELM_RELEASE"];

  return {
    factoryHost,
    factoryPort,
    factoryOrigin,
    startupID,
    forge: {
      apiURL: forgeAPIURL,
      owner: forgeOwner,
      token: forgeToken,
      ...(forgeAdminToken ? { adminToken: forgeAdminToken } : {}),
      transportOrigin: forgeTransportOrigin,
      publicOrigin: forgePublicOrigin,
      discoveryURL:
        env["FACTORY_FORGE_DISCOVERY_URL"] ??
        `${factoryOrigin}/api/auth/.well-known/openid-configuration`,
    },
    identityAllowedOrigins: [
      ...DEFAULT_IDENTITY_ALLOWED_ORIGINS,
      ...parseCommaList(env["FACTORY_IDENTITY_ALLOWED_ORIGINS"]),
    ],
    modelAllowedOrigins: parseCommaList(env["FACTORY_MODEL_ALLOWED_ORIGINS"]),
    gitImportOrigins: projectImportOrigins(env["FACTORY_GIT_IMPORT_ORIGINS"]),
    wiki: {
      receiverURL:
        env["FACTORY_WIKI_WEBHOOK_URL"] ??
        env["FACTORY_BASE_URL"] ??
        `http://127.0.0.1:${factoryPort}`,
      ...(webhookSecret ? { webhookSecret } : {}),
    },
    planningCacheURL,
    ...(planningCacheEpoch ? { planningCacheEpoch } : {}),
    fallbackModelConfigured: Boolean(env["FACTORY_MODEL_BASE_URL"] && env["FACTORY_MODEL_API_KEY"]),
    ...(helmRelease ? { helmRelease } : {}),
  };
}
