// Shared utilities, resource planning and bounded process execution for restore rehearsals.
import { randomUUID } from "node:crypto";
import { lstat, readFile, realpath, rename, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import imagePins from "../../deploy/helm/factory/image-pins.json";
import upstream from "../../upstream.json";
import type { RunOptions } from "../owned-client-process";
import type { Digest, Execute, Fixture, Resource } from "./restore-rehearsal-types";

export const images: Record<string, string> = {
  postgres: imagePins.postgres,
  forgejo: imagePins.forgejo,
  garage: imagePins.garage,
  openbao: imagePins.openbao,
  rclone: imagePins.rclone,
  tools: upstream.node.image,
};

// Reviewed native source profiles, not a caller-supplied revision allowlist.
export const managedTLSState = ["ingress-tls/identity.json"] as const;
const sourceProfile = (
  chartRevision: string,
  applicationRevision = chartRevision,
  requiredStateFiles: readonly string[] = managedTLSState,
) => ({ chartRevision, applicationRevision, requiredStateFiles });

export const supportedSourceManifests = [
  sourceProfile(
    "39d7969bb3acd93d0bc497a5748cce08ae435091",
    "089ca64dbc9ab48f3b452151a2d694d7aabe3a10",
    [],
  ),
  sourceProfile("4438e7580db77df3d861e0bcbd5b1f77c914c365"),
  sourceProfile(
    "5609f4cd76bd5203c6ad17ae33a330e65614bb9f",
    "4438e7580db77df3d861e0bcbd5b1f77c914c365",
  ),
  sourceProfile("62288627d2a5b69d5de7b6c2478199d290a5792b"),
  sourceProfile("701ceb9258a1afd298080b0a7075c77ebe906e36"),
  sourceProfile("37db8559833c59925bca477fb1a4d1b29feb15d1"),
  sourceProfile("09e348648f3169555275ae5d9a039f35cdf39bc6"),
] as const;

export const requiredTables = [
  "factory.project",
  "factory.ticket",
  "factory.change",
  "factory.change_writer",
  "factory.runtime_attempt",
  "factory.substrate_source",
  "factory.substrate_provision",
  "factory.operation",
  "factory.schema_migration",
];

export const label = "factory.restore-rehearsal";
export const sha = /^[a-f0-9]{64}$/;
export const identifier = /^[a-z_][a-z0-9_]*$/;
export const postgresIdentifier = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function requireThat(value: unknown, detail: string): asserts value {
  if (!value) throw Error(detail);
}

export function same(a: unknown, b: unknown): boolean {
  if (a === null || b === null || typeof a !== "object" || typeof b !== "object") return a === b;
  if (Array.isArray(a) || Array.isArray(b))
    return (
      Array.isArray(a) &&
      Array.isArray(b) &&
      a.length === b.length &&
      a.every((v, i) => same(v, b[i]))
    );
  const left = a as Record<string, unknown>;
  const right = b as Record<string, unknown>;
  return (
    same(Object.keys(left).sort(), Object.keys(right).sort()) &&
    Object.keys(left).every((key) => same(left[key], right[key]))
  );
}

export function keys(value: unknown, expected: string): asserts value is Record<string, unknown> {
  requireThat(
    value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      same(Object.keys(value).sort(), expected.split(" ").sort()),
    "Unexpected private fixture schema",
  );
}

export function absolute(path: unknown): asserts path is string {
  requireThat(
    typeof path === "string" &&
      isAbsolute(path) &&
      resolve(path) === path &&
      !/[\0\r\n,:]/.test(path),
    "Expected a canonical absolute path without Docker mount delimiters",
  );
}

export function memberPath(path: string) {
  requireThat(
    typeof path === "string" &&
      path.length > 0 &&
      ![...path].some((char) => char.charCodeAt(0) < 32 || char === "\\") &&
      !isAbsolute(path) &&
      path.split("/").every((part) => part && part !== "." && part !== ".."),
    "Unsafe relative backup path",
  );
  return path;
}

export const overlaps = (a: string, b: string) =>
  a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);

