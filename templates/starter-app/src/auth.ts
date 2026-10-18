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
  const base = new URL(options.baseURL);
  const trustedOrigins = [base.origin];
  // Factory's isolated browser dials the assigned loopback App port. Accept
  // only its exact local alias, never arbitrary hosts, ports or forwarded input.
  if (base.protocol === "http:" && ["localhost", "127.0.0.1"].includes(base.hostname)) {
    const alias = new URL(base.origin);
    alias.hostname = base.hostname === "localhost" ? "127.0.0.1" : "localhost";
    trustedOrigins.push(alias.origin);
  }
  return betterAuth({
    appName: "Starter",
    baseURL: options.baseURL,
    basePath: `${options.basePath ?? ""}/api/auth`,
    secret: options.secret,
    database: drizzleAdapter(database.db, { provider: "pg", schema, transaction: true }),
    emailAndPassword: { enabled: true, minPasswordLength: 12, maxPasswordLength: 128 },
    advanced: {
      // Keep the same origin policy in tests; Better Auth otherwise skips it
      // when the caller happens to inherit NODE_ENV=test.
      disableOriginCheck: false,
      database: { generateId: () => crypto.randomUUID() },
      cookiePrefix: "starter",
      useSecureCookies: options.baseURL.startsWith("https://"),
      defaultCookieAttributes: { path: `${options.basePath ?? ""}/` },
    },
    session: { cookieCache: { enabled: false } },
    trustedOrigins,
    logger: { disabled: true },
  });
}
