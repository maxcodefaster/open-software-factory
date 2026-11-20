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

function allowed(policy: string, path: string, capability: string) {
  return [...policy.matchAll(/path "([^"]+)" \{ capabilities = \[([^\]]*)\] \}/g)].some(
    (match) => match[1] === path && match[2]?.includes(`"${capability}"`),
  );
}

class Bao {
  initialized = false;
  sealed = true;
  rootActive = true;
  initializedCount = 0;
  secretsCreated: Record<string, number> = {};
  tokensCreated = 0;
  secretIDs: Record<string, string> = {};
  policies: Record<string, string> = {};
  roles: Record<string, unknown> = {};
  tokens: Record<string, string> = {};
  lose: string | null = null;
  reject: string | null = null;
  mounts: Record<string, unknown> = {};
  auth: Record<string, unknown> = {};
  calls: string[] = [];

  fetch = async (url: URL, options: RequestInit) => {
    const path = url.pathname.replace("/v1/", "");
    this.calls.push(path);
    if (path === this.reject) return new Response(null, { status: 403 });
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
        result = ok();
        break;
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

test.each(["factory-environments", "factory-backup", "factory-admin"])(
  "interrupted initial bootstrap reuses the persisted %s secret",
  async (role) => {
    await fixture(async (input, bao) => {
      bao.lose = `auth/approle/role/${role}/custom-secret-id`;
      await expect(bootstrapOpenBao(input)).rejects.toThrow("Response lost");
      await bootstrapOpenBao(input);
      expect(bao.secretsCreated[role]).toBe(1);
      expect(bao.initializedCount).toBe(1);
      expect(bao.rootActive).toBe(false);
    });
  },
);

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
    expect(Object.values(bao.tokens)).not.toContain("root");
  });
});

test("a lost policy-upgrade response revokes the admin token and retries with retained logins", async () => {
  await fixture(async (input, bao) => {
    const first = await bootstrapOpenBao(input);
    const before = await secrets(input.directory);
    await writeFile(resolve(input.directory, "factory-policy-version"), "older-policy");
    bao.calls.length = 0;
    bao.lose = "sys/policies/acl/factory-backup";
    await expect(bootstrapOpenBao(input)).rejects.toThrow("Response lost");
    expect(bao.tokens["factory-admin-token"]).toBeUndefined();
    expect(await readFile(resolve(input.directory, "factory-policy-version"), "utf8")).toBe(
      "older-policy",
    );
    expect((await bootstrapOpenBao(input)).backup).toEqual(first.backup);
    expect(await secrets(input.directory)).toEqual(before);
    expect(await readFile(resolve(input.directory, "factory-policy-version"), "utf8")).toBe(
      openBaoPolicyVersion,
    );
    expect(bao.secretsCreated).toEqual({
      "factory-environments": 1,
      "factory-backup": 1,
      "factory-admin": 1,
    });
    expect(bao.calls.some((call) => /generate-root|sys\/mounts|sys\/auth$/.test(call))).toBe(false);
  });
});

test("a missing backup login is recovered with its original intended secret through the admin", async () => {
  await fixture(async (input, bao) => {
    const first = await bootstrapOpenBao(input);
    await rm(resolve(input.directory, "factory-backup-login.json"));
    bao.calls.length = 0;
    const second = await bootstrapOpenBao(input);
    expect(second.backup).toEqual(first.backup);
    expect(bao.secretsCreated["factory-backup"]).toBe(1);
    expect(bao.tokens["factory-admin-token"]).toBeUndefined();
    expect(bao.calls.some((call) => /generate-root|sys\/mounts|sys\/auth$/.test(call))).toBe(false);
  });
});

test.each(["older-policy", openBaoPolicyVersion])(
  "missing retained administrator refuses startup without root recovery for policy %s",
  async (version) => {
    await fixture(async (input, bao) => {
      await bootstrapOpenBao(input);
      await rm(resolve(input.directory, "factory-admin-login.json"));
      await writeFile(resolve(input.directory, "factory-policy-version"), version);
      const paths = [
        "bootstrap.json",
        "factory-login.json",
        "factory-token",
        "factory-backup-login.json",
        "factory-policy-version",
      ].map((name) => resolve(input.directory, name));
      const before = await Promise.all(paths.map((path) => readFile(path, "utf8")));
      bao.calls.length = 0;
      await expect(bootstrapOpenBao(input)).rejects.toThrow("retained administrator AppRole");
      expect(await Promise.all(paths.map((path) => readFile(path, "utf8")))).toEqual(before);
      expect(bao.calls).toEqual(["sys/seal-status", "sys/health"]);
      expect(bao.initializedCount).toBe(1);
      expect(Object.values(bao.tokens)).not.toContain("root");
    });
  },
);

test("a refused administrator login leaves the old policy marker and original credentials", async () => {
  await fixture(async (input, bao) => {
    await bootstrapOpenBao(input);
    const before = await secrets(input.directory);
    await writeFile(resolve(input.directory, "factory-policy-version"), "older-policy");
    bao.reject = "auth/approle/login";
    bao.calls.length = 0;
    await expect(bootstrapOpenBao(input)).rejects.toThrow("returned HTTP 403");
    expect(await secrets(input.directory)).toEqual(before);
    expect(await readFile(resolve(input.directory, "factory-policy-version"), "utf8")).toBe(
      "older-policy",
    );
    expect(bao.calls).toEqual(["sys/seal-status", "sys/health", "auth/approle/login"]);
    expect(bao.initializedCount).toBe(1);
  });
});

test("a nonrenewable application token is replaced using the retained AppRole", async () => {
  await fixture(async (input, bao) => {
    await bootstrapOpenBao(input);
    const before = await secrets(input.directory);
    bao.reject = "auth/token/renew-self";
    bao.calls.length = 0;
    await bootstrapOpenBao(input);
    expect(bao.tokensCreated).toBe(2);
    expect(await secrets(input.directory)).toEqual(before);
    expect(bao.calls).toEqual([
      "sys/seal-status",
      "sys/health",
      "auth/token/renew-self",
      "auth/approle/login",
    ]);
    expect(bao.initializedCount).toBe(1);
  });
});

test("an empty store with retained keys is refused without reinitializing", async () => {
  await fixture(async (input, bao) => {
    await bootstrapOpenBao(input);
    const keys = await readFile(resolve(input.directory, "bootstrap.json"), "utf8");
    bao.initialized = false;
    bao.calls.length = 0;
    await expect(bootstrapOpenBao(input)).rejects.toThrow("retained keys were preserved");
    expect(await readFile(resolve(input.directory, "bootstrap.json"), "utf8")).toBe(keys);
    expect(bao.calls).toEqual(["sys/seal-status"]);
    expect(bao.initializedCount).toBe(1);
  });
});
