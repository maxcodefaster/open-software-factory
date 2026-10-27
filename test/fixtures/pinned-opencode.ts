import { mkdir, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { createOpenCodeClient } from "../../apps/factory/src/agent/opencode-client";
import upstream from "../../upstream.json";
import { buildModelID } from "./change-agent-turns";

export async function docker(...args: string[]) {
  const process = Bun.spawn(["docker", ...args], { stdout: "pipe", stderr: "pipe" });
  const [out, error, status] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
    process.exited,
  ]);
  if (status !== 0) throw new Error(`Owned process fixture failed: ${args[0]}: ${error}`);
  return (args[0] === "logs" ? out + error : out).trim();
}

export async function observe<T>(
  read: () => Promise<T>,
  accepts: (value: T) => boolean,
  failure = "Owned process assertion did not become true",
  timeout = 15_000,
) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await read();
    if (accepts(value)) return value;
    await Bun.sleep(50);
  }
  throw new Error(failure);
}

export async function pinnedOpenCode(
  artifactImage?: string,
  browserClient?: { path: string; endpoint: string; token: string; turnID: string },
  serverBinary = process.env["FACTORY_OPENCODE_SERVER_TEST_BINARY"],
  providerBaseURL?: string,
  retainedProject?: string,
  expectedVersion = upstream.openCode.version,
  skillManifest?: {
    digest: string;
    files: Array<{ path: string; body: string; digest: string; executable: boolean }>;
  },
  nativeProvider?: {
    modelID: string;
    package: string;
    settings: Record<string, unknown>;
    model?: Record<string, unknown>;
  },
) {
  artifactImage ??=
    process.env["FACTORY_OPENCODE_TEST_IMAGE"] ??
    (await readFile(resolve(".factory/build-runtime-host-image"), "utf8")).trim();
  // The default proof runs the same packaged OpenCode 2 server as Build.
  // Only an explicitly supplied candidate binary uses the upgrade harness.
  const packaged = !serverBinary;
  const nativeServer = Boolean(serverBinary || packaged);
  if (!/^(?:[a-zA-Z0-9.:/-]+@)?sha256:[a-f0-9]{64}$/.test(artifactImage))
    throw new Error("Owned OpenCode artifact requires an exact image digest");
  if (artifactImage.includes("@")) {
    // Publication uses a host port-forward alias. The identical manifest can
    // already be local without its cluster-only DNS name being a local alias.
    // Resolve only the exact digest, never a mutable tag or an older artifact.
    const digest = artifactImage.split("@").at(-1);
    const images = (await docker("image", "ls", "--digests", "--format", "{{json .}}"))
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { Repository: string; Digest: string });
    const local = images.find((image) => image.Digest === digest && image.Repository !== "<none>");
    if (!local)
      throw new Error(
        "Publish the exact OpenCode runtime artifact into local Docker before this native proof",
      );
    artifactImage = `${local.Repository}@${digest}`;
  }
  const id = crypto.randomUUID();
  const source = `factory-owned-opencode-artifact-${id}`;
  const container = `factory-owned-opencode-process-${id}`;
  const network = `factory-owned-opencode-network-${id}`;
  const scratch = await realpath(await mkdtemp(resolve(tmpdir(), "factory-opencode-process-")));
  const project = retainedProject ?? resolve(scratch, "project");
  await mkdir(project, { recursive: true });
  const evidence = resolve(".factory/test-results/opencode-process", id);
  await mkdir(evidence, { recursive: true });
  const created: string[] = [];
  const acknowledged = new Set<string>();
  let networkIntended = false;
  let networkAcknowledged = false;
  async function create(name: string, ...args: string[]) {
    created.push(name);
    await writeFile(
      resolve(evidence, "intent.json"),
      JSON.stringify({
        id,
        source,
        container,
        artifactImage,
        scratch,
        ownerProcessID: process.pid,
        attempted: created,
        network,
      }),
      { mode: 0o600 },
    );
    await docker(...args);
    acknowledged.add(name);
  }
  async function dispose() {
    for (const name of [...created].reverse()) {
      const owner = await docker(
        "inspect",
        "--format",
        '{{index .Config.Labels "factory.owned-process-test"}}',
        name,
      ).catch((cause: unknown) => {
        if (cause instanceof Error && /no such (?:object|container)/i.test(cause.message)) {
          if (acknowledged.has(name)) return null;
          throw new Error(`Owned create outcome is unconfirmed; retain ${evidence}/intent.json`);
        }
        throw cause;
      });
      if (owner === null) {
        created.splice(created.indexOf(name), 1);
        continue;
      }
      if (owner !== id) throw new Error("Owned process cleanup refused");
      await docker("rm", "--force", "--volumes", name);
      created.splice(created.indexOf(name), 1);
    }
    if (networkIntended) {
      const owner = await docker(
        "network",
        "inspect",
        "--format",
        '{{index .Labels "factory.owned-process-test"}}',
        network,
      ).catch((cause: unknown) => {
        if (
          networkAcknowledged &&
          cause instanceof Error &&
          /(?:no such|not found)/i.test(cause.message)
        )
          return null;
        throw cause;
      });
      if (owner !== null) {
        if (owner !== id) throw new Error("Owned process network cleanup refused");
        await docker("network", "rm", network);
      }
      networkIntended = false;
    }
    await writeFile(resolve(evidence, "cleanup.json"), JSON.stringify({ removed: true }));
  }
  try {
    const label = `factory.owned-process-test=${id}`;
    await create(
      source,
      "create",
      "--pull=never",
      "--name",
      source,
      "--label",
      label,
      artifactImage,
    );
    networkIntended = true;
    await writeFile(
      resolve(evidence, "network-intent.json"),
      JSON.stringify({ network, owner: id }),
    );
    await docker("network", "create", "--label", label, network);
    networkAcknowledged = true;
    if (skillManifest)
      await Bun.write(resolve(scratch, "admitted-skills.json"), JSON.stringify(skillManifest));
    if (packaged) {
      // Run the exact runtime artifact itself; do not copy hundreds of upstream files to the host.
    } else if (serverBinary) {
      const { copyFile } = await import("node:fs/promises");
      await copyFile(serverBinary, resolve(scratch, "opencode"));
    } else
      await docker(
        "cp",
        `${source}:/opt/factory/opencode/glibc/opencode`,
        resolve(scratch, "opencode"),
      );
    await create(
      container,
      "run",
      "--detach",
      "--name",
      container,
      "--label",
      label,
      "--network",
      network,
      "--env",
      `FACTORY_PROCESS_MODEL_ID=${nativeProvider?.modelID ?? buildModelID}`,
      ...(nativeProvider
        ? ["--env", `FACTORY_PROCESS_NATIVE_PROVIDER=${JSON.stringify(nativeProvider)}`]
        : []),
      ...(providerBaseURL ? ["--env", `FACTORY_PROCESS_PROVIDER_URL=${providerBaseURL}`] : []),
      ...(nativeServer ? ["--env", "FACTORY_PROCESS_NATIVE_SERVER=1"] : []),
      ...(skillManifest
        ? [
            "--env",
            "FACTORY_PROCESS_SKILL_MANIFEST=/owned-skills.json",
            "--mount",
            `type=bind,src=${resolve(scratch, "admitted-skills.json")},dst=/owned-skills.json,readonly`,
          ]
        : []),
      ...(packaged ? ["--env", "FACTORY_PROCESS_PACKAGED_SERVER=1"] : []),
      ...(browserClient
        ? [
            "--env",
            `FACTORY_BUILD_BROWSER_URL=${browserClient.endpoint}`,
            "--env",
            "FACTORY_BUILD_BROWSER_COMMAND=/tmp/factory-runtime-connector-1",
            "--env",
            `FACTORY_BUILD_BROWSER_TOKEN=${browserClient.token}`,
            "--env",
            `FACTORY_PROCESS_BROWSER_TURN=${browserClient.turnID}`,
            "--mount",
            `type=bind,src=${browserClient.path},dst=/tmp/factory-runtime-connector-1,readonly`,
          ]
        : []),
      "--publish",
      "127.0.0.1::4096",
      "--publish",
      "127.0.0.1::4097",
      ...(!packaged
        ? [
            "--mount",
            `type=bind,src=${resolve(scratch, "opencode")},dst=/opt/factory/opencode,readonly`,
          ]
        : []),
      ...(nativeServer && !packaged
        ? [
            "--mount",
            `type=bind,src=${resolve("deploy/opencode-server")},dst=/owned-server,readonly`,
          ]
        : []),
      "--mount",
      `type=bind,src=${project},dst=/workspace/project`,
      "--mount",
      `type=bind,src=${resolve("test/fixtures")},dst=/owned-fixture,readonly`,
      ...(packaged ? ["--entrypoint", "node"] : []),
      packaged ? artifactImage : upstream.nodeDevelopment.image,
      ...(!packaged ? ["node"] : []),
      "/owned-fixture/opencode-process.mjs",
    );
    const port = (await docker("port", container, "4096/tcp")).split(":").at(-1);
    const controlPort = (await docker("port", container, "4097/tcp")).split(":").at(-1);
    const transport = (request: Request, path: string) => {
      const target = new Request(`http://127.0.0.1:${port}${path}`, request);
      target.headers.set(
        "authorization",
        `Basic ${Buffer.from("opencode:owned-opencode-server-password").toString("base64")}`,
      );
      return fetch(target, {
        signal: AbortSignal.any([request.signal, AbortSignal.timeout(15_000)]),
      });
    };
    const client = createOpenCodeClient(transport);
    // Read native identity for either the retained source or the upgraded artifact.
    const nativeInfo = async () => {
      const path = "/api/info";
      const response = await transport(new Request(`http://owned${path}`), path);
      if (!response.ok) throw new Error(`Owned server readiness failed: ${response.status}`);
      return response.json() as Promise<{ version: string }>;
    };
    const control = async (action = "", method = "GET") => {
      const response = await fetch(`http://127.0.0.1:${controlPort}/control${action}`, {
        method,
        signal: AbortSignal.timeout(5_000),
      });
      if (!response.ok) throw new Error(`Owned process control failed: ${response.status}`);
      return response.json() as Promise<{
        pid: number;
        generation: number;
        running: boolean;
        providerRequests: number;
        heldRequests: number;
        heldCodingRequests: number;
        browserTools: string[];
        imageRequests: number;
        browserContextRequests: number;
        factoryPolicyRequests: number;
        requiredSkillRequests: number;
        summaryRequests: number;
      }>;
    };
    await observe(
      async () => {
        try {
          await nativeInfo();
          return true;
        } catch {
          return false;
        }
      },
      (ready) => ready,
      "Owned native server did not become ready",
      45_000,
    );
    // Both readiness paths are read-only. Candidate discovery can return 503
    // during activation; observe this location without restarting or prompting.
    await observe(
      () =>
        client.model
          .list(
            { location: { directory: "/workspace/project" } },
            { signal: AbortSignal.timeout(10_000) },
          )
          .then(() => true)
          .catch(() => false),
      (ready) => ready,
      "Owned native location did not become ready",
      45_000,
    );
    const version = nativeServer
      ? `opencode v${(await nativeInfo()).version}`
      : await docker("exec", container, "/opt/factory/opencode", "--version");
    if (version !== `opencode v${expectedVersion}`)
      throw new Error(`Pinned OpenCode version differs: ${version}`);
    console.log("Owned pinned process", { version, scratch });
    const installBrowserScreenshot = async (sessionID: string, data: string) => {
      if (!/^[a-f0-9-]{36}$/.test(sessionID))
        throw new Error("Owned screenshot Session identity required");
      await docker(
        "exec",
        container,
        "node",
        "-e",
        "const fs=require('fs');const dir='/tmp/factory-build-browser-'+process.argv[1];fs.mkdirSync(dir,{mode:0o700});fs.writeFileSync(dir+'/screenshot.jpg',Buffer.from(process.argv[2],'base64'),{mode:0o600})",
        sessionID,
        data,
      );
    };
    return {
      client,
      container,
      control,
      transport,
      dispose,
      scratch,
      installBrowserScreenshot,
      diagnostics: async () => ({
        state: await docker("inspect", "--format", "{{json .State}}", container),
        logs: (await docker("logs", container)).slice(-4000),
      }),
    };
  } catch (cause) {
    if (nativeServer && acknowledged.has(container))
      console.log("Owned native server startup", (await docker("logs", container)).slice(-3000));
    try {
      await dispose();
    } catch (cleanup) {
      throw new AggregateError([cause, cleanup], "Owned process failed and cleanup is unconfirmed");
    }
    throw cause;
  }
}
