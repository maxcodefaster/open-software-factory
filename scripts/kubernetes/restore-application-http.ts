// Process execution, pinned HTTPS requests, Solid server-function wire, and container build introspection.
import * as https from "node:https";
import { isIP } from "node:net";
import { checkServerIdentity } from "node:tls";
import {
  check,
  type FunctionName,
  type FunctionValues,
  functions,
  type HTTPRequest,
  type HTTPResponse,
  type LoadedApplicationFixture,
  object,
  origin,
  type Wire,
} from "./restore-application-types";

// Hash before importing the fixed, verified compiler entry for the same introspection
// used by test/fixtures/server-functions.ts. Never invoke any Factory function.
// Self-contained: serialized via invocation() and run inside the application container.
export async function applicationBuildTree(expectedTree: string) {
  const fs = await import("node:fs/promises");
  const { createHash } = await import("node:crypto");
  const root = "/opt/factory/apps/factory/dist";
  const files: string[] = [];
  async function walk(path: string) {
    for (const entry of await fs.readdir(`${root}/${path}`, { withFileTypes: true })) {
      const file = `${path}${entry.name}`;
      if (entry.isDirectory()) await walk(`${file}/`);
      else if (entry.isFile()) files.push(file);
      else throw Error("Unsupported build tree");
    }
  }
  await walk("");
  if (!files.includes("server/entry.js")) throw Error("Missing built handler");
  const hash = createHash("sha256");
  for (const file of files.sort()) {
    const bytes = await fs.readFile(`${root}/${file}`);
    hash.update(`${file}\0${createHash("sha256").update(bytes).digest("hex")}\n`);
  }
  const treeSHA256 = hash.digest("hex");
  if (treeSHA256 !== expectedTree) throw Error("Built application changed");
  const installation = JSON.parse(
    await fs.readFile("/var/lib/factory/kubernetes-installation.json", "utf8"),
  );
  const ready = JSON.parse(await fs.readFile("/var/lib/factory/kubernetes-ready.json", "utf8"));
  const entrypoint = "/opt/factory/apps/factory/dist/server/entry.js";
  const entry = await import(entrypoint);
  const functions = Object.fromEntries(
    ["getBootstrap", "getTicketDetail", "saveTicketDocument"].map((name) => [
      name,
      entry.compiledFunctionID(entry.factoryFunctions[name]),
    ]),
  );
  const environmentHashes = Object.fromEntries(
    [
      "FACTORY_BASE_URL",
      "FACTORY_FORGEJO_PUBLIC_URL",
      "FACTORY_FORGEJO_API_URL",
      "FACTORY_HELM_RELEASE",
      "FACTORY_STATE_DIRECTORY",
      "FACTORY_AUTH_SECRET",
      "FACTORY_ADMIN_PASSWORD",
      "FACTORY_DATABASE_PASSWORD",
      "FACTORY_WIKI_WEBHOOK_SECRET",
      "DATABASE_URL",
    ].map((name) => {
      const value = process.env[name];
      if (typeof value !== "string" || !value) throw Error("Missing inherited configuration");
      return [name, createHash("sha256").update(value).digest("hex")];
    }),
  );
  process.stdout.write(
    JSON.stringify({
      treeSHA256,
      installation,
      startupID: ready.startupID,
      functions,
      environmentHashes,
    }),
  );
}

export async function executeCommand(
  args: string[],
  input: string | undefined,
  signal: AbortSignal,
) {
  const child = Bun.spawn(args, {
    env: { PATH: process.env["PATH"] ?? "" },
    stdin: input === undefined ? "ignore" : new Blob([input]),
    stdout: "pipe",
    stderr: "pipe",
  });
  const abort = () => child.kill("SIGKILL");
  signal.addEventListener("abort", abort, { once: true });
  if (signal.aborted) abort();
  try {
    const [code, stdout] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    signal.throwIfAborted();
    return { code, stdout };
  } finally {
    signal.removeEventListener("abort", abort);
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await child.exited;
  }
}

