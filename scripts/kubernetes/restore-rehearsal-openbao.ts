// Self-contained OpenBao TLS initialize/unseal/AppRole validator (serialized via invocation()).
import type { Witnesses } from "./restore-rehearsal-types";

export async function openBaoRequest(config: { action: "initialize" | "validate" }) {
  const fs = await import("node:fs/promises");
  const https = await import("node:https");
  const { createHash, X509Certificate } = await import("node:crypto");
  const { checkServerIdentity } = await import("node:tls");
  const fail = (): never => {
    throw Error("OpenBao restore/unseal/AppRole witness failed; sensitive output suppressed");
  };
  const originalCA = await fs.readFile("/control/tls/ca.crt");
  const originalLeaf = await fs.readFile("/control/tls/tls.crt");
  const root = new X509Certificate(originalCA);
  const leaf = new X509Certificate(originalLeaf);
  const now = Date.now();
  if (
    !root.ca ||
    leaf.ca ||
    !leaf.checkIssued(root) ||
    !leaf.verify(root.publicKey) ||
    leaf.checkIP("127.0.0.1") !== "127.0.0.1" ||
    ![root, leaf].every(
      (certificate) =>
        certificate.validFromDate.getTime() <= now && now <= certificate.validToDate.getTime(),
    )
  )
    fail();
  // The original chart gives the CA and leaf the same DN. OpenSSL needs the original
  // leaf first to resolve that chain. Trust only these supplied, signature-checked inputs,
  // never a certificate learned from the peer, and retain normal chain/hostname checks.
  const ca = [originalLeaf, originalCA];
  async function request(path: string, body?: unknown, token?: string) {
    const encoded = body === undefined ? undefined : JSON.stringify(body);
    type Body = {
      initialized?: boolean;
      sealed?: boolean;
      keys_base64?: string[];
      root_token?: string;
      auth?: { client_token?: string };
      data?: { data?: unknown };
    };
    return new Promise<{ code: number; body: Body }>((accept, reject) => {
      const req = https.request(
        {
          hostname: "127.0.0.1",
          port: 8200,
          path: `/v1/${path}`,
          ca,
          agent: false,
          rejectUnauthorized: true,
          checkServerIdentity: (hostname, peer) =>
            checkServerIdentity(hostname, peer) ??
            (peer.raw.equals(leaf.raw)
              ? undefined
              : Error("OpenBao peer differs from the original TLS certificate")),
          method: encoded === undefined ? "GET" : "POST",
          // Raft initialization/unseal can exceed a short idle-socket timeout. The
          // owned exec already has the operator's explicit wall-clock deadline.
          timeout: 0,
          headers: {
            ...(encoded ? { "content-type": "application/json" } : {}),
            ...(token ? { "X-Vault-Token": token } : {}),
          },
        },
        (response) => {
          const chunks: Buffer[] = [];
          let length = 0;
          response.on("data", (chunk: Buffer) => {
            length += chunk.length;
            if (length > 8 * 1024 ** 2) response.destroy(Error("Private response too large"));
            else chunks.push(chunk);
          });
          response.once("error", reject);
          response.once("end", () => {
            try {
              accept({
                code: response.statusCode ?? 0,
                body: JSON.parse(Buffer.concat(chunks).toString("utf8")),
              });
            } catch {
              reject(Error("Private response invalid"));
            }
          });
        },
      );
      req.once("timeout", () =>
        req.destroy(Object.assign(Error("Owned TLS request timed out"), { code: "ETIMEDOUT" })),
      );
      req.once("error", reject);
      req.end(encoded);
    });
  }
  // Readiness retries are inside the explicit operator command deadline, not a success fallback.
  async function active() {
    for (;;) {
      const current = await request("sys/health");
      if (
        current.code === 200 &&
        current.body.initialized === true &&
        current.body.sealed === false
      )
        return;
      if (current.body.sealed !== false) return fail();
      await new Promise((accept) => setTimeout(accept, 500));
    }
  }
  let health: Awaited<ReturnType<typeof request>>;
  for (;;) {
    try {
      health = await request("sys/health");
      break;
    } catch (error) {
      // Only startup transport failures are retryable. Certificate, hostname, pin and
      // malformed-response errors must fail without replaying requests indefinitely.
      if (
        !["ECONNREFUSED", "ECONNRESET", "EPIPE", "ETIMEDOUT"].includes(
          (error as NodeJS.ErrnoException)?.code ?? "",
        )
      )
        return fail();
      await new Promise((accept) => setTimeout(accept, 500));
    }
  }
  if (config.action === "initialize") {
    if (health.body["initialized"] !== false) fail();
    const initialized = await request("sys/init", { secret_shares: 1, secret_threshold: 1 });
    // sys/init uses keys_base64, matching Factory's existing bootstrap API.
    const key = initialized.body["keys_base64"]?.[0];
    const token = initialized.body["root_token"];
    if (initialized.code !== 200 || typeof key !== "string" || typeof token !== "string")
      return fail();
    const unsealed = await request("sys/unseal", { key });
    if (unsealed.code !== 200 || unsealed.body["sealed"] !== false) fail();
    await active();
    await fs.writeFile("/control/temporary-root-token", token, { mode: 0o600, flag: "wx" });
    await fs.chown("/control/temporary-root-token", 100, 1000);
    return;
  }
  // The force restore must reseal, invalidating the temporary initialized identity.
  if (health.body["initialized"] !== true || health.body["sealed"] !== true) fail();
  const original = JSON.parse(await fs.readFile("/state/openbao/bootstrap.json", "utf8"));
  if (!Array.isArray(original.keys_base64) || original.keys_base64.length !== 1) fail();
  const unsealed = await request("sys/unseal", { key: original.keys_base64[0] });
  if (unsealed.code !== 200 || unsealed.body["sealed"] !== false) fail();
  await active();
  await fs.unlink("/control/temporary-root-token");
  const login = JSON.parse(await fs.readFile("/state/openbao/factory-login.json", "utf8"));
  if (typeof login.role_id !== "string" || typeof login.secret_id !== "string") fail();
  const issued = await request("auth/approle/login", {
    role_id: login.role_id,
    secret_id: login.secret_id,
  });
  const token = issued.body["auth"]?.client_token;
  if (issued.code !== 200 || typeof token !== "string") fail();
  function canonical(value: unknown): string {
    if (value === null || typeof value !== "object") return JSON.stringify(value);
    if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`)
      .join(",")}}`;
  }
  const w: Witnesses = JSON.parse(await fs.readFile("/control/witnesses.json", "utf8"));
  for (const expected of w.openbao) {
    const response = await request(expected.path, undefined, token);
    const value = response.body["data"]?.data;
    if (
      response.code !== 200 ||
      !value ||
      createHash("sha256").update(canonical(value)).digest("hex") !== expected.sha256
    )
      fail();
  }
  // This scoped AppRole token has no revoke-self policy in the pinned Factory role.
  // It exists only inside this soon-deleted isolated raft volume, never in evidence or argv.
}
