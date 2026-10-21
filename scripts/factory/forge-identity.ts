import { z } from "zod";
import { forgeClientID, forgeClientSecret } from "../../packages/auth/src/forge-issuer";

export async function ensureLocalForgeIdentity(options: {
  factoryURL: string;
  forgeURL: string;
  discoveryURL: string;
  email: string;
  password: string;
  signingKey: string;
  transportURL?: string;
  retainedSourceID?: number;
  execute: (args: string[]) => Promise<string>;
  reload: () => Promise<void>;
  installLogout?: () => Promise<void>;
}) {
  const transportURL = options.transportURL ?? options.factoryURL;
  const login = await fetch(`${transportURL}/api/auth/sign-in/email`, {
    method: "POST",
    headers: { origin: options.factoryURL, "content-type": "application/json" },
    body: JSON.stringify({ email: options.email, password: options.password }),
  });
  if (!login.ok) throw new Error("Factory emergency authentication failed during Forge setup");
  const cookie = login.headers
    .getSetCookie()
    .map((value) => value.split(";")[0])
    .join("; ");
  async function command(path: string, body: unknown) {
    const response = await fetch(`${transportURL}${path}`, {
      method: "POST",
      headers: { origin: options.factoryURL, cookie, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!response.ok) throw new Error(`Factory Forge setup returned HTTP ${response.status}`);
    return response;
  }
  try {
    const registered = await command("/api/admin/forge/client", {
      redirectURI: `${options.forgeURL}/user/oauth2/Factory/callback`,
      discoveryURL: options.discoveryURL,
    });
    const { clientID } = z
      .object({ clientID: z.literal(forgeClientID) })
      .parse(await registered.json());
    const sources = (await options.execute(["admin", "auth", "list"]))
      .split("\n")
      .map((line) => line.trim().split(/\s+/))
      .filter((columns) => columns[1] === "Factory");
    if (sources.length > 1)
      throw new Error("More than one native Factory authentication source exists");
    const sourceID = sources[0] ? Number(sources[0][0]) : undefined;
    if (options.retainedSourceID !== undefined && sourceID !== options.retainedSourceID)
      throw new Error("Native Forge identity differs from the retained installation");
    if (options.retainedSourceID === undefined) {
      await options.execute([
        "admin",
        "auth",
        sourceID ? "update-oauth" : "add-oauth",
        ...(sourceID ? ["--id", String(sourceID)] : []),
        "--name",
        "Factory",
        "--provider",
        "openidConnect",
        "--key",
        clientID,
        "--secret",
        forgeClientSecret(options.signingKey),
        "--auto-discover-url",
        options.discoveryURL,
        "--scopes",
        "openid",
        "--scopes",
        "profile",
        "--scopes",
        "email",
        "--skip-local-2fa",
      ]);
      // Native CLI changes do not reload the running provider registry. Reload before
      // first login so Forgejo can generate the required PKCE challenge immediately.
      await options.reload();
    }
    await options.installLogout?.();
    const observed = (await options.execute(["admin", "auth", "list"]))
      .split("\n")
      .map((line) => line.trim().split(/\s+/))
      .filter((columns) => columns[1] === "Factory");
    if (observed.length !== 1 || !observed[0]?.includes("OAuth2") || !observed[0]?.includes("true"))
      throw new Error("Native Factory authentication source was not confirmed");
    await command("/api/admin/forge/connection", {
      sourceID: z.coerce.number().int().positive().parse(observed[0]?.[0]),
    });
    return { sourceID: z.coerce.number().int().positive().parse(observed[0]?.[0]) };
  } finally {
    await fetch(`${transportURL}/api/auth/sign-out`, {
      method: "POST",
      headers: { origin: options.factoryURL, cookie, "content-type": "application/json" },
      body: "{}",
    });
  }
}
