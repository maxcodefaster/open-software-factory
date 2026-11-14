import { lstat, readFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { removeCleanRoomContainer, run } from "./clean-room-cluster";

export type BackupReader = {
  name: string;
  owner: string;
  cidFile: string;
  containerID: string | null;
  state: "planned" | "confirmed" | "removed" | "unconfirmed";
};

// The daemon-owned reader outlives a cancelled Docker CLI. Bind its cleanup to
// the original create acknowledgement, never to a later occupant of its name.
export async function withDockerBackupReader<T>(
  input: {
    id: string;
    directory: string;
    temporaryDirectory: string;
    image: string;
    signal: AbortSignal;
    record: (resource: BackupReader) => Promise<void>;
  },
  validate: (command: readonly string[]) => Promise<T>,
  execute = run,
): Promise<T> {
  input.signal.throwIfAborted();
  if (
    !/^[a-f0-9]{8}$/.test(input.id) ||
    !isAbsolute(input.directory) ||
    !isAbsolute(input.temporaryDirectory) ||
    !/^docker\.io\/library\/postgres:16\.\d+-bookworm@sha256:[a-f0-9]{64}$/.test(input.image)
  )
    throw Error("Backup reader requires owned paths and the chart's pinned PostgreSQL 16 image");
  const resource: BackupReader = {
    name: `factory-cleanroom-backup-${input.id}`,
    owner: input.id,
    cidFile: join(input.temporaryDirectory, "backup-reader.cid"),
    containerID: null,
    state: "planned",
  };
  const existing = await lstat(resource.cidFile).catch((cause: NodeJS.ErrnoException) => {
    if (cause.code !== "ENOENT") throw cause;
    return null;
  });
  if (existing) throw Error("Backup reader acknowledgement path already exists; nothing started");
  await input.record({ ...resource });
  let invoked = false;
  let outcome: { value: T } | { error: unknown };
  try {
    input.signal.throwIfAborted();
    invoked = true;
    const value = await validate([
      "docker",
      "run",
      "--rm",
      "--name",
      resource.name,
      "--label",
      `factory.clean-room-owner=${resource.owner}`,
      "--cidfile",
      resource.cidFile,
      "--network=none",
      "--read-only",
      "--cap-drop=ALL",
      "--security-opt=no-new-privileges",
      "--user",
      `${process.getuid?.() ?? 1000}:${process.getgid?.() ?? 1000}`,
      "-v",
      `${input.directory}:${input.directory}:ro`,
      "--entrypoint",
      "pg_restore",
      input.image,
    ]);
    input.signal.throwIfAborted();
    outcome = { value };
  } catch (error) {
    outcome = { error };
  }
  const failures: unknown[] = [];
  if (invoked) {
    try {
      const id = (await readFile(resource.cidFile, "utf8")).trim();
      if (!/^[a-f0-9]{64}$/.test(id)) throw Error("Invalid original backup reader ID");
      resource.containerID = id;
      resource.state = "confirmed";
    } catch (cause) {
      failures.push(cause);
      resource.state = "unconfirmed";
    }
    if (resource.containerID) {
      await input.record({ ...resource }).catch((cause: unknown) => failures.push(cause));
      try {
        await removeCleanRoomContainer(resource.containerID, resource.owner, execute);
        resource.state = "removed";
      } catch (cause) {
        failures.push(cause);
        resource.state = "unconfirmed";
      }
    }
  } else resource.state = "removed";
  await input.record({ ...resource }).catch((cause: unknown) => failures.push(cause));
  if (failures.length)
    throw new AggregateError(
      [...("error" in outcome ? [outcome.error] : []), ...failures],
      "Backup reader cleanup or recording is unconfirmed; original intent and private files retained",
    );
  if ("error" in outcome) throw outcome.error;
  return outcome.value;
}
