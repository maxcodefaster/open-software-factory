// Docker daemon preflight, owned resource lifecycle, and cleanup for restore rehearsals.
import { join } from "node:path";
import type { Output } from "../owned-client-process";
import {
  boundedExecute,
  images,
  label,
  ownedPath,
  persist,
  privateJSON,
  requireThat,
  resourcePlan,
  safeExecute,
  same,
  sha,
} from "./restore-rehearsal-common";
import type {
  DockerRunner,
  Execute,
  Fixture,
  Journal,
  Kind,
  LoadedFixture,
  Resource,
} from "./restore-rehearsal-types";

const absent = (output: Output) =>
  output.code !== 0 &&
  /^Error(?: response from daemon)?: (?:[^\n]*no such (?:container|object|network|volume)\b|network [a-zA-Z0-9_.-]+ not found\b)/i.test(
    output.stderr.trim(),
  );

const projection = (kind: Kind) =>
  kind === "container"
    ? '{"id":{{json .Id}},"name":{{json .Name}},"created":{{json .Created}},"labels":{{json .Config.Labels}}}'
    : kind === "network"
      ? '{"id":{{json .Id}},"name":{{json .Name}},"created":{{json .Created}},"labels":{{json .Labels}},"internal":{{json .Internal}}}'
      : '{"id":{{json .Name}},"name":{{json .Name}},"created":{{json .CreatedAt}},"labels":{{json .Labels}}}';

export function docker(f: Fixture, ...args: string[]) {
  // --config points only at the supplied private fixture, never the user's Docker login/context.
  return ["docker", "--config", f.privateRoot, "--host", f.docker.host, ...args];
}

function labels(journal: Journal, resource: Resource) {
  return {
    [`${label}.owner`]: journal.owner,
    [`${label}.run`]: journal.run,
    [`${label}.resource`]: resource.key,
    [`${label}.source`]: journal.source.namespaceUID,
    [`${label}.set`]: journal.set,
  };
}