// Connect to a literal target IP. Host, SNI and explicit certificate identity
// checking remain the public origin. No DNS, redirects, proxy or connection pool.
export async function pinnedApplicationRequest(
  input: HTTPRequest,
  send: typeof https.request = https.request,
): Promise<HTTPResponse> {
  const url = origin(new URL(input.url).origin);
  const target = new URL(input.url);
  check(isIP(input.address) && !target.username && !target.password && !target.hash);
  return new Promise((accept, reject) => {
    const options: https.RequestOptions & { autoSelectFamily: boolean } = {
      hostname: input.address,
      port: 443,
      servername: url.hostname,
      ca: input.ca,
      rejectUnauthorized: true,
      checkServerIdentity: (_hostname, certificate) =>
        checkServerIdentity(url.hostname, certificate),
      family: isIP(input.address),
      method: input.method,
      path: target.pathname + target.search,
      agent: false,
      autoSelectFamily: false,
      signal: input.signal,
      headers: { ...input.headers, host: url.host },
    };
    const request = send(options, (response) => {
      const chunks: Buffer[] = [];
      let size = 0;
      response.on("data", (bytes: Buffer) => {
        size += bytes.length;
        if (size > input.limit) response.destroy(Error("Application response exceeds bound"));
        else chunks.push(bytes);
      });
      response.once("error", reject);
      response.once("end", () =>
        accept({
          status: response.statusCode ?? 0,
          headers: response.headers as HTTPResponse["headers"],
          body: Buffer.concat(chunks),
        }),
      );
    });
    request.once("error", reject);
    request.end(input.body);
  });
}

export async function createWire(): Promise<Wire> {
  const client = await import("@solidjs/web/server-functions/client");
  return {
    serialize: (args) => client.serializeString([{ method: "POST", data: args }]),
    decode: async (response) => {
      const result = await client.decodeResponse<{ result?: unknown; error?: unknown }>(response);
      check(result && !result.error);
      return result.result;
    },
  };
}

export const parseJSON = (response: HTTPResponse) =>
  JSON.parse(Buffer.from(response.body).toString("utf8"));

export function createApplicationSession(
  f: LoadedApplicationFixture,
  deps: {
    http: typeof pinnedApplicationRequest;
    verifyOwnership: () => Promise<void>;
    signal: () => AbortSignal;
  },
) {
  const original = f.backupReceipt.source;
  let cookies = new Map<string, string>();
  const cookieHeader = () => [...cookies].map(([key, value]) => `${key}=${value}`).join("; ");

  async function request(
    url: string,
    method: "GET" | "POST",
    body?: string,
    forge = false,
    extra: Record<string, string> = {},
  ) {
    await deps.verifyOwnership();
    const target = new URL(url);
    check(target.origin === (forge ? original.forgejoOrigin : original.factoryOrigin));
    const headers: Record<string, string> = { ...extra, origin: target.origin };
    if (forge) headers["authorization"] = `Bearer ${f.forgeTokenValue}`;
    else if (cookies.size) headers["cookie"] = cookieHeader();
    const response = await deps.http({
      url,
      address: f.target.address,
      ca: f.caBytes,
      method,
      headers,
      ...(body === undefined ? {} : { body }),
      limit: f.limits.responseBytes,
      signal: deps.signal(),
    });
    check(response.status === 200 && response.body.byteLength <= f.limits.responseBytes);
    if (!forge) {
      const raw = response.headers["set-cookie"];
      for (const field of typeof raw === "string" ? [raw] : (raw ?? [])) {
        const [pair, ...attributes] = field.split(";").map((v) => v.trim());
        check(pair && !/[\r\n]/.test(pair));
        const equals = pair.indexOf("=");
        check(equals > 0);
        const key = pair.slice(0, equals),
          value = pair.slice(equals + 1);
        check(/^[A-Za-z0-9_.-]+$/.test(key));
        const attrs = new Map(
          attributes.map((v) => [v.split("=")[0]?.toLowerCase(), v.slice(v.indexOf("=") + 1)]),
        );
        check(
          attrs.has("secure") &&
            (!attrs.has("domain") || attrs.get("domain")?.replace(/^\./, "") === target.hostname) &&
            (!attrs.has("path") || attrs.get("path") === "/"),
        );
        if (!value || attrs.get("max-age") === "0") cookies.delete(key);
        else cookies.set(key, value);
      }
    }
    return response;
  }

  async function callFunction<K extends FunctionName>(
    transport: Wire,
    key: K,
    args: unknown[],
  ): Promise<FunctionValues[K]> {
    check(functions.includes(key));
    const response = await request(
      `${original.factoryOrigin}/_server/data/${f.buildEvidence.functions[key]}`,
      "POST",
      await transport.serialize(args),
      false,
      { "content-type": "text/plain", "x-server-function-format": "0" },
    );
    const result = await transport.decode(
      new Response(Buffer.from(response.body), {
        status: response.status,
        headers: response.headers as HeadersInit,
      }),
    );
    object(result);
    check(result["ok"] === true);
    return result["value"] as FunctionValues[K];
  }

  return {
    request,
    callFunction,
    cookieHeader,
    hasCookies: () => cookies.size > 0,
    clearCookies: () => {
      cookies = new Map();
    },
  };
}
