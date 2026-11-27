// Local Forgejo account provisioning, access token management, and OIDC identity wiring.
import { readFile, writeFile } from "node:fs/promises";
import { createDatabase } from "#db/client";
import { ensureLocalForgeIdentity } from "./forge-identity";
import { installForgeBrowserLogout } from "./forge-logout";
import type { LocalFactoryContext } from "./local-context";
import { localForgeIdentityEndpoints, type localServerSettings } from "./server-settings";

type ForgeAccountSpec = {
  username: string;
  email: string;
  admin: boolean;
  tokenFile: string;
  probePath: string;
  tokenName: () => string;
  scopes: string;
  missingTokenError: string;
};

async function ensureForgeAccountToken(ctx: LocalFactoryContext, spec: ForgeAccountSpec) {
  const users = await ctx.forgejoExec(["admin", "user", "list"], true);
  if (!users.split("\n").some((line) => line.split(/\s+/).includes(spec.username))) {
    await ctx.forgejoExec(
      [
        "admin",
        "user",
        "create",
        "--username",
        spec.username,
        "--random-password",
        "--email",
        spec.email,
        ...(spec.admin ? ["--admin"] : []),
        "--must-change-password=false",
      ],
      true,
    );
  }
  const existing = (await readFile(spec.tokenFile, "utf8").catch(() => "")).trim();
  if (existing) {
    const probe = await fetch(`${ctx.forgejoBaseURL}${spec.probePath}`, {
      headers: { authorization: `Bearer ${existing}` },
      signal: AbortSignal.timeout(5_000),
    }).catch(() => null);
    if (probe?.ok) return existing;
  }
  const token = await ctx.forgejoExec(
    [
      "admin",
      "user",
      "generate-access-token",
      "--username",
      spec.username,
      "--token-name",
      spec.tokenName(),
      "--scopes",
      spec.scopes,
      "--raw",
    ],
    true,
  );
  if (!token) throw new Error(spec.missingTokenError);
  await writeFile(spec.tokenFile, `${token}\n`, { mode: 0o600 });
  return token;
}

export async function ensureForgeAdministrator(ctx: LocalFactoryContext) {
  return ensureForgeAccountToken(ctx, {
    username: "factory-identity-control",
    email: "factory-identity-control@factory.invalid",
    admin: true,
    tokenFile: ctx.paths.forgejoAdminTokenFile,
    probePath: "/api/v1/admin/users?limit=1",
    tokenName: () => `factory-identity-${crypto.randomUUID()}`,
    scopes: "all",
    missingTokenError: "Forge administrator token is unavailable",
  });
}

export async function ensureForgejo(ctx: LocalFactoryContext) {
  await ensureForgeAdministrator(ctx);
  return ensureForgeAccountToken(ctx, {
    username: "factory-mutation",
    email: "factory-mutation@factory.invalid",
    admin: false,
    tokenFile: ctx.paths.forgejoTokenFile,
    probePath: "/api/v1/user",
    tokenName: () => `factory-local-${crypto.randomUUID().slice(0, 8)}`,
    scopes: "write:repository,write:user",
    missingTokenError: "Forgejo returned no mutation token",
  });
}

export async function configuredForgeIdentity(factoryPort: number) {
  const database = createDatabase(1);
  try {
    const [connection] = await database.client<{ discovery: string }[]>`
      SELECT payload->>'discoveryUrl' AS discovery
      FROM factory.operation
      WHERE kind='access.forge_connection' AND idempotency_key='access.forge_connection:singleton'`;
    return localForgeIdentityEndpoints(
      process.env["FACTORY_RUNTIME_HOST"],
      factoryPort,
      connection?.discovery,
    );
  } finally {
    await database.client.end({ timeout: 2 });
  }
}

export async function wireLocalForgeIdentity(
  ctx: LocalFactoryContext,
  options: {
    settings: ReturnType<typeof localServerSettings>;
    authSecret: string;
    forgeIdentity: ReturnType<typeof localForgeIdentityEndpoints>;
  },
) {
  const { factoryBaseURL, forgejoBaseURL, composeArguments, command, forgejoExec } = ctx;
  await ensureLocalForgeIdentity({
    factoryURL: factoryBaseURL,
    forgeURL: forgejoBaseURL,
    discoveryURL: options.forgeIdentity.discovery,
    email: options.settings.email,
    password: options.settings.password,
    signingKey: options.authSecret,
    execute: (args) => forgejoExec(args, true),
    installLogout: () =>
      installForgeBrowserLogout({
        factoryURL: factoryBaseURL,
        execute: (args) =>
          command([...composeArguments, "exec", "-T", "forgejo", ...args], { quiet: true }),
        copy: (source, destination) =>
          command([...composeArguments, "cp", source, `forgejo:${destination}`], { quiet: true }),
      }),
    reload: async () => {
      await command([...composeArguments, "restart", "forgejo"], { quiet: true });
      const deadline = Date.now() + 30_000;
      while (Date.now() < deadline) {
        if (
          await fetch(`${forgejoBaseURL}/api/healthz`)
            .then((response) => response.ok)
            .catch(() => false)
        )
          return;
        await Bun.sleep(100);
      }
      throw new Error("Forgejo did not become healthy after loading Factory identity");
    },
  });
}
