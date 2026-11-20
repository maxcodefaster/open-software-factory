import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  forgeBinding,
  forgeRepositoryBindingMatrix,
  useForgeBindingEnvironment,
} from "../../../../test/support/forge-repository-binding";
import {
  cleanRuntimeSourceArchive,
  prepareRuntimeRepository,
  resolveRepositoryRevision,
  runtimeSourceCapability,
  serveRuntimeRepository,
  validRuntimeSourceCapability,
} from "./git-http";

const repositories: string[] = [];

test("Git HTTP and revision/archive preparation reject malformed bindings before native calls", async () => {
  const requests: string[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const path = new URL(request.url).pathname;
      requests.push(path);
      expect(request.headers.get("authorization")).toBe(
        path.includes("/branches/")
          ? "Bearer owned-binding-test-token"
          : `Basic ${Buffer.from("factory:owned-binding-test-token").toString("base64")}`,
      );
      return path.includes("/branches/")
        ? Response.json({ name: "main", commit: { id: "a".repeat(40) } })
        : new Response("owned-git");
    },
  });
  const binding = { ...forgeBinding, apiURL: `${server.url}api/v1/` };
  const restore = useForgeBindingEnvironment(binding);
  const { accepted, malformed } = forgeRepositoryBindingMatrix(binding);
  const spawn = spyOn(Bun, "spawn").mockImplementation(() => {
    throw new Error("Malformed binding cannot spawn a native command");
  });
  try {
    const request = new Request("https://factory.test/source/info/refs?service=git-upload-pack");
    for (const { url, repository } of accepted) {
      expect(await resolveRepositoryRevision(url, "main")).toBe("a".repeat(40));
      expect(await (await serveRuntimeRepository(request, url, "/source")).text()).toBe(
        "owned-git",
      );
      expect(await prepareRuntimeRepository("owned-binding-attempt", url, "a".repeat(40))).toBe(
        url,
      );
      expect(requests.slice(-2)).toEqual([
        `/api/v1/repos/owned/${repository.name}/branches/main`,
        `/owned/${repository.name}.git/info/refs`,
      ]);
    }
    const before = requests.length;
    // file:// remains the explicit local test-fixture transport, tested separately below.
    for (const url of malformed.filter((url) => !url.startsWith("file://"))) {
      await expect(resolveRepositoryRevision(url, "main")).rejects.toThrow();
      await expect(serveRuntimeRepository(request, url, "/source")).rejects.toThrow();
      await expect(
        prepareRuntimeRepository("owned-binding-attempt", url, "a".repeat(40)),
      ).rejects.toThrow();
      await expect(
        cleanRuntimeSourceArchive(url, "a".repeat(40), "01234567-89ab-cdef-0123-456789abcdef"),
      ).rejects.toThrow();
      expect(requests).toHaveLength(before);
      expect(spawn).not.toHaveBeenCalled();
    }
  } finally {
    spawn.mockRestore();
    restore();
    await server.stop(true);
  }
});

test("configured public Forge source resolves and streams only through its private authenticated API", async () => {
  const requests: string[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      requests.push(new URL(request.url).pathname);
      if (new URL(request.url).pathname.includes("/branches/")) {
        expect(request.headers.get("authorization")).toBe("Bearer controlled-owned-token");
        return Response.json({ name: "main", commit: { id: "a".repeat(40) } });
      }
      expect(request.headers.get("authorization")).toBe(
        `Basic ${Buffer.from("factory:controlled-owned-token").toString("base64")}`,
      );
      return new Response("owned-private-git");
    },
  });
  const values = {
    FACTORY_FORGEJO_API_URL: `${server.url}api/v1/`,
    FACTORY_FORGEJO_PUBLIC_URL: "https://git.owned-factory.invalid",
    FACTORY_FORGEJO_OWNER: "owned",
    FACTORY_FORGEJO_TOKEN: "controlled-owned-token",
  };
  const previous = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));
  try {
    Object.assign(process.env, values);
    expect(
      await resolveRepositoryRevision("https://git.owned-factory.invalid/owned/source.git", "main"),
    ).toBe("a".repeat(40));
    const response = await serveRuntimeRepository(
      new Request("https://factory.test/source/info/refs?service=git-upload-pack"),
      "https://git.owned-factory.invalid/owned/source.git",
      "/source",
    );
    expect(await response.text()).toBe("owned-private-git");
    expect(requests).toEqual([
      "/api/v1/repos/owned/source/branches/main",
      "/owned/source.git/info/refs",
    ]);
    for (const url of [
      "https://unrelated.invalid/owned/source.git",
      "https://user:password@git.owned-factory.invalid/owned/source.git",
      "https://git.owned-factory.invalid/owned/source.git?token=not-allowed",
      "https://git.owned-factory.invalid/owned/source.git#fragment",
      "https://git.owned-factory.invalid/other/source.git",
      "https://git.owned-factory.invalid/owned/nested/source.git",
    ])
      await expect(resolveRepositoryRevision(url, "main")).rejects.toThrow(
        "outside the configured forge",
      );
    expect(requests).toHaveLength(2);
  } finally {
    for (const key of Object.keys(values)) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
    await server.stop(true);
  }
});

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
