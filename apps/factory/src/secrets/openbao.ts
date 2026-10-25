import { constants } from "node:fs";
import { open, readFile } from "node:fs/promises";
import type { z } from "zod";
import { CommandError } from "../command-error";

export type OpenBaoOptions = {
  address?: string | undefined;
  tokenFile?: string | undefined;
  mount?: string | undefined;
  caFile?: string | undefined;
  fetch?: (request: string | URL | Request, init?: RequestInit) => Promise<Response>;
};

export function openBaoEnvironment(): OpenBaoOptions {
  return {
    address: process.env["FACTORY_OPENBAO_URL"],
    tokenFile: process.env["FACTORY_OPENBAO_TOKEN_FILE"],
    mount: process.env["FACTORY_OPENBAO_MOUNT"],
    caFile: process.env["FACTORY_OPENBAO_CA_FILE"],
  };
}

// One concrete KV transport shared by the authorized Factory secret consumers.
export function createOpenBaoKV(input: OpenBaoOptions = openBaoEnvironment()) {
  const configured = Boolean(input.address && input.tokenFile);
  const address = input.address ? new URL(input.address) : undefined;
  if (
    address &&
    (address.protocol !== "https:" ||
      address.username ||
      address.password ||
      address.pathname !== "/" ||
      address.search ||
      address.hash)
  )
    throw new Error("OpenBao requires an HTTPS origin without embedded credentials");
  const mount = input.mount ?? "factory";
  if (!/^[a-z][a-z0-9-]{0,63}$/.test(mount)) throw new Error("Invalid OpenBao KV mount");
  const unavailable = () =>
    new CommandError(
      "unavailable",
      "The secret store is unavailable. Ask a System Manager to check OpenBao.",
    );
  async function token() {
    if (!input.tokenFile) throw unavailable();
    const file = await open(input.tokenFile, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const info = await file.stat();
      if (
        !info.isFile() ||
        (info.mode & 0o077) !== 0 ||
        info.size > 4096 ||
        info.uid !== process.getuid?.()
      )
        throw unavailable();
      const value = (await file.readFile("utf8")).trim();
      if (!value || /[\r\n]/.test(value)) throw unavailable();
      return value;
    } finally {
      await file.close();
    }
  }
  async function request(path: string, method: "GET" | "POST" | "DELETE", body?: unknown) {
    if (!configured || !address) throw unavailable();
    try {
      const options = {
        method,
        redirect: "error" as const,
        signal: AbortSignal.timeout(10_000),
        headers: { "X-Vault-Token": await token(), "content-type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      };
      const url = new URL(path, address);
      const response = input.fetch
        ? await input.fetch(url, options)
        : await fetch(url, {
            ...options,
            ...(input.caFile ? { tls: { ca: await readFile(input.caFile, "utf8") } } : {}),
          });
      if (method === "GET" && response.status === 404) {
        await response.body?.cancel();
        return undefined;
      }
      if (!response.ok) {
        await response.body?.cancel();
        throw unavailable();
      }
      if (method !== "GET") {
        await response.body?.cancel();
        return undefined;
      }
      const reader = response.body?.getReader();
      if (!reader) throw unavailable();
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        for (;;) {
          const next = await reader.read();
          if (next.done) break;
          size += next.value.byteLength;
          if (size > 2_097_152) throw unavailable();
          chunks.push(next.value);
        }
      } finally {
        await reader.cancel();
      }
      return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
    } catch {
      throw unavailable();
    }
  }
  function path(key: string) {
    if (
      !/^(projects\/[0-9a-f-]{36}\/(development|main-preview)\/[0-9a-f-]{36}|(?:models|mcp|release-access|release-publish)\/[0-9a-f-]{36}\/[0-9a-f-]{36}|imports\/[0-9a-f-]{36}\/[0-9a-f-]{36}|identity\/[0-9a-f-]{36})$/.test(
        key,
      )
    )
      throw new Error("Invalid Factory secret identity");
    return `/v1/${mount}/data/${key}`;
  }
  return {
    configured,
    async read<T>(key: string, schema: z.ZodType<T>): Promise<T | undefined> {
      const response = await request(path(key), "GET");
      if (response === undefined) return undefined;
      try {
        if (!response || typeof response !== "object" || !("data" in response)) throw unavailable();
        const data = response.data;
        if (!data || typeof data !== "object" || !("data" in data)) throw unavailable();
        return schema.parse(data.data);
      } catch {
        throw unavailable();
      }
    },
    async create<T>(key: string, value: T, schema: z.ZodType<T>) {
      await request(path(key), "POST", { options: { cas: 0 }, data: schema.parse(value) });
    },
    async removeImport(key: string) {
      if (!key.startsWith("imports/"))
        throw new Error("Only temporary import credentials may be removed");
      await request(path(key).replace(`/data/`, `/metadata/`), "DELETE");
    },
    async renew() {
      if (configured) await request("/v1/auth/token/renew-self", "POST");
    },
  };
}
