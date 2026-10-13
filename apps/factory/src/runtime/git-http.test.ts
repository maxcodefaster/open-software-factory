import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  resolveRepositoryRevision,
  runtimeSourceCapability,
  validRuntimeSourceCapability,
  serveRuntimeRepository,
} from "./git-http";

const repositories: string[] = [];

afterEach(async () => {
  await Promise.all(
    repositories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

test("private forge Git reads keep credentials server-side and reject writes and other repositories", async () => {
  const received: Array<string | null> = [];
  const encodings: Array<string | null> = [];
  const protocols: Array<string | null> = [];
  const forge = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(request) {
      received.push(request.headers.get("authorization"));
      encodings.push(request.headers.get("content-encoding"));
      protocols.push(request.headers.get("git-protocol"));
      return new Response("git-read", {
        headers: {
          "content-type": "application/x-git-upload-pack-advertisement",
          "set-cookie": "must-not-forward=1",
        },
      });
    },
  });
  const keys = [
    "FACTORY_FORGEJO_API_URL",
    "FACTORY_FORGEJO_TOKEN",
    "FACTORY_FORGEJO_OWNER",
  ] as const;
  const previous = keys.map((key) => process.env[key]);
  process.env["FACTORY_FORGEJO_API_URL"] = `${forge.url}api/v1/`;
  process.env["FACTORY_FORGEJO_TOKEN"] = "owned-git-read-sentinel";
  process.env["FACTORY_FORGEJO_OWNER"] = "owned";
  try {
    const prefix = "/capability";
    const read = new Request(`http://factory.test${prefix}/info/refs?service=git-upload-pack`);
    const response = await serveRuntimeRepository(read, `${forge.url}owned/private.git`, prefix);
    expect(await response.text()).toBe("git-read");
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(received[0]).toBe(
      `Basic ${Buffer.from("factory:owned-git-read-sentinel").toString("base64")}`,
    );
    expect(
      (
        await serveRuntimeRepository(
          new Request(`http://factory.test${prefix}/git-receive-pack`, { method: "POST" }),
          `${forge.url}owned/private.git`,
          prefix,
        )
      ).status,
    ).toBe(403);
    await expect(
      serveRuntimeRepository(read, `${forge.url}other/private.git`, prefix),
    ).rejects.toThrow("outside the configured forge");
    expect(received).toHaveLength(1);
    await serveRuntimeRepository(
      new Request(`http://factory.test${prefix}/git-upload-pack`, {
        method: "POST",
        body: Bun.gzipSync("git request"),
        headers: {
          "content-type": "application/x-git-upload-pack-request",
          "content-encoding": "gzip",
          "git-protocol": "version=2",
        },
      }),
      `${forge.url}owned/private.git`,
      prefix,
    );
    expect(encodings.at(-1)).toBe("gzip");
    expect(protocols.at(-1)).toBe("version=2");
  } finally {
    for (const [index, key] of keys.entries()) {
      const value = previous[index];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await forge.stop(true);
  }
});

async function git(repository: string, ...arguments_: string[]) {
  const process = Bun.spawn(["git", "-C", repository, ...arguments_], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [output, error, exitCode] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
    process.exited,
  ]);
  if (exitCode !== 0) throw new Error(error);
  return output.trim();
}

describe("runtime source capability", () => {
  test("is attempt-bound and rejects guesses", () => {
    const capability = runtimeSourceCapability("attempt-one");
    expect(validRuntimeSourceCapability("attempt-one", capability)).toBe(true);
    expect(validRuntimeSourceCapability("attempt-two", capability)).toBe(false);
    expect(validRuntimeSourceCapability("attempt-one", "0".repeat(64))).toBe(false);
  });
});

describe("Project revision resolution", () => {
  test("resolves a branch to the exact commit present at intent time", async () => {
    const repository = resolve(`/tmp/factory-git-http-${crypto.randomUUID()}`);
    repositories.push(repository);
    await mkdir(repository);
    await git(repository, "init", "--initial-branch=main");
    await writeFile(resolve(repository, "fixture.txt"), "one\n");
    await git(repository, "add", ".");
    await git(
      repository,
      "-c",
      "user.name=Factory",
      "-c",
      "user.email=factory@example.invalid",
      "commit",
      "-m",
      "one",
    );
    const first = await resolveRepositoryRevision(`file://${repository}`, "main");
    expect(first).toBe(await git(repository, "rev-parse", "HEAD"));

    await writeFile(resolve(repository, "fixture.txt"), "two\n");
    await git(repository, "add", ".");
    await git(
      repository,
      "-c",
      "user.name=Factory",
      "-c",
      "user.email=factory@example.invalid",
      "commit",
      "-m",
      "two",
    );
    expect(await resolveRepositoryRevision(`file://${repository}`, "main")).not.toBe(first);
  });
});
