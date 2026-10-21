import { expect, spyOn, test } from "bun:test";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { bootstrapOpenBao } from "./openbao-bootstrap";

class Bao {
  initialized = false;
  sealed = true;
  rootActive = true;
  initializedCount = 0;
  secretsCreated = 0;
  tokensCreated = 0;
  secretID: string | null = null;
  lose: string | null = null;
  mounts: Record<string, unknown> = {};
  auth: Record<string, unknown> = {};
  calls: string[] = [];

  fetch = async (url: URL, options: RequestInit) => {
    const path = url.pathname.replace("/v1/", "");
    this.calls.push(path);
    const body = options.body ? JSON.parse(String(options.body)) : undefined;
    const ok = (value?: unknown) =>
      value === undefined ? new Response(null, { status: 204 }) : Response.json(value);
    let result: Response;
    switch (path) {
      case "sys/seal-status":
        return ok({ initialized: this.initialized, sealed: this.sealed });
      case "sys/init":
        this.initialized = true;
        this.initializedCount++;
        result = ok({ keys_base64: ["retained-unseal-key"], root_token: "bootstrap-root-token" });
        break;
      case "sys/unseal":
        expect(body.key).toBe("retained-unseal-key");
        this.sealed = false;
        return ok();
      case "sys/health":
        return ok({ initialized: true, sealed: this.sealed });
      case "auth/token/lookup-self":
        return this.rootActive ? ok({ data: {} }) : new Response(null, { status: 403 });
      case "sys/mounts":
        return ok(this.mounts);
      case "sys/mounts/factory":
        this.mounts["factory/"] = {};
        return ok();
      case "sys/auth":
        return ok(this.auth);
      case "sys/auth/approle":
        this.auth["approle/"] = {};
        return ok();
      case "sys/policies/acl/factory-environments":
      case "auth/approle/role/factory-environments":
        return ok();
      case "auth/approle/role/factory-environments/role-id":
        return ok({ data: { role_id: "retained-role-id" } });
      case "auth/approle/role/factory-environments/secret-id/lookup":
        // The pinned native server returns an empty 204 for a missing SecretID.
        return body.secret_id === this.secretID ? ok({ data: {} }) : ok();
      case "auth/approle/role/factory-environments/custom-secret-id":
        this.secretID = body.secret_id;
        this.secretsCreated++;
        result = ok({ data: {} });
        break;
      case "auth/approle/login":
        expect(body.secret_id).toBe(this.secretID);
        this.tokensCreated++;
        return ok({ auth: { client_token: "scoped-application-token" } });
      case "auth/token/renew-self":
        expect(new Headers(options.headers).get("X-Vault-Token")).toBe("scoped-application-token");
        return ok();
      case "auth/token/revoke-self":
        this.rootActive = false;
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
    expect(bao.secretsCreated).toBe(1);
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
    expect(bao.secretsCreated).toBe(1);
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

test("unplanned policy drift refuses readiness rather than silently claiming a successful upgrade", async () => {
  await fixture(async (input) => {
    await bootstrapOpenBao(input);
    await writeFile(resolve(input.directory, "factory-policy-version"), "other-policy");
    await expect(bootstrapOpenBao(input)).rejects.toThrow("controlled maintenance");
  });
});
