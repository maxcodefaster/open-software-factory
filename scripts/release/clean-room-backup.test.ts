import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type BackupReader, withDockerBackupReader } from "./clean-room-backup";

const image = `docker.io/library/postgres:16.14-bookworm@sha256:${"a".repeat(64)}`;
const containerID = "b".repeat(64);

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "factory-backup-reader-"));
  const states: BackupReader[] = [];
  const controller = new AbortController();
  return {
    directory,
    states,
    controller,
    input: {
      id: "1234abcd",
      directory,
      temporaryDirectory: directory,
      image,
      signal: controller.signal,
      async record(resource: BackupReader) {
        states.push(resource);
      },
    },
    close: () => rm(directory, { recursive: true, force: true }),
  };
}

for (const stopped of [false, true])
  test(`the backup reader cleans its original ID after ${stopped ? "cancellation" : "validation"}`, async () => {
    const f = await fixture();
    const commands: string[][] = [];
    const reason = new Error("Owned backup interrupted");
    try {
      const result = withDockerBackupReader(
        f.input,
        async (command) => {
          expect(f.states[0]?.state).toBe("planned");
          expect(command).toContain("--network=none");
          expect(command).toContain("--read-only");
          expect(command).toContain(`${f.directory}:${f.directory}:ro`);
          expect(command.slice(-3)).toEqual(["--entrypoint", "pg_restore", image]);
          const cidFile = command[command.indexOf("--cidfile") + 1];
          if (!cidFile) throw Error("Original create acknowledgement file missing");
          await writeFile(cidFile, containerID, { flag: "wx" });
          if (stopped) f.controller.abort(reason);
          return "validated";
        },
        async (command, options) => {
          expect(options?.signal).toBeUndefined();
          commands.push(command);
          return {
            code: 0,
            stdout: command.includes("inspect")
              ? JSON.stringify({ id: containerID, owner: f.input.id })
              : containerID,
            stderr: "",
          };
        },
      );
      if (stopped) await expect(result).rejects.toBe(reason);
      else expect(await result).toBe("validated");
      expect(commands[0]?.at(-1)).toBe(containerID);
      expect(commands[1]).toEqual(["docker", "rm", "--force", containerID]);
      expect(f.states.map((state) => state.state)).toEqual(["planned", "confirmed", "removed"]);
    } finally {
      await f.close();
    }
  });

test.each([
  "already removed",
  "foreign owner",
  "wrong ID",
  "no create acknowledgement",
  "daemon unavailable",
] as const)("backup reader cleanup observes the original identity: %s", async (boundary) => {
  const f = await fixture();
  const commands: string[][] = [];
  try {
    const result = withDockerBackupReader(
      f.input,
      async () => {
        if (boundary !== "no create acknowledgement")
          await writeFile(join(f.directory, "backup-reader.cid"), containerID, { flag: "wx" });
        return "validated";
      },
      async (command) => {
        commands.push(command);
        return {
          code: boundary === "already removed" || boundary === "daemon unavailable" ? 1 : 0,
          stdout: JSON.stringify({
            id: boundary === "wrong ID" ? "c".repeat(64) : containerID,
            owner: boundary === "foreign owner" ? "another-owner" : f.input.id,
          }),
          stderr:
            boundary === "already removed"
              ? `Error: No such object: ${containerID}`
              : "dial unix docker.sock: connect: no such file or directory",
        };
      },
    );
    if (boundary === "already removed") {
      expect(await result).toBe("validated");
      expect(f.states.at(-1)?.state).toBe("removed");
    } else {
      await expect(result).rejects.toThrow("cleanup or recording is unconfirmed");
      expect(f.states.at(-1)?.state).toBe("unconfirmed");
    }
    expect(commands).toHaveLength(boundary === "no create acknowledgement" ? 0 : 1);
    expect(commands.every((command) => command.at(-1) === containerID)).toBe(true);
  } finally {
    await f.close();
  }
});

test.each(["unpinned image", "existing acknowledgement", "already cancelled"] as const)(
  "invalid backup reader inputs refuse before any create: %s",
  async (boundary) => {
    const f = await fixture();
    let invoked = false;
    try {
      if (boundary === "unpinned image") f.input.image = "postgres:16";
      if (boundary === "existing acknowledgement")
        await writeFile(join(f.directory, "backup-reader.cid"), containerID);
      if (boundary === "already cancelled") f.controller.abort();
      await expect(
        withDockerBackupReader(f.input, async () => {
          invoked = true;
        }),
      ).rejects.toThrow();
      expect(invoked).toBe(false);
      expect(f.states).toHaveLength(0);
    } finally {
      await f.close();
    }
  },
);
