import { expect, spyOn, test } from "bun:test";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import {
  adminPolicy,
  backupPolicy,
  bootstrapOpenBao,
  openBaoPolicy,
  openBaoPolicyVersion,
} from "./openbao-bootstrap";

const recoveryAddress = "https://127.0.0.1:38210";

function allowed(policy: string, path: string, capability: string) {
  return [...policy.matchAll(/path "([^"]+)" \{ capabilities = \[([^\]]*)\] \}/g)].some(
    (match) => match[1] === path && match[2]?.includes(`"${capability}"`),
  );
}

class Bao {
  initialized = false;
  sealed = true;
  rootActive = true;
  // OpenBao 2.7 serves generate-root only on a listener that enables it.
  sharedGenerateRoot = false;
  initializedCount = 0;
  secretsCreated: Record<string, number> = {};
  tokensCreated = 0;
  secretIDs: Record<string, string> = {};
  policies: Record<string, string> = {};
  roles: Record<string, unknown> = {};
  tokens: Record<string, string> = {};
  rootAttempt: { nonce: string; otp: string } | null = null;
  rootGenerations = 0;
  lose: string | null = null;
  mounts: Record<string, unknown> = {};
  auth: Record<string, unknown> = {};
  calls: string[] = [];

  fetch = async (url: URL, options: RequestInit) => {
    const path = url.pathname.replace("/v1/", "");
    this.calls.push(url.origin === recoveryAddress ? `recovery:${path}` : path);
    const body = options.body ? JSON.parse(String(options.body)) : undefined;
    const supplied = new Headers(options.headers).get("X-Vault-Token") ?? "";
    const ok = (value?: unknown) =>
      value === undefined ? new Response(null, { status: 204 }) : Response.json(value);
    const forbidden = () => new Response(null, { status: 403 });
    const identity = this.tokens[supplied];
    const authorized = (capability: string) =>
      supplied === "bootstrap-root-token"
        ? this.rootActive
        : identity === "root"
          ? true
          : identity === "factory-admin"
            ? allowed(adminPolicy, path, capability)
            : false;
    let result: Response;
    switch (true) {
      case path === "sys/seal-status":
        return ok({ initialized: this.initialized, sealed: this.sealed });
      case path === "sys/init":
        this.initialized = true;
        this.initializedCount++;
        this.tokens["bootstrap-root-token"] = "root";
        result = ok({ keys_base64: ["retained-unseal-key"], root_token: "bootstrap-root-token" });
        break;
      case path === "sys/unseal":
        expect(body.key).toBe("retained-unseal-key");
        this.sealed = false;
        return ok();
      case path === "sys/health":
        return ok({ initialized: true, sealed: this.sealed });
      case path === "auth/token/lookup-self":
        return this.rootActive ? ok({ data: {} }) : forbidden();
      case path.startsWith("sys/generate-root/"): {
        if (url.origin !== recoveryAddress && !this.sharedGenerateRoot)
          return Response.json({ errors: ["unsupported operation"] }, { status: 405 });
        if (path === "sys/generate-root/attempt") {
          if (options.method === "DELETE") {
            this.rootAttempt = null;
            return ok();
          }
          if (options.method === "POST") {
            this.rootAttempt = { nonce: "attempt-nonce", otp: "o".repeat(26) };
            return ok({ started: true, ...this.rootAttempt });
          }
          return ok({ started: this.rootAttempt !== null, nonce: this.rootAttempt?.nonce });
        }
        expect(body.key).toBe("retained-unseal-key");
        expect(body.nonce).toBe(this.rootAttempt?.nonce);
        const token = `generated-root-token-${String(++this.rootGenerations).padStart(5, "0")}`;
        this.tokens[token] = "root";
        const otp = Buffer.from(this.rootAttempt?.otp ?? "");
        const encoded = Buffer.from(
          Buffer.from(token).map((value, index) => value ^ (otp[index] ?? 0)),
        );
        return ok({ complete: true, encoded_token: encoded.toString("base64") });
      }
      case path === "sys/mounts":
        return authorized("read") ? ok(this.mounts) : forbidden();
      case path === "sys/mounts/factory":
        if (!authorized("update")) return forbidden();
        this.mounts["factory/"] = {};
        return ok();
      case path === "sys/auth":
        return authorized("read") ? ok(this.auth) : forbidden();
      case path === "sys/auth/approle":
        if (!authorized("update")) return forbidden();
        this.auth["approle/"] = {};
        return ok();
      case path.startsWith("sys/policies/acl/"):
        if (!authorized("update")) return forbidden();
        this.policies[path.split("/").pop() as string] = body.policy;
        return ok();
      case /^auth\/approle\/role\/[^/]+$/.test(path):
        if (!authorized("update")) return forbidden();
        this.roles[path.split("/").pop() as string] = body;
        return ok();
      case /^auth\/approle\/role\/[^/]+\/role-id$/.test(path):
        if (!authorized("read")) return forbidden();
        return ok({ data: { role_id: `id-of-${path.split("/")[3]}` } });
      case /^auth\/approle\/role\/[^/]+\/secret-id\/lookup$/.test(path):
        if (!authorized("update")) return forbidden();
        // The pinned native server returns an empty 204 for a missing SecretID.
        return body.secret_id === this.secretIDs[path.split("/")[3] as string]
          ? ok({ data: {} })
          : ok();
      case /^auth\/approle\/role\/[^/]+\/custom-secret-id$/.test(path): {
        if (!authorized("update")) return forbidden();
        const name = path.split("/")[3] as string;
        this.secretIDs[name] = body.secret_id;
        this.secretsCreated[name] = (this.secretsCreated[name] ?? 0) + 1;
        result = ok({ data: {} });
        break;
      }
      case path === "auth/approle/login": {
        const name = String(body.role_id).replace("id-of-", "");
        expect(body.secret_id).toBe(this.secretIDs[name]);
        this.tokensCreated++;
        const token =
          name === "factory-environments" ? "scoped-application-token" : `${name}-token`;
        this.tokens[token] = name;
        return ok({ auth: { client_token: token } });
      }
      case path === "auth/token/renew-self":
        expect(supplied).toBe("scoped-application-token");
        return ok();
      case path === "auth/token/revoke-self":
        if (supplied === "bootstrap-root-token") this.rootActive = false;
        else if (!authorized("update")) return forbidden();
        delete this.tokens[supplied];
        result = ok();
        break;
      default:
        throw new Error(`Unexpected bootstrap endpoint: ${path}`);
    }
    if (path === this.lose) {
      this.lose = null;
      throw new Error("Response lost after the native operation");
    }
    return result;
  };
}

