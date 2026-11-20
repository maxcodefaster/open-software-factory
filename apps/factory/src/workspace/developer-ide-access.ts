import { createHash } from "node:crypto";
import { and, desc, eq, sql as expression, gt, inArray, like, lte, ne, or } from "drizzle-orm";
import { type createDatabase, drizzleTransaction } from "../../../../packages/db/src/client";
import { authSession, authUser, authVerification } from "../../../../packages/db/src/schema";
import { CommandError } from "../command-error";
import { developerIDEOrigin } from "../developer-ide-origin";
import { factoryRequestURL } from "../request-origin";
import type { createDeveloperIDEController } from "./developer-ide-controller";

export interface DeveloperIDEGrant {
  readonly userID: string;
  readonly sessionID: string;
  readonly epoch: number;
  readonly expires: number;
  readonly embedded: boolean;
}
export function developerIDEPath(userID: string, epoch: number) {
  return `/editor/${userID}/${epoch}/`;
}
export function createDeveloperIDEAccess(
  database: ReturnType<typeof createDatabase>,
  editors: ReturnType<typeof createDeveloperIDEController>,
  factoryOrigin: string,
  onRevoke: (token: string) => void,
) {
  type StoredGrant = DeveloperIDEGrant & { kind: "exchange" | "access" };
  // These are temporary authentication nonces, not product/runtime identities.
  // Store only their hashes in auth's TTL store. A Factory replacement must
  // neither forget established cookies nor make an exchange redeemable twice.
  const prefix = (userID: string) => `factory-editor:${userID}:`;
  const identifier = (token: string, userID: string) =>
    prefix(userID) + createHash("sha256").update(token).digest("hex");
  const grants = new Map<string, DeveloperIDEGrant>();
  function forget(token: string) {
    grants.delete(token);
    onRevoke(token);
  }
  function decode(value: string): StoredGrant | undefined {
    try {
      const grant: unknown = JSON.parse(value);
      if (
        grant &&
        typeof grant === "object" &&
        "userID" in grant &&
        typeof grant.userID === "string" &&
        "sessionID" in grant &&
        typeof grant.sessionID === "string" &&
        "epoch" in grant &&
        typeof grant.epoch === "number" &&
        Number.isSafeInteger(grant.epoch) &&
        grant.epoch > 0 &&
        "expires" in grant &&
        typeof grant.expires === "number" &&
        Number.isSafeInteger(grant.expires) &&
        "embedded" in grant &&
        typeof grant.embedded === "boolean" &&
        "kind" in grant &&
        (grant.kind === "exchange" || grant.kind === "access")
      )
        return grant as StoredGrant;
    } catch {}
    return undefined;
  }
  async function load(token: string, userID: string, kind: StoredGrant["kind"]) {
    const [row] = await database.db
      .select({ value: authVerification.value })
      .from(authVerification)
      .where(
        and(
          eq(authVerification.identifier, identifier(token, userID)),
          gt(authVerification.expiresAt, expression`now()`),
        ),
      );
    const grant = row && decode(row.value);
    return grant?.userID === userID && grant.kind === kind ? grant : undefined;
  }
  async function revoke(token: string, userID: string) {
    forget(token);
    await database.db
      .delete(authVerification)
      .where(eq(authVerification.identifier, identifier(token, userID)));
  }
  async function save(token: string, grant: StoredGrant) {
    const evicted = await database.client.begin(async (sql) => {
      const db = drizzleTransaction(sql);
      // Serialize the per-person bound across all Factory processes.
      await db
        .select({ id: authUser.id })
        .from(authUser)
        .where(eq(authUser.id, grant.userID))
        .for("update");
      const owned = like(authVerification.identifier, `${prefix(grant.userID)}%`);
      await db
        .delete(authVerification)
        .where(and(owned, lte(authVerification.expiresAt, expression`now()`)));
      const evicted = await db
        .delete(authVerification)
        .where(
          inArray(
            authVerification.id,
            db
              .select({ id: authVerification.id })
              .from(authVerification)
              .where(owned)
              .orderBy(desc(authVerification.createdAt), desc(authVerification.id))
              .offset(31),
          ),
        )
        .returning({ identifier: authVerification.identifier });
      await db.insert(authVerification).values({
        id: crypto.randomUUID(),
        identifier: identifier(token, grant.userID),
        value: JSON.stringify(grant),
        expiresAt: new Date(grant.expires),
      });
      return evicted;
    });
    for (const [current, cached] of grants)
      if (evicted.some((row) => row.identifier === identifier(current, cached.userID)))
        forget(current);
  }
  async function valid(grant: DeveloperIDEGrant) {
    if (grant.expires <= Date.now()) return false;
    const sessions = await database.db
      .select({ id: authSession.id })
      .from(authSession)
      .where(
        and(
          eq(authSession.id, grant.sessionID),
          eq(authSession.userId, grant.userID),
          gt(authSession.expiresAt, expression`now()`),
          ne(authSession.loginMethod, "identity-test"),
          or(
            ne(authSession.loginMethod, "sso"),
            gt(authSession.authenticatedAt, expression`now()-interval '24 hours'`),
          ),
        ),
      );
    if (!sessions.length) return false;
    try {
      const current = await editors.get(grant.userID);
      // Readiness is transport state, not a new identity or loss of Developer
      // authority. Preserve the grant while this same editor reconnects.
      return (
        current.epoch === grant.epoch &&
        (current.state === "ready" || current.state === "preparing")
      );
    } catch (cause) {
      if (cause instanceof CommandError) return false;
      throw cause;
    }
  }
  function originMatches(url: URL, grant: DeveloperIDEGrant) {
    return url.origin === developerIDEOrigin(factoryOrigin, grant.userID, grant.epoch);
  }
  return {
    async issue(grant: DeveloperIDEGrant) {
      if (!(await valid(grant))) throw new CommandError("forbidden", "Editor access required");
      const token = crypto.randomUUID();
      await save(token, { ...grant, kind: "exchange" });
      return token;
    },
    async redeem(url: URL, userID: string, epoch: number) {
      const token = url.searchParams.get("factory-grant");
      const grant = token ? await load(token, userID, "exchange") : undefined;
      if (
        !token ||
        !grant ||
        grant.userID !== userID ||
        grant.epoch !== epoch ||
        !originMatches(url, grant)
      )
        return undefined;
      if (!(await valid(grant))) {
        await revoke(token, userID);
        return undefined;
      }
      const consumed = await database.db
        .delete(authVerification)
        .where(
          and(
            eq(authVerification.identifier, identifier(token, userID)),
            gt(authVerification.expiresAt, expression`now()`),
          ),
        )
        .returning({ id: authVerification.id });
      if (!consumed.length) return undefined;
      const accessToken = crypto.randomUUID();
      await save(accessToken, { ...grant, kind: "access" });
      grants.set(accessToken, grant);
      url.searchParams.delete("factory-grant");
      return new Response(null, {
        status: 302,
        headers: {
          location: url.href,
          "referrer-policy": "no-referrer",
          "cache-control": "no-store",
          "set-cookie": `factory_editor_access=${accessToken}; Path=${developerIDEPath(userID, epoch)}; HttpOnly; ${grant.embedded ? "SameSite=None; Secure; Partitioned" : `SameSite=Lax${url.protocol === "https:" ? "; Secure" : ""}`}; Max-Age=28800`,
        },
      });
    },
    async authorize(request: Request, userID: string, epoch: number) {
      const token = request.headers
        .get("cookie")
        ?.split(";")
        .map((value) => value.trim().split("="))
        .find(([name]) => name === "factory_editor_access")?.[1];
      const grant = token ? await load(token, userID, "access") : undefined;
      if (
        !token ||
        !grant ||
        grant.userID !== userID ||
        grant.epoch !== epoch ||
        !originMatches(factoryRequestURL(request, factoryOrigin), grant)
      ) {
        if (token) forget(token);
        return undefined;
      }
      if (!(await valid(grant))) {
        await revoke(token, userID);
        return undefined;
      }
      grants.set(token, grant);
      return { token, grant };
    },
    has(token: string) {
      const grant = grants.get(token);
      return Boolean(grant && grant.expires > Date.now());
    },
    async revokeUser(userID: string) {
      for (const [token, grant] of grants) if (grant.userID === userID) forget(token);
      await database.db
        .delete(authVerification)
        .where(like(authVerification.identifier, `${prefix(userID)}%`));
    },
    async sweep(userID?: string) {
      for (const [token, grant] of grants)
        if (
          (!userID || grant.userID === userID) &&
          (!(await load(token, grant.userID, "access")) || !(await valid(grant)))
        )
          await revoke(token, grant.userID);
      await database.db
        .delete(authVerification)
        .where(
          and(
            like(authVerification.identifier, "factory-editor:%"),
            lte(authVerification.expiresAt, expression`now()`),
          ),
        );
      // Account/membership revocation targets all retained nonces for that
      // person. Ordinary transport sweeps need only their local live grants,
      // not a per-credential authority round trip for every inactive person.
      if (!userID) return;
      const rows = await database.db
        .select({ id: authVerification.id, value: authVerification.value })
        .from(authVerification)
        .where(like(authVerification.identifier, `${prefix(userID)}%`));
      for (const row of rows) {
        const grant = decode(row.value);
        if (!grant || !(await valid(grant)))
          await database.db.delete(authVerification).where(eq(authVerification.id, row.id));
      }
    },
  };
}
