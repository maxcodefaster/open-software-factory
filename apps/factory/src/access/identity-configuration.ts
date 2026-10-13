import { createHmac } from "node:crypto";
import { z } from "zod";
import type { IdentityPolicy } from "../../../../packages/auth/src/policy";
import { createFactoryAuth } from "../../../../packages/auth/src/server";
import type { createDatabase } from "../../../../packages/db/src/client";
import {
  type IdentityConfiguration,
  identityConfiguration,
  identityConfigurationView,
  identityConfigurationWrite,
  identityMetadata,
} from "../../../../packages/identity-domain/src/configuration";
import type { AgentTurnTransaction } from "../agent/turn-store";
import { CommandError } from "../command-error";
import { createOpenBaoKV } from "../secrets/openbao";
import { requireActiveAccountIn } from "./controller";

const storedIdentity = z
  .object({ commandID: z.uuid(), fingerprint: z.string(), configuration: identityConfiguration })
  .strict();
type StoredIdentity = z.output<typeof storedIdentity>;
type SecretStore = {
  configured: boolean;
  read(key: string, schema: typeof storedIdentity): Promise<StoredIdentity | undefined>;
  create(key: string, value: StoredIdentity, schema: typeof storedIdentity): Promise<void>;
};
type Setup = {
  id: string;
  baseVersion: number;
  metadata: ReturnType<typeof identityMetadata>;
  fingerprint: string;
  secretKey: string;
  createdBy: string;
  state: "write-intended" | "saved" | "active" | "superseded";
  tested: boolean;
};
function policy(configuration: IdentityConfiguration): IdentityPolicy {
  return {
    sessionDays: configuration.sessionDays,
    ...(configuration.mode === "oidc" &&
    configuration.issuer &&
    configuration.clientID &&
    configuration.clientSecret &&
    configuration.domain
      ? {
          provider: {
            providerId: "company",
            domain: configuration.domain,
            oidcConfig: {
              issuer: configuration.issuer,
              discoveryEndpoint: `${configuration.issuer.replace(/\/$/, "")}/.well-known/openid-configuration`,
              pkce: true,
              clientId: configuration.clientID,
              clientSecret: configuration.clientSecret,
              scopes: ["openid", "profile", "email"],
            },
          },
        }
      : {}),
    ...(configuration.directoryToken
      ? {
          directory: {
            token: configuration.directoryToken,
            subjectClaim: configuration.directorySubjectClaim,
          },
        }
      : {}),
  };
}
export function createIdentityConfiguration(
  database: ReturnType<typeof createDatabase>,
  signingKey: string,
  secrets: SecretStore = createOpenBaoKV(),
  allowedOrigins: readonly string[] = [],
) {
  let active = createFactoryAuth(database);
  let activeVersion = 0;
  let recoveringActive = false;
  const candidates = new Map<string, ReturnType<typeof createFactoryAuth>>();
  async function manager(sql: AgentTurnTransaction, userID: string) {
    await requireActiveAccountIn(sql, userID);
    const [row] =
      await sql`SELECT user_id FROM factory.administrator WHERE user_id=${userID} FOR SHARE`;
    if (!row) throw new CommandError("forbidden", "System Manager access required");
  }
  async function setup(id: string) {
    const [row] = await database.client<
      Setup[]
    >`SELECT id,base_version::float8 AS "baseVersion",metadata,fingerprint,secret_key AS "secretKey",created_by AS "createdBy",state,tested_at IS NOT NULL AS tested FROM factory.identity_setup WHERE id=${id}`;
    if (!row) throw new CommandError("not-found", "Sign-in setup not found");
    return row;
  }
  async function stored(row: Setup) {
    const value = await secrets.read(row.secretKey, storedIdentity);
    if (!value || value.commandID !== row.id || value.fingerprint !== row.fingerprint)
      throw new CommandError(
        "unavailable",
        "Protected sign-in configuration does not match its save",
      );
    return value.configuration;
  }
  async function refresh() {
    const [current] = await database.client<
      Array<{ version: number; setupID: string }>
    >`SELECT version::float8 AS version,setup_id AS "setupID" FROM factory.identity_configuration WHERE singleton`;
    if (!current || (current.version === activeVersion && !recoveringActive)) return;
    const row = await setup(current.setupID);
    try {
      const next = createFactoryAuth(database, policy(await stored(row)));
      if (current.version >= activeVersion) {
        active = next;
        activeVersion = current.version;
        recoveringActive = false;
      }
    } catch {
      // A protected-store outage must not become local password fallback or
      // remove the emergency administrator's recovery access.
      if (current.version >= activeVersion) {
        active = createFactoryAuth(database, {
          sessionDays: row.metadata.sessionDays,
          emergencyOnly: true,
        });
        activeVersion = current.version;
        recoveringActive = true;
      }
    }
  }
  async function resume(row: Setup) {
    const configuration = await stored(row);
    if (row.state === "write-intended")
      await database.client`UPDATE factory.identity_setup SET state='saved' WHERE id=${row.id} AND state='write-intended'`;
    if (row.state === "write-intended" || row.state === "saved")
      candidates.set(
        row.id,
        createFactoryAuth(
          database,
          { ...policy(configuration), setupCommandID: row.id },
          { cookiePrefix: `factory-test-${row.id}` },
        ),
      );
  }
  return {
    async bootstrap() {
      await active.bootstrap();
      await refresh();
      await this.recover();
    },
    async recover() {
      const rows = await database.client<
        Array<{ id: string }>
      >`SELECT id FROM factory.identity_setup WHERE state IN ('saved','write-intended') ORDER BY created_at LIMIT 16`;
      for (const row of rows) {
        const input = await setup(row.id);
        try {
          const value = await secrets.read(input.secretKey, storedIdentity);
          if (value) await resume(input);
        } catch {
          // Keep durable setup intent for a later retry. Active login recovery
          // and emergency access do not depend on unfinished candidates.
        }
      }
    },
    async handler(request: Request) {
      await refresh();
      const path = new URL(request.url).pathname;
      if (path === "/api/auth/sign-in/sso" && request.method === "POST") {
        const body: unknown = await request
          .clone()
          .json()
          .catch(() => null);
        if (
          body &&
          typeof body === "object" &&
          "setupCommandID" in body &&
          typeof body.setupCommandID === "string"
        ) {
          const session = await active.session(request);
          if (!session?.systemManager)
            return Response.json({ error: "System Manager access required" }, { status: 403 });
          await active.requireFresh(request);
          const row = await setup(z.uuid().parse(body.setupCommandID));
          if (row.state !== "saved" || row.createdBy !== session.user.id)
            throw new CommandError("conflict", "This sign-in check is no longer available");
          await resume(row);
          const candidate = candidates.get(row.id);
          if (!candidate) throw new CommandError("unavailable", "Sign-in check is unavailable");
          return candidate.auth.handler(request);
        }
      }
      // Native state is bound to the candidate cookie. Never choose a candidate from callback body/query.
      if (path.startsWith("/api/auth/sso/callback/")) {
        if (await active.matchesOAuthState(request)) return active.auth.handler(request);
        const selected = [];
        for (const entry of candidates)
          if (await entry[1].matchesOAuthState(request)) selected.push(entry);
        if (selected.length === 1 && selected[0]) {
          const row = await setup(selected[0][0]);
          if (row.state !== "saved") throw new CommandError("conflict", "Sign-in setup changed");
          return selected[0][1].auth.handler(request);
        }
      }
      return active.auth.handler(request);
    },
    async session(request: Request) {
      await refresh();
      return active.session(request);
    },
    async requireFresh(request: Request) {
      await refresh();
      return active.requireFresh(request);
    },
    async ensureForgeClient(headers: Headers, redirectURI: string) {
      await refresh();
      return active.ensureForgeClient(headers, redirectURI);
    },
    async discovery() {
      await refresh();
      return active.discovery();
    },
    async createManagedUser(input: { name: string; email: string; password: string }) {
      await refresh();
      return active.createManagedUser(input);
    },
    get policy() {
      return active.policy;
    },
    async view(userID: string) {
      await database.client.begin((sql) => manager(sql, userID));
      await refresh();
      const [current] = await database.client<
        Array<{ setupID: string }>
      >`SELECT setup_id AS "setupID" FROM factory.identity_configuration WHERE singleton`;
      const metadata: ReturnType<typeof identityMetadata> = current
        ? (await setup(current.setupID)).metadata
        : { mode: "local", sessionDays: 7, directoryEnabled: false, directorySubjectClaim: "oid" };
      const rows = await database.client<
        Setup[]
      >`SELECT id,metadata,state,tested_at IS NOT NULL AS tested FROM factory.identity_setup WHERE created_by=${userID} AND state IN ('write-intended','saved') ORDER BY created_at DESC LIMIT 16`;
      return identityConfigurationView.parse({
        version: activeVersion,
        ...metadata,
        issuer: metadata.issuer ?? null,
        clientID: metadata.clientID ?? null,
        domain: metadata.domain ?? null,
        storeConfigured: secrets.configured,
        candidates: rows.map((row) => ({
          commandID: row.id,
          mode: row.metadata.mode,
          issuer: row.metadata.issuer ?? null,
          state: row.state,
          tested: row.tested,
        })),
      });
    },
    async save(userID: string, value: z.output<typeof identityConfigurationWrite>) {
      const input = identityConfigurationWrite.parse(value);
      if (input.configuration.issuer) {
        const url = new URL(input.configuration.issuer);
        if (
          url.protocol !== "https:" ||
          url.username ||
          url.password ||
          url.search ||
          url.hash ||
          !allowedOrigins.includes(url.origin)
        )
          throw new CommandError(
            "forbidden",
            "Use an HTTPS identity-provider origin approved by this installation",
          );
      }
      if (!secrets.configured)
        throw new CommandError("unavailable", "Connect OpenBao before setting up company sign-in");
      const fingerprint = createHmac("sha256", signingKey)
        .update(JSON.stringify(input))
        .digest("hex");
      const row = await database.client.begin(async (sql) => {
        await sql`SELECT pg_advisory_xact_lock(hashtextextended('factory-identity-configuration',0))`;
        await manager(sql, userID);
        const [old] = await sql<
          Array<{ id: string; fingerprint: string; createdBy: string }>
        >`SELECT id,fingerprint,created_by AS "createdBy" FROM factory.identity_setup WHERE id=${input.commandID}`;
        if (old) {
          if (old.fingerprint !== fingerprint || old.createdBy !== userID)
            throw new CommandError("conflict", "Sign-in save identity was reused");
          return setup(input.commandID);
        }
        const [current] = await sql<
          Array<{ version: number }>
        >`SELECT version::float8 AS version FROM factory.identity_configuration WHERE singleton`;
        if ((current?.version ?? 0) !== input.version)
          throw new CommandError("conflict", "Sign-in settings changed. Reload before saving");
        const [unfinished] = await sql<
          Array<{ count: number }>
        >`SELECT count(*)::int AS count FROM factory.identity_setup WHERE state IN ('saved','write-intended')`;
        if ((unfinished?.count ?? 0) >= 16)
          throw new CommandError(
            "conflict",
            "Finish an existing sign-in setup before saving another",
          );
        const metadata = identityMetadata(input.configuration);
        const secretKey = `identity/${input.commandID}`;
        await sql`INSERT INTO factory.identity_setup(id,base_version,metadata,fingerprint,secret_key,created_by,state) VALUES(${input.commandID},${input.version},${JSON.stringify(metadata)}::jsonb,${fingerprint},${secretKey},${userID},'write-intended')`;
        return {
          id: input.commandID,
          baseVersion: input.version,
          metadata,
          fingerprint,
          secretKey,
          createdBy: userID,
          state: "write-intended" as const,
          tested: false,
        };
      });
      if (row.state === "write-intended") {
        const previous = await secrets.read(row.secretKey, storedIdentity);
        if (!previous)
          await secrets.create(
            row.secretKey,
            { commandID: row.id, fingerprint, configuration: input.configuration },
            storedIdentity,
          );
      }
      await resume(row);
      return this.view(userID);
    },
    async activate(userID: string, commandID: string) {
      const row = await setup(commandID);
      const configuration = await stored(row);
      // Build the native configuration before publishing its exact identity.
      createFactoryAuth(database, policy(configuration));
      await database.client.begin(async (sql) => {
        await sql`SELECT pg_advisory_xact_lock(hashtextextended('factory-identity-configuration',0))`;
        await manager(sql, userID);
        const [target] = await sql<
          Array<{ state: string; tested: boolean }>
        >`SELECT state,tested_at IS NOT NULL AS tested FROM factory.identity_setup WHERE id=${commandID} AND created_by=${userID} FOR UPDATE`;
        const [current] = await sql<
          Array<{ version: number; setupID: string }>
        >`SELECT version::float8 AS version,setup_id AS "setupID" FROM factory.identity_configuration WHERE singleton FOR UPDATE`;
        if (current?.setupID === commandID) return;
        if (
          target?.state !== "saved" ||
          (current?.version ?? 0) !== row.baseVersion ||
          (configuration.mode === "oidc" && !target.tested)
        )
          throw new CommandError(
            "conflict",
            "Complete the sign-in check before activating this configuration",
          );
        await sql`UPDATE factory.identity_setup SET state='superseded' WHERE state='active'`;
        await sql`UPDATE factory.identity_setup SET state='active' WHERE id=${commandID}`;
        await sql`INSERT INTO factory.identity_configuration(singleton,version,setup_id,activated_by) VALUES(true,${row.baseVersion + 1},${commandID},${userID}) ON CONFLICT(singleton) DO UPDATE SET version=EXCLUDED.version,setup_id=EXCLUDED.setup_id,activated_by=EXCLUDED.activated_by,activated_at=now()`;
        // Existing password sessions cannot become a bypass for newly enabled company SSO.
        await sql`DELETE FROM auth.session WHERE user_id<>'01994a7d-0000-7000-8000-000000000001' OR login_method='identity-test'`;
      });
      await refresh();
      return this.view(userID);
    },
  };
}
