import type { createDatabase } from "../../../../packages/db/src/client";
import { CommandError } from "../command-error";
import { createAccessController } from "./controller";

type Grant = {
  attemptID: string;
  channel: "app" | "ide";
  appChannel?: string;
  userID: string;
  sessionID: string;
  expires: number;
  mode: "embedded" | "top-level";
};

export function createRuntimeAccess(
  database: ReturnType<typeof createDatabase>,
  onRevoke: (token: string) => void,
) {
  const access = createAccessController(database);
  const grants = new Map<string, Grant>();
  function revoke(token: string) {
    grants.delete(token);
    onRevoke(token);
  }
  async function valid(grant: Grant) {
    if (grant.expires <= Date.now()) return false;
    const sessions = await database.client`SELECT id FROM auth.session
      WHERE id = ${grant.sessionID} AND user_id = ${grant.userID} AND expires_at > now()
        AND login_method<>'identity-test' AND (login_method<>'sso' OR authenticated_at>now()-interval '24 hours')`;
    if (!sessions.length) return false;
    try {
      await access.requireRuntime(grant.userID, grant.attemptID, grant.channel);
      return true;
    } catch (cause) {
      if (cause instanceof CommandError) return false;
      throw cause;
    }
  }
  return {
    async issue(grant: Grant) {
      if (!(await valid(grant))) throw new CommandError("forbidden", "Runtime access required");
      const token = crypto.randomUUID();
      grants.set(token, grant);
      return token;
    },
    async authorize(
      request: Request,
      attemptID: string,
      channel: "app" | "ide",
      appChannel = "app",
    ) {
      const token = request.headers
        .get("cookie")
        ?.split(";")
        .map((part) => part.trim().split("="))
        .find(([name]) => name === "factory_runtime_access")?.[1];
      if (!token) return undefined;
      const grant = grants.get(token);
      if (
        !grant ||
        grant.attemptID !== attemptID ||
        grant.channel !== channel ||
        (channel === "app" && (grant.appChannel ?? "app") !== appChannel)
      )
        return undefined;
      if (!(await valid(grant)) || grants.get(token) !== grant) {
        revoke(token);
        return undefined;
      }
      return token;
    },
    async redeem(
      url: URL,
      attemptID: string,
      channel: "app" | "ide",
      cookiePath: string,
      appChannel = "app",
    ) {
      const token = url.searchParams.get("factory-grant");
      const grant = token ? grants.get(token) : undefined;
      if (
        !token ||
        !grant ||
        grant.attemptID !== attemptID ||
        grant.channel !== channel ||
        (channel === "app" && (grant.appChannel ?? "app") !== appChannel)
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
      const attributes =
        grant.mode === "embedded"
          ? "HttpOnly; SameSite=None; Secure; Partitioned"
          : `HttpOnly; SameSite=Lax${url.protocol === "https:" ? "; Secure" : ""}`;
      const headers = new Headers({
        location: url.toString(),
        "referrer-policy": "no-referrer",
        "set-cookie": `factory_runtime_access=${accessToken}; Path=${cookiePath}; ${attributes}; Max-Age=28800`,
      });
      if (channel === "app" && cookiePath === "/") {
        // A newly redeemed origin-scoped credential replaces the exact
        // path-scoped credentials previously issued on this same App host.
        // Otherwise a stale, more-specific cookie shadows the fresh grant.
        for (const path of [
          `/runtime/${attemptID}/app/`,
          `/runtime/${attemptID}/preview/${appChannel}/`,
        ])
          headers.append(
            "set-cookie",
            `factory_runtime_access=; Path=${path}; ${attributes}; Max-Age=0`,
          );
      }
      return new Response(null, {
        status: 302,
        headers,
      });
    },
    has(token: string) {
      const grant = grants.get(token);
      return Boolean(grant && grant.expires > Date.now());
    },
    async user(token: string) {
      const grant = grants.get(token);
      if (!grant || !(await valid(grant)) || grants.get(token) !== grant)
        throw new CommandError("forbidden", "Runtime access revoked");
      return grant.userID;
    },
    revoke,
    revokeAttempt(attemptID: string) {
      for (const [token, grant] of grants) {
        if (grant.attemptID === attemptID) revoke(token);
      }
    },
    async revokeMember(projectID: string, userID: string) {
      const attempts = await database.client<Array<{ id: string }>>`
        SELECT id FROM factory.runtime_attempt WHERE project_id = ${projectID}`;
      const ids = new Set(attempts.map((attempt) => attempt.id));
      for (const [token, grant] of grants) {
        if (grant.userID === userID && ids.has(grant.attemptID)) revoke(token);
      }
    },
    async sweep() {
      for (const [token, grant] of grants) {
        if (!(await valid(grant))) revoke(token);
      }
    },
  };
}