async function observe(f: Fixture, journal: Journal, resource: Resource, execute: Execute) {
  const output = await execute(
    docker(
      f,
      resource.kind,
      "inspect",
      "--format",
      projection(resource.kind),
      resource.id ?? resource.name,
    ),
    { allowFailure: true },
  );
  if (absent(output)) return null;
  requireThat(output.code === 0, "Destination observation unconfirmed");
  let observed: {
    id: string;
    name: string;
    created: string;
    labels: Record<string, string>;
    internal?: boolean;
  };
  try {
    observed = JSON.parse(output.stdout);
  } catch {
    throw Error("Destination observation unreadable");
  }
  requireThat(
    typeof observed.id === "string" &&
      typeof observed.created === "string" &&
      observed.name.replace(/^\//, "") === resource.name &&
      (resource.kind === "volume" ? observed.id === resource.name : sha.test(observed.id)) &&
      (!resource.id || observed.id === resource.id) &&
      (!resource.created || observed.created === resource.created) &&
      observed.labels &&
      Object.entries(labels(journal, resource)).every(
        ([key, value]) => observed.labels[key] === value,
      ) &&
      (resource.kind !== "network" || observed.internal === true),
    "Destination identity/labels changed; nothing removed",
  );
  return observed;
}

export async function cleanupOwned(f: Fixture, journal: Journal, execute: Execute) {
  let confirmed = true;
  // Removing containers joins daemon-owned execs before volumes/network are considered.
  const ordered = [...journal.resources]
    .reverse()
    .sort((a, b) => Number(b.kind === "container") - Number(a.kind === "container"));
  for (const resource of ordered) {
    if (resource.state === "removed") continue;
    try {
      const observed = await observe(f, journal, resource, execute);
      if (observed) {
        resource.id = observed.id;
        resource.created = observed.created;
        await persist(f.evidenceDirectory, "ownership.json", journal);
        const output = await execute(
          docker(
            f,
            resource.kind,
            "rm",
            ...(resource.kind === "container" ? ["--force"] : []),
            observed.id,
          ),
          { allowFailure: true },
        );
        requireThat(output.code === 0, "Exact owned resource removal failed");
        requireThat(
          (await observe(f, journal, resource, execute)) === null,
          "Owned resource removal not observed",
        );
      }
      resource.state = "removed";
    } catch {
      resource.state = "unconfirmed";
      confirmed = false;
    }
    await persist(f.evidenceDirectory, "ownership.json", journal);
  }
  return confirmed;
}

export async function verifyDaemonPreflight(
  f: LoadedFixture,
  planned: Resource[],
  execute: Execute,
  signal?: AbortSignal,
) {
  const output = await execute(
    docker(
      f,
      "info",
      "--format",
      '{"id":{{json .ID}},"cpus":{{json .NCPU}},"memory":{{json .MemTotal}}}',
    ),
    { signal },
  );
  const info = JSON.parse(output.stdout);
  requireThat(
    output.code === 0 &&
      info.id === f.docker.daemonID &&
      info.cpus >= f.limits.cpus * 3 &&
      info.memory >= f.limits.memoryMiB * 3 * 1024 ** 2,
    "Daemon identity/capacity does not match explicit fixture",
  );
  for (const image of Object.values(images)) {
    const result = await execute(
      docker(f, "image", "inspect", "--format", "{{.Os}}/{{.Architecture}}", image),
      { signal },
    );
    requireThat(
      result.code === 0 && result.stdout.trim() === f.docker.platform,
      "Pinned image must already exist for the explicit platform; no pulls",
    );
  }
  for (const resource of planned) {
    const result = await execute(
      docker(f, resource.kind, "inspect", "--format", projection(resource.kind), resource.name),
      { signal, allowFailure: true },
    );
    requireThat(
      absent(result),
      "Destination name is occupied or its absence is unconfirmed; nothing created",
    );
  }
}

export function createDockerRunner(
  f: LoadedFixture,
  journal: Journal,
  planned: Resource[],
  execute: Execute,
  signal?: AbortSignal,
): DockerRunner {
  const resources = new Map(planned.map((v) => [v.key, v]));
  const state = { fatal: false };
  const get = (key: string) => {
    const resource = resources.get(key);
    if (!resource) throw Error("Unknown owned resource");
    return resource;
  };
  const name = (key: string) => get(key).name;
  const volume = (key: string, target: string, ro = false) => [
    "--mount",
    `type=volume,src=${name(key)},dst=${target}${ro ? ",readonly" : ""}`,
  ];
  const controlMount = ["--mount", `type=volume,src=${name("control")},dst=/control`];
  const inputMount = ["--mount", `type=bind,src=${f.privateRoot},dst=/input,readonly`];

  async function command(args: string[], input?: string, env?: Record<string, string>) {
    signal?.throwIfAborted();
    const timeout = AbortSignal.timeout(f.limits.commandTimeoutSeconds * 1000);
    let result: Output;
    try {
      result = await execute(docker(f, ...args), {
        ...(input === undefined ? {} : { input }),
        ...(env === undefined ? {} : { env }),
        allowFailure: true,
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      });
    } catch (error) {
      // A killed client does not terminate a daemon-owned exec. Stop the entire rehearsal
      // before another component starts; exact-ID cleanup kills and joins its container.
      if (timeout.aborted || (error instanceof Error && error.name === "TimeoutError"))
        state.fatal = true;
      throw Error("Owned command completion unconfirmed; sensitive diagnostics suppressed");
    }
    signal?.throwIfAborted();
    requireThat(
      !timeout.aborted && result.code === 0,
      "Owned restore command failed; sensitive output suppressed",
    );
    return result.stdout.trim();
  }

  async function create(key: string, args: string[] = [], env?: Record<string, string>) {
    const resource = get(key);
    signal?.throwIfAborted();
    journal.resources.push(resource);
    await persist(f.evidenceDirectory, "ownership.json", journal);
    await command(
      [
        resource.kind,
        "create",
        ...Object.entries(labels(journal, resource)).flatMap(([k, v]) => ["--label", `${k}=${v}`]),
        ...args,
        ...(resource.kind === "container" ? [] : [resource.name]),
      ],
      undefined,
      env,
    );
    const observed = await observe(f, journal, resource, execute);
    requireThat(observed, "Original create could not be confirmed");
    resource.id = observed.id;
    resource.created = observed.created;
    resource.state = "confirmed";
    await persist(f.evidenceDirectory, "ownership.json", journal);
  }

  async function container(
    key: string,
    image: string,
    args: string[],
    entrypoint: string,
    tail: string[],
    env?: Record<string, string>,
  ) {
    await create(
      key,
      [
        "--name",
        name(key),
        "--pull",
        "never",
        "--platform",
        f.docker.platform,
        "--read-only",
        "--cap-drop=ALL",
        "--security-opt=no-new-privileges",
        "--pids-limit",
        String(f.limits.pids),
        "--memory",
        `${f.limits.memoryMiB}m`,
        "--cpus",
        String(f.limits.cpus),
        "--log-driver=none",
        "--restart=no",
        "--tmpfs",
        `/tmp:rw,nosuid,nodev,noexec,size=${f.limits.tmpfsMiB}m`,
        ...args,
        "--entrypoint",
        entrypoint,
        image,
        ...tail,
      ],
      env,
    );
    await command(["container", "start", get(key).id ?? ""]);
  }

  async function exec(key: string, script: string, shell = "node") {
    try {
      return await command(
        [
          "exec",
          "-i",
          get(key).id ?? "",
          ...(shell === "node" ? ["node", "--input-type=module"] : [shell, "-s"]),
        ],
        script,
      );
    } catch {
      // This shared staging container must not keep an uncertain raw-data writer alive.
      if (key === "tools") state.fatal = true;
      throw Error("Owned component command failed; sensitive diagnostics suppressed");
    }
  }

  return { state, controlMount, inputMount, get, name, volume, command, create, container, exec };
}

export async function runCleanupCommand(f: Fixture) {
  await ownedPath(f.evidenceDirectory, true);
  const raw = (await privateJSON(join(f.evidenceDirectory, "ownership.json"))) as Journal;
  requireThat(
    raw.schema === 1 &&
      raw.owner === f.owner &&
      raw.set === f.set &&
      same(raw.source, f.source) &&
      raw.daemonID === f.docker.daemonID &&
      /^[a-f0-9-]{36}$/.test(raw.run) &&
      Array.isArray(raw.resources),
    "Cleanup journal does not match explicit fixture",
  );
  const allowed = resourcePlan(f);
  for (const resource of raw.resources)
    requireThat(
      allowed.some(
        (entry) =>
          entry.kind === resource.kind &&
          entry.name === resource.name &&
          entry.key === resource.key,
      ),
      "Journal contains a resource outside this exact owned plan",
    );
  const execute = boundedExecute(f, safeExecute);
  const observed = await execute(docker(f, "info", "--format", "{{.ID}}"));
  requireThat(
    observed.code === 0 && observed.stdout.trim() === raw.daemonID,
    "Cleanup daemon identity differs",
  );
  // Interruptions keep their unsuccessful exit status, but do not abandon owned cleanup.
  const confirmed = await cleanupOwned(f, raw, execute);
  await persist(f.evidenceDirectory, "cleanup.json", { owner: f.owner, confirmed });
  return confirmed;
}
