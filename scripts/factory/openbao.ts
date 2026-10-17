import { chmod, lstat, mkdir, readFile, realpath, rename, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { z } from "zod";
import upstream from "../../upstream.json";

const identitySchema = z
  .object({ owner: z.uuid(), port: z.number().int().min(1024).max(65535) })
  .strict();
const bootstrapSchema = z.object({
  keys_base64: z.array(z.string()).length(1),
  root_token: z.string(),
});
const policy =
  'path "factory/data/projects/*" { capabilities = ["create", "read", "update"] }\npath "factory/data/models/*" { capabilities = ["create", "read", "update"] }\npath "factory/data/identity/*" { capabilities = ["create", "read", "update"] }\npath "factory/data/imports/*" { capabilities = ["create", "read", "update"] }\npath "factory/metadata/imports/*" { capabilities = ["delete"] }\npath "auth/token/renew-self" { capabilities = ["update"] }';

// Concrete local OpenBao service, independent of Project execution. No dev mode or root token in Factory.
export async function localOpenBao(stateDirectory: string, compose?: readonly string[]) {
  const directory = resolve(await realpath(stateDirectory), "openbao");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  if ((await realpath(directory)) !== directory)
    throw new Error("OpenBao state must not be redirected");
  const identityFile = resolve(directory, "identity.json");
  const existing = await lstat(identityFile).catch((cause: unknown) => {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw cause;
  });
  if (existing && !existing.isFile()) throw new Error("Invalid OpenBao identity file");
  if (!existing) {
    const listener = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
    try {
      await writeFile(
        identityFile,
        JSON.stringify({ owner: crypto.randomUUID(), port: listener.port }),
        { mode: 0o600, flag: "wx" },
      );
    } finally {
      await listener.stop(true);
    }
  }
  const identity = identitySchema.parse(JSON.parse(await readFile(identityFile, "utf8")));
  const container = `factory-openbao-${identity.owner}`;
  const volume = `${container}-data`;
  async function command(args: string[], input?: string, env?: Record<string, string>) {
    const child = Bun.spawn(args, {
      env: { ...process.env, ...env },
      stdin: input === undefined ? "ignore" : "pipe",
      stdout: "pipe",
      stderr: "ignore",
    });
    if (input !== undefined && child.stdin) {
      child.stdin.write(input);
      child.stdin.end();
    }
    const timer = setTimeout(() => child.kill("SIGKILL"), 60_000);
    const [output, code] = await Promise.all([
      new Response(child.stdout).text(),
      child.exited,
    ]).finally(() => clearTimeout(timer));
    if (code !== 0)
      throw new Error(
        `OpenBao local ${args[0]} operation failed. Sensitive diagnostics suppressed.`,
      );
    return output.trim();
  }
  async function docker(...args: string[]) {
    return command(["docker", ...args]);
  }
  async function owned(kind: "container" | "volume", name: string) {
    const ids = await docker(
      kind === "container" ? "ps" : "volume",
      ...(kind === "container"
        ? ["--all", "--filter", `name=^${name}$`, "--format", "{{.Names}}"]
        : ["ls", "--filter", `name=^${name}$`, "--format", "{{.Name}}"]),
    );
    if (!ids) return false;
    const found = await docker(
      kind,
      "inspect",
      "--format",
      kind === "container"
        ? '{{index .Config.Labels "factory.openbao-owner"}}'
        : '{{index .Labels "factory.openbao-owner"}}',
      name,
    );
    if (found !== identity.owner) throw new Error("OpenBao local ownership conflict");
    return true;
  }
  const configDirectory = resolve(directory, "config");
  await mkdir(configDirectory, { recursive: true, mode: 0o700 });
  const certificate = resolve(configDirectory, "tls.crt");
  const key = resolve(configDirectory, "tls.key");
  if (!(await lstat(certificate).catch(() => undefined))) {
    await command([
      "mkcert",
      "-cert-file",
      certificate,
      "-key-file",
      key,
      "localhost",
      "127.0.0.1",
    ]);
    await chmod(key, 0o600);
  }
  const config = {
    storage: { raft: { path: "/bao/data", node_id: identity.owner } },
    api_addr: "https://127.0.0.1:8200",
    cluster_addr: "https://127.0.0.1:8201",
    listener: {
      tcp: {
        address: "0.0.0.0:8200",
        tls_cert_file: "/bao/config/tls.crt",
        tls_key_file: "/bao/config/tls.key",
      },
    },
    ui: false,
  };
  await writeFile(resolve(configDirectory, "config.json"), JSON.stringify(config), { mode: 0o600 });
  const address = `https://127.0.0.1:${identity.port}`;
  const caFile = resolve(await command(["mkcert", "-CAROOT"]), "rootCA.pem");
  const ca = await readFile(caFile, "utf8");
  const tokenFile = resolve(directory, "factory-token");
  const loginFile = resolve(directory, "factory-login.json");
  const policyFile = resolve(directory, "factory-policy-version");
  const policyVersion = new Bun.CryptoHasher("sha256").update(policy).digest("hex");
  const loginSchema = z
    .object({ role_id: z.string().min(1), secret_id: z.string().min(1) })
    .strict();
  async function protectedWrite(path: string, value: string) {
    const temporary = `${path}.${crypto.randomUUID()}`;
    await writeFile(temporary, value, { mode: 0o600, flag: "wx" });
    await rename(temporary, path);
  }
  async function api(path: string, body?: unknown, token?: string, method?: "DELETE") {
    const response = await fetch(`${address}/v1/${path}`, {
      tls: { ca },
      method: method ?? (body === undefined ? "GET" : "POST"),
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
      headers: { "content-type": "application/json", ...(token ? { "X-Vault-Token": token } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(
        `OpenBao bootstrap ${path} failed with ${response.status}. Sensitive diagnostics suppressed.`,
      );
    }
    return response.status === 204 ? undefined : response.json();
  }
  async function applyPolicy(bootstrapFile: string) {
    const bootstrap = bootstrapSchema.parse(JSON.parse(await readFile(bootstrapFile, "utf8")));
    if (bootstrap.root_token) {
      await api("sys/policies/acl/factory-environments", { policy }, bootstrap.root_token);
      return;
    }
    const status = z.object({ started: z.boolean() }).parse(await api("sys/generate-root/attempt"));
    if (status.started)
      throw new Error("OpenBao has an active root generation. Existing progress was preserved.");
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
      await api("sys/policies/acl/factory-environments", { policy }, root);
    } finally {
      if (root) await api("auth/token/revoke-self", {}, root);
      const current = z
        .object({ started: z.boolean(), nonce: z.string().optional() })
        .parse(await api("sys/generate-root/attempt"));
      if (current.started && current.nonce === attempt.nonce)
        await api("sys/generate-root/attempt", undefined, undefined, "DELETE");
    }
  }
  async function startConfigured(refreshPolicy = false) {
    if (!(await owned("volume", volume)))
      await docker(
        "volume",
        "create",
        "--label",
        `factory.openbao-owner=${identity.owner}`,
        volume,
      );
    if (await owned("container", container)) {
      const image = await docker("inspect", "--format", "{{.Config.Image}}", container);
      if (image !== upstream.openbao.image) {
        // Replace only the owned process. Identity, encrypted Raft data,
        // unseal material, ACLs and the deterministic endpoint remain retained.
        await docker("pull", upstream.openbao.image);
        await docker("stop", container);
        await docker("rm", container);
      }
    }
    if (!(await owned("container", container))) {
      if (compose)
        await command([...compose, "up", "--detach", "--no-deps", "openbao"], undefined, {
          FACTORY_OPENBAO_CONTAINER: container,
          FACTORY_OPENBAO_OWNER: identity.owner,
          FACTORY_OPENBAO_VOLUME: volume,
          FACTORY_OPENBAO_CONFIG: configDirectory,
          FACTORY_OPENBAO_PORT: String(identity.port),
        });
      else
        await docker(
          "run",
          "--detach",
          "--name",
          container,
          "--label",
          `factory.openbao-owner=${identity.owner}`,
          "--user",
          "0:0",
          "--cap-drop",
          "ALL",
          "--memory",
          "512m",
          "--memory-swap",
          "512m",
          "--security-opt",
          "no-new-privileges",
          "--read-only",
          "--tmpfs",
          "/tmp:rw,noexec,nosuid,size=16m",
          "--mount",
          `type=bind,source=${configDirectory},target=/bao/config,readonly`,
          "--mount",
          `type=volume,source=${volume},target=/bao/data`,
          "--publish",
          `127.0.0.1:${identity.port}:8200`,
          "--entrypoint",
          "/usr/bin/bao",
          upstream.openbao.image,
          "server",
          "-config=/bao/config/config.json",
        );
    } else await docker(refreshPolicy ? "restart" : "start", container);
    let health: { initialized: boolean; sealed: boolean } | undefined;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      try {
        health = z
          .object({ initialized: z.boolean(), sealed: z.boolean() })
          .parse(await api("sys/seal-status"));
        break;
      } catch {
        await Bun.sleep(100);
      }
    }
    if (!health) throw new Error("OpenBao TLS service did not become available");
    const bootstrapFile = resolve(directory, "bootstrap.json");
    if (!health.initialized) {
      const initialized = bootstrapSchema.parse(
        await api("sys/init", { secret_shares: 1, secret_threshold: 1 }),
      );
      await writeFile(bootstrapFile, JSON.stringify(initialized), { mode: 0o600, flag: "wx" });
    }
    if (!(await lstat(bootstrapFile).catch(() => undefined)))
      throw new Error(
        "OpenBao was initialized but its local unseal material is missing. Supply the original unseal key; existing encrypted storage was not replaced.",
      );
    if (health.sealed) {
      const bootstrap = bootstrapSchema.parse(JSON.parse(await readFile(bootstrapFile, "utf8")));
      await api("sys/unseal", { key: bootstrap.keys_base64[0] });
    }
    let active = false;
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const response = await fetch(`${address}/v1/sys/health`, {
        tls: { ca },
        signal: AbortSignal.timeout(1000),
      }).catch(() => undefined);
      if (response) {
        active = response.status === 200;
        await response.body?.cancel();
      }
      if (active) break;
      await Bun.sleep(100);
    }
    if (!active) throw new Error("OpenBao did not establish active storage leadership");
    if (refreshPolicy) await applyPolicy(bootstrapFile);
    if (!(await lstat(loginFile).catch(() => undefined))) {
      const bootstrap = bootstrapSchema.parse(JSON.parse(await readFile(bootstrapFile, "utf8")));
      const mounts = z
        .record(z.string(), z.unknown())
        .parse(await api("sys/mounts", undefined, bootstrap.root_token));
      if (!mounts["factory/"])
        await api(
          "sys/mounts/factory",
          { type: "kv", options: { version: "2" } },
          bootstrap.root_token,
        );
      await api("sys/policies/acl/factory-environments", { policy }, bootstrap.root_token);
      const auth = z
        .record(z.string(), z.unknown())
        .parse(await api("sys/auth", undefined, bootstrap.root_token));
      if (!auth["approle/"])
        await api("sys/auth/approle", { type: "approle" }, bootstrap.root_token);
      await api(
        "auth/approle/role/factory-environments",
        {
          token_policies: ["factory-environments"],
          token_no_default_policy: true,
          token_period: "24h",
          secret_id_num_uses: 0,
          secret_id_ttl: 0,
        },
        bootstrap.root_token,
      );
      const role = z
        .object({ data: z.object({ role_id: z.string() }) })
        .parse(
          await api(
            "auth/approle/role/factory-environments/role-id",
            undefined,
            bootstrap.root_token,
          ),
        );
      const secret = z
        .object({ data: z.object({ secret_id: z.string() }) })
        .parse(
          await api("auth/approle/role/factory-environments/secret-id", {}, bootstrap.root_token),
        );
      await protectedWrite(
        loginFile,
        JSON.stringify({ role_id: role.data.role_id, secret_id: secret.data.secret_id }),
      );
    }
    await protectedWrite(policyFile, policyVersion);
    const token = await readFile(tokenFile, "utf8").catch(() => "");
    const renewed = token
      ? await api("auth/token/renew-self", {}, token.trim()).then(
          () => true,
          () => false,
        )
      : false;
    if (!renewed) {
      const login = loginSchema.parse(JSON.parse(await readFile(loginFile, "utf8")));
      const issued = z
        .object({ auth: z.object({ client_token: z.string() }) })
        .parse(await api("auth/approle/login", login));
      await protectedWrite(tokenFile, issued.auth.client_token);
    }
    // Retain only the local unseal key; never retain an installation-wide root credential.
    const bootstrap = bootstrapSchema.parse(JSON.parse(await readFile(bootstrapFile, "utf8")));
    if (bootstrap.root_token) {
      await api("auth/token/revoke-self", {}, bootstrap.root_token);
      await protectedWrite(
        bootstrapFile,
        JSON.stringify({ keys_base64: bootstrap.keys_base64, root_token: "" }),
      );
    }
    return {
      FACTORY_OPENBAO_URL: address,
      FACTORY_OPENBAO_TOKEN_FILE: tokenFile,
      FACTORY_OPENBAO_MOUNT: "factory",
      FACTORY_OPENBAO_CA_FILE: caFile,
    };
  }
  return {
    async start(refreshPolicy = false) {
      const existingLogin = await lstat(loginFile).catch(() => undefined);
      const installedPolicy = await readFile(policyFile, "utf8").catch(() => "");
      if (!refreshPolicy && (!existingLogin || installedPolicy === policyVersion))
        return startConfigured();
      // OpenBao 2.7 disables quorum-only root recovery by default. Enable it only on
      // this owned loopback service for the ACL operation, then restore the default.
      const recoveryConfig = structuredClone(config);
      Object.assign(recoveryConfig.listener.tcp, {
        disable_unauthed_generate_root_endpoints: false,
      });
      await protectedWrite(resolve(configDirectory, "config.json"), JSON.stringify(recoveryConfig));
      try {
        return await startConfigured(true);
      } finally {
        await protectedWrite(resolve(configDirectory, "config.json"), JSON.stringify(config));
        if (await owned("container", container)) {
          await docker("restart", container);
          await startConfigured();
        }
      }
    },
    container,
    volume,
    directory,
    async dispose() {
      if (await owned("container", container)) await docker("rm", "--force", container);
      if (await owned("volume", volume)) await docker("volume", "rm", volume);
    },
  };
}
