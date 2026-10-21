import { chmod, lstat, mkdir, readFile, realpath, rename, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { z } from "zod";
import upstream from "../../upstream.json";
import { bootstrapOpenBao, openBaoPolicyVersion } from "./openbao-bootstrap";

const identitySchema = z
  .object({ owner: z.uuid(), port: z.number().int().min(1024).max(65535) })
  .strict();

// Only the source-development launcher supervises a host Docker service.
// Installed Factory uses the same bootstrap protocol against its Kubernetes Service.
export async function localOpenBao(stateDirectory: string) {
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
      throw new Error(`OpenBao local ${args[0]} operation failed. Sensitive output suppressed.`);
    return output.trim();
  }
  const docker = (...args: string[]) => command(["docker", ...args]);
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
  async function writeConfig(value: unknown) {
    const temporary = resolve(configDirectory, `config.${crypto.randomUUID()}`);
    await writeFile(temporary, JSON.stringify(value), { mode: 0o600, flag: "wx" });
    await rename(temporary, resolve(configDirectory, "config.json"));
  }
  await writeConfig(config);
  const address = `https://127.0.0.1:${identity.port}`;
  const caFile = resolve(await command(["mkcert", "-CAROOT"]), "rootCA.pem");

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
        await docker("pull", upstream.openbao.image);
        await docker("stop", container);
        await docker("rm", container);
      }
    }
    if (!(await owned("container", container))) {
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
    const credentials = await bootstrapOpenBao({ directory, address, caFile, refreshPolicy });
    return {
      FACTORY_OPENBAO_URL: address,
      FACTORY_OPENBAO_TOKEN_FILE: credentials.tokenFile,
      FACTORY_OPENBAO_MOUNT: "factory",
      FACTORY_OPENBAO_CA_FILE: caFile,
    };
  }
  return {
    async start(refreshPolicy = false) {
      const existingLogin = await lstat(resolve(directory, "factory-login.json")).catch(
        () => undefined,
      );
      const installedPolicy = await readFile(
        resolve(directory, "factory-policy-version"),
        "utf8",
      ).catch(() => "");
      if (!refreshPolicy && (!existingLogin || installedPolicy === openBaoPolicyVersion))
        return startConfigured();
      // Quorum-only recovery is enabled solely for this owned local ACL update.
      const recoveryConfig = structuredClone(config);
      Object.assign(recoveryConfig.listener.tcp, {
        disable_unauthed_generate_root_endpoints: false,
      });
      await writeConfig(recoveryConfig);
      try {
        return await startConfigured(true);
      } finally {
        await writeConfig(config);
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
