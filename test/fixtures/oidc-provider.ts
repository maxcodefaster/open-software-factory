import { generateKeyPairSync, sign } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

type Identity = { subject: string; email: string; oldAuthentication?: boolean };

// An owned TLS IdP with real RS256 signatures, one-use authorization codes and PKCE.
export async function oidcProviderFixture() {
  const directory = await mkdtemp(join(tmpdir(), "factory-owned-oidc-"));
  const cert = join(directory, "cert.pem");
  const key = join(directory, "key.pem");
  const generated = Bun.spawn(
    [
      "mise",
      "exec",
      "--",
      "mkcert",
      "-cert-file",
      cert,
      "-key-file",
      key,
      "localhost",
      "127.0.0.1",
    ],
    { stdout: "ignore", stderr: "ignore" },
  );
  if ((await generated.exited) !== 0) {
    await rm(directory, { recursive: true });
    throw new Error("Owned OIDC TLS certificate unavailable");
  }
  const keys = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const codes = new Map<string, Identity & { nonce: string; challenge: string }>();
  let exchanges = 0;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    tls: { cert: Bun.file(cert), key: Bun.file(key) },
    async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === "/.well-known/openid-configuration")
        return Response.json({
          issuer: url.origin,
          authorization_endpoint: `${url.origin}/authorize`,
          token_endpoint: `${url.origin}/token`,
          jwks_uri: `${url.origin}/jwks`,
          response_types_supported: ["code"],
          id_token_signing_alg_values_supported: ["RS256"],
          token_endpoint_auth_methods_supported: ["client_secret_post"],
        });
      if (url.pathname === "/jwks")
        return Response.json({
          keys: [
            { ...keys.publicKey.export({ format: "jwk" }), kid: "owned", alg: "RS256", use: "sig" },
          ],
        });
      if (url.pathname !== "/token") return new Response(null, { status: 404 });
      const form = await request.formData();
      const code = codes.get(String(form.get("code")));
      codes.delete(String(form.get("code")));
      const challenge = new Bun.CryptoHasher("sha256")
        .update(String(form.get("code_verifier")))
        .digest("base64url");
      if (
        !code ||
        form.get("client_secret") !== "owned-oidc-client-secret" ||
        challenge !== code.challenge
      )
        return Response.json({ error: "invalid_grant" }, { status: 400 });
      exchanges++;
      const now = Math.floor(Date.now() / 1000);
      const header = Buffer.from(JSON.stringify({ alg: "RS256", kid: "owned" })).toString(
        "base64url",
      );
      const payload = Buffer.from(
        JSON.stringify({
          iss: url.origin,
          aud: "owned-factory",
          sub: code.subject,
          email: code.email,
          name: "Owned company member",
          nonce: code.nonce,
          auth_time: now - (code.oldAuthentication ? 600 : 0),
          iat: now,
          exp: now + 300,
        }),
      ).toString("base64url");
      const signature = sign(
        "RSA-SHA256",
        Buffer.from(`${header}.${payload}`),
        keys.privateKey,
      ).toString("base64url");
      return Response.json({
        token_type: "Bearer",
        access_token: "owned-token-never-store",
        id_token: `${header}.${payload}.${signature}`,
        expires_in: 300,
      });
    },
  });
  return {
    issuer: server.url.origin,
    exchanges: () => exchanges,
    callback(authorization: string, identity: Identity) {
      const url = new URL(authorization);
      const code = crypto.randomUUID();
      codes.set(code, {
        ...identity,
        nonce: url.searchParams.get("nonce") ?? "",
        challenge: url.searchParams.get("code_challenge") ?? "",
      });
      const callback = new URL(url.searchParams.get("redirect_uri") ?? "");
      callback.searchParams.set("code", code);
      callback.searchParams.set("state", url.searchParams.get("state") ?? "");
      return callback;
    },
    async dispose() {
      await server.stop(true);
      await rm(directory, { recursive: true });
    },
  };
}