export async function ownedPath(path: string, directory: boolean, privateMode = true) {
  absolute(path);
  const info = await lstat(path);
  requireThat(
    !info.isSymbolicLink() &&
      (directory ? info.isDirectory() : info.isFile()) &&
      (directory || info.nlink === 1) &&
      info.uid === process.getuid?.() &&
      (info.mode & (privateMode ? 0o077 : 0o022)) === 0 &&
      (await realpath(path)) === path,
    "Inputs must be owned regular private paths, without symlink ancestors",
  );
  return info;
}

export async function privateJSON(path: string): Promise<unknown> {
  await ownedPath(path, false);
  // Do not include parse errors, filenames, or input values in public diagnostics.
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    throw Error("Private JSON is unreadable");
  }
}

export function tableWitnesses(value: Record<string, Digest>, postgres = false) {
  requireThat(
    value && typeof value === "object" && Object.keys(value).length,
    "Table witnesses are required",
  );
  for (const [table, digest] of Object.entries(value)) {
    const parts = table.split(".");
    requireThat(
      postgres
        ? parts.length === 2 &&
            ["auth", "factory"].includes(parts[0] ?? "") &&
            postgresIdentifier.test(parts[1] ?? "")
        : identifier.test(table),
      "Unsafe witness table",
    );
    keys(digest, "rows sha256");
    requireThat(
      Number.isSafeInteger(digest.rows) && digest.rows >= 0 && sha.test(digest.sha256),
      "A real row count and SHA-256 are required for every table",
    );
  }
}

export function resourcePlan(f: Pick<Fixture, "owner">): Resource[] {
  return [
    { kind: "network" as const, key: "network" },
    ...[
      "control",
      "state",
      "postgres-data",
      "forgejo-data",
      "forgejo-config",
      "objects-data",
      "objects-input",
      "openbao-data",
    ].map((key) => ({ kind: "volume" as const, key })),
    ...["tools", "postgres", "forgejo", "garage", "rclone", "openbao", "bao-client"].map((key) => ({
      kind: "container" as const,
      key,
    })),
  ].map((v) => ({
    ...v,
    name: `factory-restore-${f.owner}-${v.key}`,
    id: null,
    created: null,
    state: "planned",
  }));
}

export async function persist(directory: string, name: string, value: unknown) {
  const temporary = join(directory, `${name}.${randomUUID()}`);
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  await rename(temporary, join(directory, name));
}

export function shellQuote(value: string) {
  return `'${value.replaceAll("'", "'\"'\"'")}'`;
}

// Scripts contain no credential values. Only the private input mount and owned volumes carry raw data.
export const invocation = <T>(fn: (config: T) => Promise<void>, config: T) =>
  `await (${fn.toString()})(${JSON.stringify(config)});`;

export async function safeExecute(
  command: string[],
  options: RunOptions & { env?: Record<string, string> } = {},
) {
  // Do not inherit Docker contexts, proxy variables, credentials or application authority.
  const child = Bun.spawn(command, {
    env: { PATH: process.env["PATH"] ?? "", ...options.env },
    stdin:
      options.input === undefined
        ? "ignore"
        : options.input instanceof Blob
          ? options.input
          : new Blob([options.input as BlobPart]),
    stdout: "pipe",
    stderr: "pipe",
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const stop = () => {
    child.kill("SIGTERM");
    timer ??= setTimeout(() => child.kill("SIGKILL"), 1000);
  };
  options.signal?.addEventListener("abort", stop, { once: true });
  if (options.signal?.aborted) stop();
  try {
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    options.signal?.throwIfAborted();
    return { stdout, stderr, code };
  } finally {
    if (child.exitCode === null && child.signalCode === null) stop();
    await child.exited;
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", stop);
  }
}

export function boundedExecute(f: Fixture, execute: Execute): Execute {
  return async (command, options = {}) => {
    const deadline = AbortSignal.timeout(f.limits.commandTimeoutSeconds * 1000);
    const signal = options.signal ? AbortSignal.any([options.signal, deadline]) : deadline;
    signal.throwIfAborted();
    const result = await execute(command, { ...options, signal });
    signal.throwIfAborted();
    return result;
  };
}
