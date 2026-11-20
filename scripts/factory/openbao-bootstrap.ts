import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { z } from "zod";

const bootstrapSchema = z.object({
  keys_base64: z.array(z.string().min(1)).length(1),
  root_token: z.string(),
});
const loginSchema = z.object({ role_id: z.string().min(1), secret_id: z.string().min(1) });
export const openBaoPolicy =
  'path "factory/data/projects/*" { capabilities = ["create", "read", "update"] }\npath "factory/data/models/*" { capabilities = ["create", "read", "update"] }\npath "factory/data/mcp/*" { capabilities = ["create", "read"] }\npath "factory/data/identity/*" { capabilities = ["create", "read", "update"] }\npath "factory/data/imports/*" { capabilities = ["create", "read", "update"] }\npath "factory/metadata/imports/*" { capabilities = ["delete"] }\npath "factory/data/release-access/*" { capabilities = ["create", "read"] }\npath "factory/data/release-publish/*" { capabilities = ["create", "read"] }\npath "auth/token/renew-self" { capabilities = ["update"] }';
export const backupPolicy =
  'path "sys/storage/raft/snapshot" { capabilities = ["read"] }\npath "auth/token/renew-self" { capabilities = ["update"] }';
// Writes only the two policies and two AppRoles below. It cannot touch mounts, seal state or its own
// policy, and its token lives 15 minutes. Initial bootstrap fixes this administrator's authority.
export const adminPolicy = [
  'path "sys/policies/acl/factory-environments" { capabilities = ["create", "read", "update"] }',
  'path "sys/policies/acl/factory-backup" { capabilities = ["create", "read", "update"] }',
  'path "auth/approle/role/factory-environments" { capabilities = ["create", "read", "update"] }',
  'path "auth/approle/role/factory-backup" { capabilities = ["create", "read", "update"] }',
  'path "auth/approle/role/factory-backup/role-id" { capabilities = ["read"] }',
  'path "auth/approle/role/factory-backup/custom-secret-id" { capabilities = ["update"] }',
  'path "auth/approle/role/factory-backup/secret-id/lookup" { capabilities = ["update"] }',
  'path "auth/token/revoke-self" { capabilities = ["update"] }',
].join("\n");
// The version covers only the policies the retained administrator identity can rewrite.
export const openBaoPolicyVersion = new Bun.CryptoHasher("sha256")
  .update(openBaoPolicy)
  .update("\0")
  .update(backupPolicy)
  .digest("hex");

const applicationRole = {
  token_policies: ["factory-environments"],
  token_no_default_policy: true,
  token_period: "24h",
  secret_id_num_uses: 0,
  secret_id_ttl: 0,
};
const backupRole = {
  token_policies: ["factory-backup"],
  token_no_default_policy: true,
  token_ttl: "2h",
  token_max_ttl: "2h",
  secret_id_num_uses: 0,
  secret_id_ttl: 0,
};
const adminRole = {
  token_policies: ["factory-admin"],
  token_no_default_policy: true,
  token_ttl: "15m",
  token_max_ttl: "15m",
  secret_id_num_uses: 0,
  secret_id_ttl: 0,
};

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

export type OpenBaoLogin = z.output<typeof loginSchema>;

