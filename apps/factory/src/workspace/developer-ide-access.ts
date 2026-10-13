import type { createDatabase } from "../../../../packages/db/src/client";
import type { createDeveloperIDEController } from "./developer-ide-controller";
import { CommandError } from "../command-error";

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
export function developerIDEOrigin(factoryOrigin: string, userID: string, epoch: number) {
  const origin = new URL(factoryOrigin);
  origin.hostname = `${userID.replaceAll("-", "")}.${epoch}.editor.runtime.localhost`;
  return origin.origin;
}
export function createDeveloperIDEAccess(
  database: ReturnType<typeof createDatabase>,
  editors: ReturnType<typeof createDeveloperIDEController>,
  factoryOrigin: string,
  onRevoke: (token: string) => void,
) {
  const grants = new Map<string, DeveloperIDEGrant>();
  function revoke(token: string) {
    grants.delete(token);
    onRevoke(token);
  }
  async function valid(grant: DeveloperIDEGrant) {
    if (grant.expires <= Date.now()) return false;
    const sessions =
      await database.client`SELECT id FROM auth.session WHERE id=${grant.sessionID} AND user_id=${grant.userID} AND expires_at > now()
        AND login_method<>'identity-test' AND (login_method<>'sso' OR authenticated_at>now()-interval '24 hours')`;
    if (!sessions.length) return false;
    try {
      const current = await editors.get(grant.userID);
      return current.epoch === grant.epoch && current.state === "ready";
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
      // Bound transient grants, including tabs that were never redeemed.
      const owned = [...grants].filter(([, value]) => value.userID === grant.userID);
      for (const [token] of owned.slice(0, Math.max(0, owned.length - 31))) revoke(token);
      const token = crypto.randomUUID();
      grants.set(token, grant);
      return token;
    },
    async redeem(url: URL, userID: string, epoch: number) {
      const token = url.searchParams.get("factory-grant");
      const grant = token ? grants.get(token) : undefined;
      if (
        !token ||
        !grant ||
        grant.userID !== userID ||
        grant.epoch !== epoch ||
        !originMatches(url, grant)
      )
        return undefined;
      if (!(await valid(grant)) || grants.get(token) !== grant) {
        revoke(token);
        return undefined;
      }
      grants.delete(token);
      const accessToken = crypto.randomUUID();
      grants.set(accessToken, grant);
      url.searchParams.delete("factory-grant");
      return new Response(null, {
        status: 302,
        headers: {
          location: url.href,
          "referrer-policy": "no-referrer",
          "cache-control": "no-store",
          "set-cookie": `factory_editor_access=${accessToken}; Path=${developerIDEPath(userID, epoch)}; HttpOnly; ${grant.embedded ? "SameSite=None; Secure; Partitioned" : "SameSite=Lax"}; Max-Age=28800`,
        },
      });
    },
    async authorize(request: Request, userID: string, epoch: number) {
      const token = request.headers
        .get("cookie")
        ?.split(";")
        .map((value) => value.trim().split("="))
        .find(([name]) => name === "factory_editor_access")?.[1];
      const grant = token ? grants.get(token) : undefined;
      if (
        !token ||
        !grant ||
        grant.userID !== userID ||
        grant.epoch !== epoch ||
        !originMatches(new URL(request.url), grant)
      )
        return undefined;
      if (!(await valid(grant)) || grants.get(token) !== grant) {
        revoke(token);
        return undefined;
      }
      return { token, grant };
    },
    has(token: string) {
      const grant = grants.get(token);
      return Boolean(grant && grant.expires > Date.now());
    },
    revokeUser(userID: string) {
      for (const [token, grant] of grants) if (grant.userID === userID) revoke(token);
    },
    async sweep(userID?: string) {
      for (const [token, grant] of grants)
        if ((!userID || grant.userID === userID) && !(await valid(grant))) revoke(token);
    },
  };
}
