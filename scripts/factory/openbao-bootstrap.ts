import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { z } from "zod";

const bootstrapSchema = z.object({
  keys_base64: z.array(z.string().min(1)).length(1),
  root_token: z.string(),
});
const loginSchema = z.object({ role_id: z.string().min(1), secret_id: z.string().min(1) });
export const openBaoPolicy =
  'path "factory/data/projects/*" { capabilities = ["create", "read", "update"] }\npath "factory/data/models/*" { capabilities = ["create", "read", "update"] }\npath "factory/data/identity/*" { capabilities = ["create", "read", "update"] }\npath "factory/data/imports/*" { capabilities = ["create", "read", "update"] }\npath "factory/metadata/imports/*" { capabilities = ["delete"] }\npath "auth/token/renew-self" { capabilities = ["update"] }';
export const openBaoPolicyVersion = new Bun.CryptoHasher("sha256")
  .update(openBaoPolicy)
  .digest("hex");

class BootstrapHTTPError extends Error {
  constructor(
    readonly status: number,
    path: string,
  ) {
    super(`OpenBao bootstrap ${path} returned HTTP ${status}`);
  }
}

async function retained(file: string) {
  return readFile(file, "utf8").catch((cause: NodeJS.ErrnoException) => {
    if (cause.code === "ENOENT") return null;
    throw cause;
  });
}

async function privateWrite(file: string, content: unknown) {
  const temporary = `${file}.${crypto.randomUUID()}`;
  await writeFile(temporary, JSON.stringify(content), { mode: 0o600, flag: "wx" });
  await rename(temporary, file);
}