// Bootstrap is infrastructure work. Only the scoped, renewable AppRole token is
// handed to the running application; the root token is revoked before readiness.
// A least-privilege backup login is returned for the backup Job. Later policy updates use a
// short-lived retained `factory-admin` AppRole. Missing administrator credentials refuse an
// upgrade without generating another root token or changing the retained store's identity.
export async function bootstrapOpenBao(input: {
  directory: string;
  address: string;
  caFile: string;
  fetch?: (url: URL, options: RequestInit) => Promise<Response>;
}) {
  await mkdir(input.directory, { recursive: true, mode: 0o700 });
  const address = new URL(input.address);
  if (address.protocol !== "https:" || address.username || address.password)
    throw new Error("OpenBao requires authenticated TLS");
  const ca = await readFile(input.caFile, "utf8");
  async function api(path: string, body?: unknown, token?: string) {
    const options = {
      method: body === undefined ? "GET" : "POST",
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
  const backupFile = resolve(input.directory, "factory-backup-login.json");
  const adminFile = resolve(input.directory, "factory-admin-login.json");
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
      bootstrap.root_token = "";
      await privateWrite(bootstrapFile, bootstrap);
    }
  }

  // The same writes run with the initial root token or the retained admin token. Each is
  // idempotent, so interrupted bootstrap and policy upgrades reuse their original credentials.
  async function ensureLogin(
    role: string,
    files: { login: string; intent: string },
    token: string,
  ) {
    const existing = await retained(files.login);
    if (existing !== null) return loginSchema.parse(JSON.parse(existing));
    const roleID = z
      .object({ data: z.object({ role_id: z.string() }) })
      .parse(await api(`auth/approle/role/${role}/role-id`, undefined, token));
    // Persist the intended secret before creation. A lost response can be
    // verified by logging in with that same secret rather than issuing another.
    const intended = await retained(files.intent);
    const secretID = intended
      ? z.string().parse(JSON.parse(intended))
      : `${crypto.randomUUID()}${crypto.randomUUID()}`;
    if (!intended) await privateWrite(files.intent, secretID);
    const login = { role_id: roleID.data.role_id, secret_id: secretID };
    const alreadyCreated = await api(
      `auth/approle/role/${role}/secret-id/lookup`,
      { secret_id: secretID },
      token,
    ).then(
      (result) => result !== undefined,
      (cause: unknown) => {
        if (cause instanceof BootstrapHTTPError && [400, 404].includes(cause.status)) return false;
        throw cause;
      },
    );
    if (!alreadyCreated)
      await api(`auth/approle/role/${role}/custom-secret-id`, { secret_id: secretID }, token);
    await privateWrite(files.login, login);
    return login;
  }
  const applicationFiles = {
    login: loginFile,
    intent: resolve(input.directory, "openbao-secret-id.json"),
  };
  const backupFiles = {
    login: backupFile,
    intent: resolve(input.directory, "openbao-backup-secret-id.json"),
  };
  const adminFiles = {
    login: adminFile,
    intent: resolve(input.directory, "openbao-admin-secret-id.json"),
  };
  async function provisionPolicies(token: string) {
    await api("sys/policies/acl/factory-environments", { policy: openBaoPolicy }, token);
    await api("sys/policies/acl/factory-backup", { policy: backupPolicy }, token);
    await api("auth/approle/role/factory-environments", applicationRole, token);
    await api("auth/approle/role/factory-backup", backupRole, token);
    await ensureLogin("factory-backup", backupFiles, token);
  }
  async function provisionRoot(root: string) {
    const mounts = z
      .record(z.string(), z.unknown())
      .parse(await api("sys/mounts", undefined, root));
    if (!mounts["factory/"])
      await api("sys/mounts/factory", { type: "kv", options: { version: "2" } }, root);
    const auth = z.record(z.string(), z.unknown()).parse(await api("sys/auth", undefined, root));
    if (!auth["approle/"]) await api("sys/auth/approle", { type: "approle" }, root);
    await api("sys/policies/acl/factory-admin", { policy: adminPolicy }, root);
    await api("auth/approle/role/factory-admin", adminRole, root);
    await provisionPolicies(root);
    await ensureLogin("factory-environments", applicationFiles, root);
    await ensureLogin("factory-admin", adminFiles, root);
    await writeFile(policyFile, openBaoPolicyVersion, { mode: 0o600 });
  }

  if (bootstrap.root_token) {
    await provisionRoot(bootstrap.root_token);
  } else if (
    (await retained(policyFile)) !== openBaoPolicyVersion ||
    (await retained(backupFile)) === null ||
    (await retained(adminFile)) === null
  ) {
    const adminRaw = await retained(adminFile);
    if (adminRaw) {
      const admin = await api("auth/approle/login", loginSchema.parse(JSON.parse(adminRaw)));
      const token = z.object({ auth: z.object({ client_token: z.string().min(1) }) }).parse(admin)
        .auth.client_token;
      try {
        await provisionPolicies(token);
        await writeFile(policyFile, openBaoPolicyVersion, { mode: 0o600 });
      } finally {
        await api("auth/token/revoke-self", {}, token).catch(() => undefined);
      }
    }
  }
  if (
    (await retained(policyFile)) !== openBaoPolicyVersion ||
    (await retained(backupFile)) === null ||
    (await retained(adminFile)) === null
  )
    throw new Error(
      "OpenBao policy update requires its retained administrator AppRole; data was preserved",
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
  const backup = loginSchema.parse(JSON.parse((await retained(backupFile)) ?? "null"));
  return { tokenFile, backup };
}
