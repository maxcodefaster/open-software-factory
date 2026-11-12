import { constants } from "node:fs";
import { mkdir, open, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { parseAllDocuments } from "yaml";
import { z } from "zod";
import {
  overlaySubstrateEgress,
  parseEnvoy,
  verifySubstrateLiveClusters,
} from "./substrate-egress";
import { digest, pins, renderSubstrateProfile, verifyNightly } from "./substrate-profile";

const root = resolve(import.meta.dir, "../..");
const resource = z.object({
  metadata: z.object({ name: z.string(), uid: z.string().min(1), resourceVersion: z.string() }),
});

async function run(args: string[], input?: string) {
  const child = Bun.spawn(args, {
    cwd: root,
    stdin: input === undefined ? "ignore" : new Blob([input]),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, status] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (status !== 0) throw new Error(`${args[0]} failed (${status}): ${stderr}`);
  return stdout;
}

// Exclusive output, or identical existing output. Never replace unknown files.
async function save(path: string, value: Uint8Array | string, mode = 0o600) {
  const bytes = typeof value === "string" ? Buffer.from(value) : value;
  let file: Awaited<ReturnType<typeof open>>;
  try {
    file = await open(path, "wx", mode);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const existing = await open(
      path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    try {
      if (
        !(await existing.stat()).isFile() ||
        !Buffer.from(bytes).equals(await existing.readFile())
      )
        throw new Error(`Refusing to overwrite different existing file: ${path}`);
      await existing.chmod(mode);
    } finally {
      await existing.close();
    }
    return;
  }
  try {
    await file.writeFile(bytes);
    await file.sync();
  } finally {
    await file.close();
  }
}

export async function pinnedSubstrateSource(directory: string) {
  const source = resolve(directory);
  const head = await run(["git", "-C", source, "rev-parse", "HEAD"]);
  if (head.trim() !== pins.substrate.commit) throw new Error("Wrong Substrate source commit");
  const dirty = await run(["git", "-C", source, "status", "--porcelain", "--untracked-files=no"]);
  if (dirty.trim()) throw new Error("Substrate source has tracked changes");
  return source;
}

export async function upstreamEgress(directory: string) {
  const source = await pinnedSubstrateSource(directory);
  const documents = parseAllDocuments(
    await readFile(resolve(source, "manifests/ate-install/atenet-egress.yaml"), "utf8"),
  );
  if (documents.some((document) => document.errors.length))
    throw new Error("Invalid upstream YAML");
  const values = documents.map((document) => document.toJS({ maxAliasCount: 0 }));
  const maps = values.filter((value) => value.kind === "ConfigMap");
  if (maps.length !== 1 || maps[0].metadata.name !== "atenet-egress")
    throw new Error("Unexpected upstream egress ConfigMap");
  return z.object({ data: z.record(z.string(), z.string()) }).parse(maps[0]).data;
}

export async function verifySubstrateArchive(path: string) {
  verifyNightly(await readFile(path));
  const child = Bun.spawn(["tar", "--zstd", "-xOf", path, "runsc"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [bytes, error, status] = await Promise.all([
    new Response(child.stdout).arrayBuffer(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (status !== 0 || digest(new Uint8Array(bytes)) !== pins.gvisor.runscSha256)
    throw new Error(`Pinned archive runsc verification failed: ${error}`);
  return { archive: pins.gvisor.sha256, runsc: pins.gvisor.runscSha256 };
}

async function assets(directory: string) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const download = async (url: string) => {
    const response = await fetch(url, { signal: AbortSignal.timeout(120_000) });
    if (!response.ok) throw new Error(`Official asset download failed: ${response.status}`);
    return new Uint8Array(await response.arrayBuffer());
  };
  const archive = await download(pins.gvisor.url);
  verifyNightly(archive);
  const published = new TextDecoder().decode(await download(`${pins.gvisor.url}.sha512`));
  if (published.trim().split(/\s+/)[0] !== pins.gvisor.sha512)
    throw new Error("Official published SHA512 differs from approved pin");
  const path = resolve(directory, "gvisor.tar.zstd");
  await save(path, archive);
  await save(resolve(directory, "gvisor.tar.zstd.sha512"), published);
  await verifySubstrateArchive(path);
  const cli = await download(
    `https://github.com/agent-substrate/substrate/releases/download/${pins.substrate.release}/kubectl-ate-linux-amd64`,
  );
  if (digest(cli) !== pins.substrate.cliSha256) throw new Error("Substrate CLI checksum mismatch");
  await save(resolve(directory, "kubectl-ate"), cli, 0o500);
}

function kubectl(kubeconfig: string, context: string) {
  if (!kubeconfig || !context) throw new Error("Explicit kubeconfig and context required");
  return ["kubectl", "--kubeconfig", resolve(kubeconfig), "--context", context, "-n", "ate-system"];
}

async function liveEgress(k: string[], expected: Record<string, unknown>, portValue: string) {
  const port = z.coerce.number().int().min(1024).max(65535).parse(portValue);
  const pods = JSON.parse(
    await run([...k, "get", "pods", "-l", "app=atenet-egress", "-o", "json"]),
  );
  const live = z
    .array(
      z.object({
        metadata: z.object({ name: z.string(), deletionTimestamp: z.string().optional() }),
        status: z.object({
          conditions: z.array(z.object({ type: z.string(), status: z.string() })),
        }),
      }),
    )
    .parse(pods.items)
    .filter(
      (pod) =>
        !pod.metadata.deletionTimestamp &&
        pod.status.conditions.some(
          (condition) => condition.type === "Ready" && condition.status === "True",
        ),
    );
  if (!live.length) throw new Error("No Ready egress Pods");
  for (const pod of live) {
    const forward = Bun.spawn(
      [...k, "port-forward", `pod/${pod.metadata.name}`, `${port}:15000`, "--address=127.0.0.1"],
      {
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    try {
      const reader = forward.stdout.getReader();
      await Promise.race([
        (async () => {
          let output = "";
          while (true) {
            const chunk = await reader.read();
            if (chunk.done) throw new Error("Egress admin port-forward exited before readiness");
            output += new TextDecoder().decode(chunk.value);
            if (output.includes(`127.0.0.1:${port}`)) return;
          }
        })(),
        new Promise((_, reject) => {
          const timeout = setTimeout(() => reject(new Error("Admin port-forward timeout")), 15_000);
          timeout.unref();
        }),
      ]);
      const get = async (path: string) => {
        const response = await fetch(`http://127.0.0.1:${port}${path}`, {
          signal: AbortSignal.timeout(10_000),
        });
        if (!response.ok) throw new Error(`Envoy admin check failed: ${response.status}`);
        return response.json();
      };
      const info = z.object({ version: z.string() }).parse(await get("/server_info"));
      if (!info.version.startsWith(`${pins.envoy.commit}/${pins.envoy.version}/`))
        throw new Error(
          "Unqualified live Envoy version/module ABI; no binary substitution allowed",
        );
      verifySubstrateLiveClusters(await get("/config_dump?resource=static_clusters"), expected);
    } finally {
      forward.kill();
      await forward.exited;
    }
  }
  return { verifiedReadyPods: live.map((pod) => pod.metadata.name), tlsSessionResumption: false };
}

export async function applySubstrateEgress(
  directory: string,
  kubeconfig: string,
  context: string,
  port: string,
  apply: boolean,
  ports = { run, upstream: upstreamEgress, live: liveEgress },
) {
  const upstream = await ports.upstream(directory);
  const expected = parseEnvoy(upstream["envoy.yaml"] ?? "");
  const k = kubectl(kubeconfig, context);
  const getMap = async () =>
    JSON.parse(await ports.run([...k, "get", "configmap", "atenet-egress", "-o", "json"]));
  const before = await getMap();
  resource.parse(before);
  for (const [key, value] of Object.entries(upstream))
    if (key !== "envoy.yaml" && before.data[key] !== value)
      throw new Error("SDS configuration drift from pinned upstream");
  const after = overlaySubstrateEgress(before, expected);
  if (apply) {
    // replace includes the observed UID and resourceVersion: conflicts fail closed.
    if (!isDeepStrictEqual(before, after))
      await ports.run([...k, "replace", "-f", "-"], JSON.stringify(after));
    const deployment = JSON.parse(
      await ports.run([...k, "get", "deployment", "atenet-egress", "-o", "json"]),
    );
    const identity = resource.parse(deployment).metadata;
    // Restart even on no-op application: installer regeneration may not restart
    // Pods, and a mounted CM is not proof of the active Envoy configuration.
    await ports.run([
      ...k,
      "patch",
      "deployment",
      "atenet-egress",
      "--type=merge",
      "-p",
      JSON.stringify({
        metadata: { uid: identity.uid, resourceVersion: identity.resourceVersion },
        spec: {
          template: {
            metadata: {
              annotations: { "factory.runtime/egress-applied-at": new Date().toISOString() },
            },
          },
        },
      }),
    ]);
    await ports.run([...k, "rollout", "status", "deployment/atenet-egress", "--timeout=180s"]);
  } else if (!isDeepStrictEqual(before, after)) throw new Error("Egress overlay is not applied");
  const observed = await getMap();
  if (
    observed.metadata.uid !== before.metadata.uid ||
    !isDeepStrictEqual(observed.data, after.data)
  )
    throw new Error("Egress ConfigMap changed during application/verification");
  const live = await ports.live(k, expected, port);
  const final = await getMap();
  if (final.metadata.uid !== before.metadata.uid || !isDeepStrictEqual(final.data, after.data))
    throw new Error("Egress ConfigMap changed during live verification");
  return live;
}

if (import.meta.main) {
  const [command, ...args] = process.argv.slice(2);
  if (command === "assets" && args.length === 1) await assets(resolve(args[0] ?? ""));
  else if (command === "verify-assets" && args.length === 1)
    console.log(await verifySubstrateArchive(resolve(args[0] ?? "")));
  else if (command === "overlay-egress" && args.length === 3) {
    const data = await upstreamEgress(args[0] ?? "");
    const value = JSON.parse(await readFile(resolve(args[1] ?? ""), "utf8"));
    await save(
      resolve(args[2] ?? ""),
      `${JSON.stringify(overlaySubstrateEgress(value, parseEnvoy(data["envoy.yaml"] ?? "")), null, 2)}\n`,
    );
  } else if (command === "render" && args.length === 2) {
    const profile = renderSubstrateProfile(
      JSON.parse(await readFile(resolve(args[0] ?? ""), "utf8")),
    );
    const directory = resolve(args[1] ?? "");
    await mkdir(directory, { recursive: true, mode: 0o700 });
    for (const [name, value] of Object.entries(profile))
      await save(resolve(directory, `${name}.json`), `${JSON.stringify(value, null, 2)}\n`);
  } else if ((command === "apply-egress" || command === "verify-egress") && args.length === 4) {
    console.log(
      await applySubstrateEgress(
        args[0] ?? "",
        args[1] ?? "",
        args[2] ?? "",
        args[3] ?? "",
        command === "apply-egress",
      ),
    );
  } else if (command === "check-upstream" && args.length === 2) {
    const source = await pinnedSubstrateSource(args[0] ?? "");
    const data = await upstreamEgress(source);
    const bootstrap = parseEnvoy(data["envoy.yaml"] ?? "");
    const configMap = {
      apiVersion: "v1",
      kind: "ConfigMap",
      metadata: { name: "atenet-egress", namespace: "ate-system" },
      data,
    };
    const once = overlaySubstrateEgress(configMap, bootstrap);
    if (!isDeepStrictEqual(once, overlaySubstrateEgress(once, bootstrap)))
      throw new Error("Not idempotent");
    console.log(
      await run([
        "go",
        "-C",
        source,
        "run",
        "-mod=vendor",
        resolve(root, "deploy/substrate/schema-check.go"),
        source,
        resolve(args[1] ?? ""),
      ]),
    );
  } else
    throw new Error(
      "Usage: substrate-profile-command.ts assets DIR | verify-assets ARCHIVE | render INPUT DIR | check-upstream SOURCE RENDERED_DIR | overlay-egress SOURCE INPUT OUTPUT | apply-egress SOURCE KUBECONFIG CONTEXT LOCAL_PORT | verify-egress SOURCE KUBECONFIG CONTEXT LOCAL_PORT",
    );
}