async function fixture(
  run: (input: Parameters<typeof bootstrapOpenBao>[0], bao: Bao) => Promise<void>,
) {
  const directory = await mkdtemp(resolve(tmpdir(), "factory-bao-bootstrap-"));
  try {
    const caFile = resolve(directory, "ca.crt");
    await writeFile(caFile, "test CA");
    const bao = new Bao();
    await run(
      { directory, caFile, address: "https://openbao.portable.svc:8200", fetch: bao.fetch },
      bao,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("bootstrap retains encrypted-store identity and renews only a scoped token across restart", async () => {
  await fixture(async (input, bao) => {
    const initial = await bootstrapOpenBao(input);
    expect(await readFile(initial.tokenFile, "utf8")).toBe("scoped-application-token");
    expect((await stat(initial.tokenFile)).mode & 0o777).toBe(0o600);
    expect(
      JSON.parse(await readFile(resolve(input.directory, "bootstrap.json"), "utf8")).root_token,
    ).toBe("");
    bao.sealed = true;
    await bootstrapOpenBao(input);
    expect(bao.initializedCount).toBe(1);
    expect(bao.secretsCreated["factory-environments"]).toBe(1);
    expect(bao.tokensCreated).toBe(1);
  });
});

test("initialization waits beyond OpenBao's native request deadline without widening readiness probes", async () => {
  await fixture(async (input, bao) => {
    const deadlines = new WeakMap<AbortSignal, number>();
    const timeout = spyOn(AbortSignal, "timeout").mockImplementation((milliseconds) => {
      const signal = new AbortController().signal;
      deadlines.set(signal, milliseconds);
      return signal;
    });
    try {
      const observed: Record<string, number | undefined> = {};
      await bootstrapOpenBao({
        ...input,
        fetch: (url, options) => {
          observed[url.pathname] = options.signal ? deadlines.get(options.signal) : undefined;
          return bao.fetch(url, options);
        },
      });
      // Raft election and first barrier setup can outlast a normal API read.
      // The server permits 90 seconds; the client must not discard its keys first.
      expect(observed["/v1/sys/init"]).toBeGreaterThan(90_000);
      expect(observed["/v1/sys/seal-status"]).toBe(10_000);
      expect(observed["/v1/sys/health"]).toBe(1_000);
      expect(bao.initializedCount).toBe(1);
    } finally {
      timeout.mockRestore();
    }
  });
});

test("a lost initialization response never authorizes resetting the encrypted store", async () => {
  await fixture(async (input, bao) => {
    bao.lose = "sys/init";
    await expect(bootstrapOpenBao(input)).rejects.toThrow("Response lost");
    await expect(bootstrapOpenBao(input)).rejects.toThrow("original unseal material");
    expect(bao.initializedCount).toBe(1);
  });
});

test("a lost AppRole creation response is recovered using the same persisted intended secret", async () => {
  await fixture(async (input, bao) => {
    bao.lose = "auth/approle/role/factory-environments/custom-secret-id";
    await expect(bootstrapOpenBao(input)).rejects.toThrow("Response lost");
    await bootstrapOpenBao(input);
    expect(bao.secretsCreated["factory-environments"]).toBe(1);
    expect(bao.initializedCount).toBe(1);
  });
});

test("a lost root-revocation response is observed without recreating root or application credentials", async () => {
  await fixture(async (input, bao) => {
    bao.lose = "auth/token/revoke-self";
    await expect(bootstrapOpenBao(input)).rejects.toThrow("Response lost");
    await bootstrapOpenBao(input);
    expect(bao.tokensCreated).toBe(1);
    expect(bao.rootActive).toBe(false);
  });
});

async function secrets(directory: string) {
  const read = async (name: string) =>
    JSON.parse(await readFile(resolve(directory, name), "utf8")) as {
      role_id: string;
      secret_id: string;
    };
  return {
    backup: await read("factory-backup-login.json"),
    admin: await read("factory-admin-login.json"),
  };
}

test("first bootstrap creates a least-privilege backup login and a short-lived admin identity", async () => {
  await fixture(async (input, bao) => {
    const result = await bootstrapOpenBao(input);
    expect(bao.policies["factory-backup"]).toBe(backupPolicy);
    expect(backupPolicy).toContain('path "sys/storage/raft/snapshot" { capabilities = ["read"] }');
    expect(backupPolicy).toContain('path "auth/token/renew-self" { capabilities = ["update"] }');
    expect(backupPolicy.split("\n")).toHaveLength(2);
    expect(bao.policies["factory-environments"]).toBe(openBaoPolicy);
    expect(bao.policies["factory-admin"]).toBe(adminPolicy);
    // The admin policy is limited to the two policies and two roles Factory owns, never mounts or itself.
    expect(adminPolicy).not.toContain("sys/mounts");
    expect(adminPolicy).not.toContain("factory-admin");
    expect(adminPolicy).not.toContain("snapshot");
    expect(bao.roles["factory-backup"]).toMatchObject({
      token_policies: ["factory-backup"],
      token_no_default_policy: true,
      token_max_ttl: "2h",
    });
    expect(bao.roles["factory-admin"]).toMatchObject({ token_max_ttl: "15m" });
    const files = await secrets(input.directory);
    expect(result.backup).toEqual(files.backup);
    expect(result.backup).toEqual({
      role_id: "id-of-factory-backup",
      secret_id: bao.secretIDs["factory-backup"] as string,
    });
    expect(files.admin.secret_id).toBe(bao.secretIDs["factory-admin"] as string);
    for (const name of ["factory-backup-login.json", "factory-admin-login.json"])
      expect((await stat(resolve(input.directory, name))).mode & 0o777).toBe(0o600);
    // The second start reads retained state and issues nothing.
    bao.calls.length = 0;
    expect((await bootstrapOpenBao(input)).backup).toEqual(result.backup);
    expect(
      bao.calls.some((call) => call.includes("approle/role") || call.includes("policies")),
    ).toBe(false);
  });
});

test("a retained installation updates policies after an upgrade through the admin identity", async () => {
  await fixture(async (input, bao) => {
    const first = await bootstrapOpenBao(input);
    bao.policies = {};
    bao.roles = {};
    await writeFile(resolve(input.directory, "factory-policy-version"), "older-policy");
    bao.calls.length = 0;
    const second = await bootstrapOpenBao(input);
    expect(await readFile(resolve(input.directory, "factory-policy-version"), "utf8")).toBe(
      openBaoPolicyVersion,
    );
    expect(bao.policies["factory-environments"]).toBe(openBaoPolicy);
    expect(bao.policies["factory-backup"]).toBe(backupPolicy);
    expect(second.backup).toEqual(first.backup);
    expect(bao.secretsCreated["factory-backup"]).toBe(1);
    // The upgrade never needs root: no generate-root and no mount or auth listing.
    expect(bao.calls.filter((call) => /generate-root|sys\/mounts|sys\/auth$/.test(call))).toEqual(
      [],
    );
    expect(bao.tokens["factory-admin-token"]).toBeUndefined();
    expect(bao.rootGenerations).toBe(0);
  });
});

async function legacy(input: Parameters<typeof bootstrapOpenBao>[0], bao: Bao) {
  await bootstrapOpenBao(input);
  for (const name of [
    "factory-backup-login.json",
    "factory-admin-login.json",
    "openbao-backup-secret-id.json",
    "openbao-admin-secret-id.json",
  ])
    await rm(resolve(input.directory, name));
  await writeFile(resolve(input.directory, "factory-policy-version"), "older-policy");
  for (const name of ["factory-backup", "factory-admin"]) {
    delete bao.policies[name];
    delete bao.roles[name];
    delete bao.secretIDs[name];
  }
  bao.secretsCreated = {};
}

test("an installation that predates the admin identity needs a controlled adoption", async () => {
  await fixture(async (input, bao) => {
    await legacy(input, bao);
    await expect(bootstrapOpenBao(input)).rejects.toThrow("controlled maintenance");
    expect(bao.rootGenerations).toBe(0);
  });
});

test("refreshing policy on the shared listener fails where OpenBao 2.7 disables generate-root", async () => {
  await fixture(async (input, bao) => {
    await legacy(input, bao);
    await expect(bootstrapOpenBao({ ...input, refreshPolicy: true })).rejects.toThrow(
      "sys/generate-root/attempt returned HTTP 405",
    );
  });
});

test("adoption mints root with the retained key over the recovery listener, then revokes it", async () => {
  await fixture(async (input, bao) => {
    await legacy(input, bao);
    let closed = 0;
    const result = await bootstrapOpenBao({
      ...input,
      openRecovery: async () => ({
        address: recoveryAddress,
        close: async () => {
          closed++;
        },
      }),
    });
    expect(closed).toBe(1);
    expect(bao.rootAttempt).toBeNull();
    expect(Object.values(bao.tokens)).not.toContain("root");
    expect(bao.calls.filter((call) => call.startsWith("recovery:"))).toContain(
      "recovery:sys/generate-root/update",
    );
    expect(
      bao.calls.filter((call) => /generate-root/.test(call) && !call.startsWith("recovery:")),
    ).toEqual([]);
    expect(bao.policies["factory-backup"]).toBe(backupPolicy);
    expect(bao.policies["factory-admin"]).toBe(adminPolicy);
    expect(result.backup.secret_id).toBe(bao.secretIDs["factory-backup"] as string);
    expect(bao.secretsCreated["factory-environments"] ?? 0).toBe(0);
    expect(await readFile(resolve(input.directory, "factory-policy-version"), "utf8")).toBe(
      openBaoPolicyVersion,
    );
    // Afterwards the admin identity handles later updates without the recovery listener.
    await writeFile(resolve(input.directory, "factory-policy-version"), "older-policy");
    await bootstrapOpenBao(input);
    expect(bao.rootGenerations).toBe(1);
  });
});

test("an adoption interrupted before it finished is repeated with the same credentials", async () => {
  await fixture(async (input, bao) => {
    await legacy(input, bao);
    const recovery = async () => ({ address: recoveryAddress, close: async () => {} });
    bao.lose = "auth/approle/role/factory-backup/custom-secret-id";
    await expect(bootstrapOpenBao({ ...input, openRecovery: recovery })).rejects.toThrow(
      "Response lost",
    );
    expect(Object.values(bao.tokens)).not.toContain("root");
    await bootstrapOpenBao({ ...input, openRecovery: recovery });
    expect(bao.secretsCreated["factory-backup"]).toBe(1);
    expect(bao.rootGenerations).toBe(2);
    expect((await secrets(input.directory)).backup.secret_id).toBe(
      bao.secretIDs["factory-backup"] as string,
    );
  });
});

test("an active root generation by someone else is never cancelled", async () => {
  await fixture(async (input, bao) => {
    await legacy(input, bao);
    bao.rootAttempt = { nonce: "foreign", otp: "x".repeat(26) };
    await expect(
      bootstrapOpenBao({
        ...input,
        openRecovery: async () => ({ address: recoveryAddress, close: async () => {} }),
      }),
    ).rejects.toThrow("active root generation");
    expect(bao.rootAttempt?.nonce).toBe("foreign");
  });
});
