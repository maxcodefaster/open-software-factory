import { describe, expect, test } from "bun:test";
import { readServerConfig } from "./config";

const baseEnv: NodeJS.ProcessEnv = {
  FACTORY_FORGEJO_API_URL: "http://127.0.0.1:3001/api/v1",
  FACTORY_FORGEJO_OWNER: "factory-bot",
  FACTORY_FORGEJO_TOKEN: "tok-123",
};

describe("readServerConfig", () => {
  test("parses valid loopback defaults and derived origins", () => {
    const config = readServerConfig({ ...baseEnv });
    expect(config.factoryHost).toBe("127.0.0.1");
    expect(config.factoryPort).toBe("3000");
    expect(config.factoryOrigin).toBe("http://127.0.0.1:3000");
    expect(config.forge.transportOrigin).toBe("http://127.0.0.1:3001");
    expect(config.forge.publicOrigin).toBe("http://127.0.0.1:3001");
    expect(config.forge.discoveryURL).toBe(
      "http://127.0.0.1:3000/api/auth/.well-known/openid-configuration",
    );
    expect(config.identityAllowedOrigins).toEqual(["https://login.microsoftonline.com"]);
    expect(config.modelAllowedOrigins).toEqual([]);
    expect(config.planningCacheURL).toBe("http://127.0.0.1:4948");
    expect(config.wiki.receiverURL).toBe("http://127.0.0.1:3000");
    expect(config.fallbackModelConfigured).toBe(false);
    expect(config.startupID.length).toBeGreaterThan(0);
  });

  test("requires Forgejo API URL, owner, and token", () => {
    expect(() => readServerConfig({})).toThrow("Configure the Factory Forgejo API");
    expect(() => readServerConfig({ FACTORY_FORGEJO_API_URL: "http://127.0.0.1:3001" })).toThrow(
      "Configure the Factory Forgejo owner and token",
    );
  });

  test("requires auth secret and admin password outside loopback", () => {
    expect(() => readServerConfig({ ...baseEnv, FACTORY_HOST: "0.0.0.0" })).toThrow(
      "FACTORY_AUTH_SECRET and FACTORY_ADMIN_PASSWORD are required outside a loopback listener",
    );
    const config = readServerConfig({
      ...baseEnv,
      FACTORY_HOST: "0.0.0.0",
      FACTORY_AUTH_SECRET: "secret",
      FACTORY_ADMIN_PASSWORD: "password",
    });
    expect(config.factoryHost).toBe("0.0.0.0");
  });

  test("parses optional lists, overrides, and model fallback flag", () => {
    const config = readServerConfig({
      ...baseEnv,
      FACTORY_BASE_URL: "https://factory.example.com/subpath",
      FACTORY_FORGEJO_PUBLIC_URL: "https://git.example.com/org",
      FACTORY_FORGEJO_ADMIN_TOKEN: "admin-tok",
      FACTORY_IDENTITY_ALLOWED_ORIGINS: " https://idp.a.test , , https://idp.b.test ",
      FACTORY_MODEL_ALLOWED_ORIGINS: "https://models.local",
      FACTORY_ZERO_CACHE_PUBLIC_URL: "https://zero.example.com",
      FACTORY_PLANNING_CACHE_EPOCH: "epoch-7",
      FACTORY_WIKI_WEBHOOK_URL: "https://hooks.example.com",
      FACTORY_WIKI_WEBHOOK_SECRET: "hook-secret",
      FACTORY_MODEL_BASE_URL: "https://api.example.com",
      FACTORY_MODEL_API_KEY: "key-1",
      FACTORY_HELM_RELEASE: "factory-prod",
      FACTORY_STARTUP_ID: "startup-1",
    });
    expect(config.factoryOrigin).toBe("https://factory.example.com");
    expect(config.forge.publicOrigin).toBe("https://git.example.com");
    expect(config.forge.adminToken).toBe("admin-tok");
    expect(config.identityAllowedOrigins).toEqual([
      "https://login.microsoftonline.com",
      "https://idp.a.test",
      "https://idp.b.test",
    ]);
    expect(config.modelAllowedOrigins).toEqual(["https://models.local"]);
    expect(config.planningCacheURL).toBe("https://zero.example.com");
    expect(config.planningCacheEpoch).toBe("epoch-7");
    expect(config.wiki).toEqual({
      receiverURL: "https://hooks.example.com",
      webhookSecret: "hook-secret",
    });
    expect(config.fallbackModelConfigured).toBe(true);
    expect(config.helmRelease).toBe("factory-prod");
    expect(config.startupID).toBe("startup-1");
  });
});
