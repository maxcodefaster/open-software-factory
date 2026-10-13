import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import type { createDatabase } from "./db/client.ts";
import * as schema from "./db/schema.ts";

export function createAuth(
  database: ReturnType<typeof createDatabase>,
  options: { secret: string; baseURL: string; basePath?: string },
) {
  if (options.secret.length < 32)
    throw new Error("Set a strong BETTER_AUTH_SECRET in environment settings");
  return betterAuth({
    appName: "Starter",
    baseURL: options.baseURL,
    basePath: `${options.basePath ?? ""}/api/auth`,
    secret: options.secret,
    database: drizzleAdapter(database.db, { provider: "pg", schema, transaction: true }),
    emailAndPassword: { enabled: true, minPasswordLength: 12, maxPasswordLength: 128 },
    advanced: {
      database: { generateId: () => crypto.randomUUID() },
      cookiePrefix: "starter",
      useSecureCookies: options.baseURL.startsWith("https://"),
      defaultCookieAttributes: { path: `${options.basePath ?? ""}/` },
    },
    session: { cookieCache: { enabled: false } },
    trustedOrigins: [new URL(options.baseURL).origin],
    logger: { disabled: true },
  });
}