// Bootstrap is infrastructure work. Only the scoped, renewable AppRole token is
// handed to the running application; the root token is revoked before readiness.
export async function bootstrapOpenBao(input: {
  directory: string;
  address: string;
  caFile: string;
  refreshPolicy?: boolean;
  fetch?: (url: URL, options: RequestInit) => Promise<Response>;
}) {
  await mkdir(input.directory, { recursive: true, mode: 0o700 });
  const address = new URL(input.address);
  if (address.protocol !== "https:" || address.username || address.password)
    throw new Error("OpenBao requires authenticated TLS");
  const ca = await readFile(input.caFile, "utf8");
  async function api(path: string, body?: unknown, token?: string, method?: "DELETE") {
    const options = {
      method: method ?? (body === undefined ? "GET" : "POST"),
      redirect: "error" as const,
      // Initial Raft election and barrier creation may use the native 90-second
      // request window. Aborting this write early can lose the only unseal keys.
      signal: AbortSignal.timeout(path === "sys/init" ? 120_000 : 10_000),
      tls: { ca },
      headers: { "content-type": "application/json", ...(token ? { "X-Vault-Token": token } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    };
    const response = await (input.fetch ?? fetch)(new URL(`/v1/${path}`, address), options);
    if (!response.ok) {
      await response.body?.cancel();
      throw new BootstrapHTTPError(response.status, path);
    }
    if (response.status === 204) {
      await response.body?.cancel();
      return undefined;
    }
    return response.json();
  }
  let health: { initialized: boolean; sealed: boolean } | undefined;
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    try {
      health = z
        .object({ initialized: z.boolean(), sealed: z.boolean() })
        .parse(await api("sys/seal-status"));
      break;
    } catch {
      await Bun.sleep(500);
    }
  }
  if (!health) throw new Error("OpenBao did not become reachable over verified TLS");
  const bootstrapFile = resolve(input.directory, "bootstrap.json");
  const loginFile = resolve(input.directory, "factory-login.json");
  const tokenFile = resolve(input.directory, "factory-token");
  const policyFile = resolve(input.directory, "factory-policy-version");
  const previous = await retained(bootstrapFile);
  if (!health.initialized) {
    if (previous !== null)
      throw new Error(
        "OpenBao storage lost its initialized identity; retained keys were preserved",
      );
    await privateWrite(resolve(input.directory, "openbao-initialize-intent.json"), {
      address: address.origin,
    });
    const initialized = bootstrapSchema.parse(
      await api("sys/init", { secret_shares: 1, secret_threshold: 1 }),
    );
    await privateWrite(bootstrapFile, initialized);
  }
  const raw = await retained(bootstrapFile);
  if (raw === null)
    throw new Error(
      "OpenBao is initialized but its original unseal material is unavailable; storage was not reset",
    );
  const bootstrap = bootstrapSchema.parse(JSON.parse(raw));
  if (health.sealed) await api("sys/unseal", { key: bootstrap.keys_base64[0] });
  let active = false;
  while (Date.now() < deadline) {
    const healthOptions = {
      tls: { ca },
      signal: AbortSignal.timeout(1000),
    };
    const status = await (input.fetch ?? fetch)(
      new URL("/v1/sys/health", address),
      healthOptions,
    ).catch(() => null);
    active = status?.status === 200;
    await status?.body?.cancel();
    if (active) break;
    await Bun.sleep(250);
  }
  if (!active) throw new Error("OpenBao did not establish active encrypted storage");
  if (bootstrap.root_token) {
    const validRoot = await api("auth/token/lookup-self", undefined, bootstrap.root_token).then(
      () => true,
      (cause: unknown) => {
        if (cause instanceof BootstrapHTTPError && cause.status === 403) return false;
        throw cause;
      },
    );
    if (!validRoot) {
      if (
        (await retained(loginFile)) === null ||
        (await retained(policyFile)) !== openBaoPolicyVersion
      )
        throw new Error(
          "OpenBao root revocation is unconfirmed and its scoped login is unavailable",
        );
      bootstrap.root_token = "";
      await privateWrite(bootstrapFile, bootstrap);
    }
  }
  if (input.refreshPolicy && !bootstrap.root_token) {
    const status = z.object({ started: z.boolean() }).parse(await api("sys/generate-root/attempt"));
    if (status.started)
      throw new Error("OpenBao has an active root generation; progress was preserved");
    const attempt = z
      .object({ nonce: z.string(), otp: z.string() })
      .parse(await api("sys/generate-root/attempt", {}));
    let root: string | undefined;
    try {
      const result = z.object({ complete: z.literal(true), encoded_token: z.string() }).parse(
        await api("sys/generate-root/update", {
          nonce: attempt.nonce,
          key: bootstrap.keys_base64[0],
        }),
      );
      const bytes = Buffer.from(result.encoded_token, "base64");
      const otp = Buffer.from(attempt.otp);
      if (bytes.length !== otp.length) throw new Error("OpenBao root encoding is invalid");
      root = Buffer.from(bytes.map((value, index) => value ^ (otp[index] ?? 0))).toString();
      await api("sys/policies/acl/factory-environments", { policy: openBaoPolicy }, root);
      await writeFile(policyFile, openBaoPolicyVersion, { mode: 0o600 });
    } finally {
      if (root) await api("auth/token/revoke-self", {}, root);
      // Cancellation is restricted to the exact attempt created above.
      const current = z
        .object({ started: z.boolean(), nonce: z.string().optional() })
        .parse(await api("sys/generate-root/attempt"));
      if (current.started && current.nonce === attempt.nonce) {
        await api("sys/generate-root/attempt", undefined, undefined, "DELETE");
      }
    }
  }
  if (bootstrap.root_token) {
    const root = bootstrap.root_token;
    const mounts = z
      .record(z.string(), z.unknown())
      .parse(await api("sys/mounts", undefined, root));
    if (!mounts["factory/"])
      await api("sys/mounts/factory", { type: "kv", options: { version: "2" } }, root);
    await api("sys/policies/acl/factory-environments", { policy: openBaoPolicy }, root);
    const auth = z.record(z.string(), z.unknown()).parse(await api("sys/auth", undefined, root));
    if (!auth["approle/"]) await api("sys/auth/approle", { type: "approle" }, root);
    await api(
      "auth/approle/role/factory-environments",
      {
        token_policies: ["factory-environments"],
        token_no_default_policy: true,
        token_period: "24h",
        secret_id_num_uses: 0,
        secret_id_ttl: 0,
      },
      root,
    );
    if ((await retained(loginFile)) === null) {
      const role = z
        .object({ data: z.object({ role_id: z.string() }) })
        .parse(await api("auth/approle/role/factory-environments/role-id", undefined, root));
      // Persist the intended secret before creation. A lost response can be
      // verified by logging in with that same secret rather than issuing another.
      const secretFile = resolve(input.directory, "openbao-secret-id.json");
      const secretRaw = await retained(secretFile);
      const secretID = secretRaw
        ? z.string().parse(JSON.parse(secretRaw))
        : `${crypto.randomUUID()}${crypto.randomUUID()}`;
      if (!secretRaw) await privateWrite(secretFile, secretID);
      const login = { role_id: role.data.role_id, secret_id: secretID };
      const alreadyCreated = await api(
        "auth/approle/role/factory-environments/secret-id/lookup",
        { secret_id: secretID },
        root,
      ).then(
        (result) => result !== undefined,
        (cause: unknown) => {
          if (cause instanceof BootstrapHTTPError && [400, 404].includes(cause.status))
            return false;
          throw cause;
        },
      );
      if (!alreadyCreated)
        await api(
          "auth/approle/role/factory-environments/custom-secret-id",
          { secret_id: secretID },
          root,
        );
      await privateWrite(loginFile, login);
    }
    await writeFile(policyFile, openBaoPolicyVersion, { mode: 0o600 });
  }
  if ((await retained(policyFile)) !== openBaoPolicyVersion)
    throw new Error(
      "OpenBao policy update needs its controlled maintenance bootstrap; data was preserved",
    );
  const oldToken = (await retained(tokenFile))?.trim();
  const renewed = oldToken
    ? await api("auth/token/renew-self", {}, oldToken).then(
        () => true,
        () => false,
      )
    : false;
  if (!renewed) {
    const loginRaw = await retained(loginFile);
    if (!loginRaw) throw new Error("OpenBao AppRole login is unavailable; keys were preserved");
    const login = loginSchema.parse(JSON.parse(loginRaw));
    const issued = z
      .object({ auth: z.object({ client_token: z.string().min(1) }) })
      .parse(await api("auth/approle/login", login));
    const temporary = `${tokenFile}.${crypto.randomUUID()}`;
    await writeFile(temporary, issued.auth.client_token, { mode: 0o600, flag: "wx" });
    await rename(temporary, tokenFile);
  }
  if (bootstrap.root_token) {
    await api("auth/token/revoke-self", {}, bootstrap.root_token);
    await privateWrite(bootstrapFile, { keys_base64: bootstrap.keys_base64, root_token: "" });
  }
  return { tokenFile };
}
