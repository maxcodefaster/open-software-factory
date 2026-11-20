import { expect, spyOn, test } from "bun:test";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import imagePins from "../../deploy/helm/factory/image-pins.json";
import { localOpenBao } from "./openbao";
import { backupPolicy, openBaoPolicy, openBaoPolicyVersion } from "./openbao-bootstrap";

test("local policy upgrade uses retained administrator credentials without restart or recovery config", async () => {
  const state = await realpath(await mkdtemp(resolve(tmpdir(), "factory-openbao-local-test-")));
  const directory = resolve(state, "openbao");
  const owner = crypto.randomUUID();
  const container = `factory-openbao-${owner}`;
  const volume = `${container}-data`;
  const commands: string[][] = [];
  const calls: { path: string; token: string | null }[] = [];
  await mkdir(resolve(directory, "config"), { recursive: true });
  for (const [name, content] of Object.entries({
    "identity.json": JSON.stringify({ owner, port: 40222, uid: 1000, gid: 1000 }),
    "bootstrap.json": JSON.stringify({ keys_base64: ["retained-unseal-key"], root_token: "" }),
    "factory-login.json": JSON.stringify({
      role_id: "application",
      secret_id: "application-secret",
    }),
    "factory-admin-login.json": JSON.stringify({ role_id: "admin", secret_id: "admin-secret" }),
    "factory-backup-login.json": JSON.stringify({ role_id: "backup", secret_id: "backup-secret" }),
    "factory-token": "scoped-application-token",
    "factory-policy-version": "older-policy",
    "config/tls.crt": "test certificate",
    "config/tls.key": "test key",
    "rootCA.pem": "test CA",
  }))
    await writeFile(resolve(directory, name), content, { mode: 0o600 });
  const spawn = spyOn(Bun, "spawn").mockImplementation((input) => {
    const args = input as string[];
    commands.push([...args]);
    let output: string;
    if (args[0] === "mkcert" && args[1] === "-CAROOT") output = directory;
    else if (args[0] === "docker" && args[1] === "ps") output = container;
    else if (args[0] === "docker" && args[1] === "volume" && args[2] === "ls") output = volume;
    else if (args[0] === "docker" && args[1] === "container" && args[2] === "inspect")
      output = owner;
    else if (args[0] === "docker" && args[1] === "volume" && args[2] === "inspect") output = owner;
    else if (args[0] === "docker" && args[1] === "inspect" && args[3] === "{{.Config.User}}")
      output = "1000:1000";
    else if (args[0] === "docker" && args[1] === "inspect" && args[3] === "{{.Config.Image}}")
      output = imagePins.openbao;
    else if (args[0] === "docker" && args[1] === "start" && args[2] === container) output = "";
    else throw new Error(`Unexpected local OpenBao command: ${args[0]} ${args[1]}`);
    return {
      stdout: new Response(output).body,
      exited: Promise.resolve(0),
      kill() {},
    } as unknown as ReturnType<typeof Bun.spawn>;
  });
  const originalFetch = globalThis.fetch;
  const transport = spyOn(globalThis, "fetch").mockImplementation(
    Object.assign(
      async (input: Parameters<typeof fetch>[0], options?: Parameters<typeof fetch>[1]) => {
        const url = new URL(String(input));
        expect(url.origin).toBe("https://127.0.0.1:40222");
        expect((options as RequestInit & { tls: { ca: string } }).tls.ca).toBe("test CA");
        const path = url.pathname;
        const token = new Headers(options?.headers).get("X-Vault-Token");
        calls.push({ path, token });
        const body = options?.body ? JSON.parse(String(options.body)) : undefined;
        if (path === "/v1/sys/seal-status")
          return Response.json({ initialized: true, sealed: true });
        if (path === "/v1/sys/health") return Response.json({});
        if (path === "/v1/sys/unseal") {
          expect(body).toEqual({ key: "retained-unseal-key" });
        } else if (path === "/v1/auth/approle/login") {
          expect(body).toEqual({ role_id: "admin", secret_id: "admin-secret" });
          return Response.json({ auth: { client_token: "short-lived-admin" } });
        } else if (path === "/v1/sys/policies/acl/factory-environments") {
          expect(token).toBe("short-lived-admin");
          expect(body.policy).toBe(openBaoPolicy);
        } else if (path === "/v1/sys/policies/acl/factory-backup") {
          expect(token).toBe("short-lived-admin");
          expect(body.policy).toBe(backupPolicy);
        } else if (
          path === "/v1/auth/approle/role/factory-environments" ||
          path === "/v1/auth/approle/role/factory-backup" ||
          path === "/v1/auth/token/revoke-self"
        ) {
          expect(token).toBe("short-lived-admin");
        } else if (path === "/v1/auth/token/renew-self") {
          expect(token).toBe("scoped-application-token");
        } else throw new Error(`Unexpected local OpenBao endpoint: ${path}`);
        return new Response(null, { status: 204 });
      },
      { preconnect: originalFetch.preconnect },
    ),
  );
  try {
    const bao = await localOpenBao(state);
    const environment = await bao.start();
    expect(environment.FACTORY_OPENBAO_TOKEN_FILE).toBe(resolve(directory, "factory-token"));
    expect(await readFile(resolve(directory, "factory-policy-version"), "utf8")).toBe(
      openBaoPolicyVersion,
    );
    const config = JSON.parse(await readFile(resolve(directory, "config/config.json"), "utf8"));
    expect(config.listener.tcp).toEqual({
      address: "0.0.0.0:8200",
      tls_cert_file: "/bao/config/tls.crt",
      tls_key_file: "/bao/config/tls.key",
    });
    expect(
      commands.filter((args) => ["restart", "stop", "rm", "run", "pull"].includes(args[1] ?? "")),
    ).toEqual([]);
    expect(commands.filter((args) => args[1] === "start")).toEqual([
      ["docker", "start", container],
    ]);
    expect(calls.some((call) => /generate-root|sys\/mounts|sys\/auth$/.test(call.path))).toBe(
      false,
    );
    expect(calls.find((call) => call.path === "/v1/auth/token/revoke-self")?.token).toBe(
      "short-lived-admin",
    );
    expect(await readFile(resolve(directory, "factory-backup-login.json"), "utf8")).toBe(
      JSON.stringify({ role_id: "backup", secret_id: "backup-secret" }),
    );
    expect(JSON.parse(await readFile(resolve(directory, "bootstrap.json"), "utf8"))).toEqual({
      keys_base64: ["retained-unseal-key"],
      root_token: "",
    });
  } finally {
    transport.mockRestore();
    spawn.mockRestore();
    await rm(state, { recursive: true, force: true });
  }
});
