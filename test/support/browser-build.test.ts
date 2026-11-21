import { expect, test } from "bun:test";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { prepareBrowserBuild } from "../fixtures/browser-build";

async function artifacts(directory: string) {
  await mkdir(resolve(directory, "server"), { recursive: true });
  await mkdir(resolve(directory, "client/assets"), { recursive: true });
  await writeFile(resolve(directory, "server/entry.js"), "owned build");
}

test("direct browser runs build once in an owned directory and remove only that build", async () => {
  const environment: Record<string, string | undefined> = {
    NODE_ENV: "test",
    FACTORY_MODEL_API_KEY: "must-not-reach-build",
    FACTORY_OBJECT_S3_SECRET_ACCESS_KEY: "must-not-reach-build",
    FACTORY_LEARNING_MODEL_LIVE: "1",
  };
  const parent = resolve(".factory/test-results/application-builds");
  await mkdir(parent, { recursive: true });
  const other = await mkdtemp(resolve(parent, "browser-unrelated-"));
  await writeFile(resolve(other, "retained"), "unrelated build");
  let directory = "",
    calls = 0;
  let dispose: (() => Promise<void>) | undefined;
  try {
    dispose = await prepareBrowserBuild(environment, async (input) => {
      calls++;
      directory = input["FACTORY_BUILD_DIRECTORY"] ?? "";
      expect(directory.startsWith(`${parent}/browser-ui-`)).toBe(true);
      expect(input["NODE_ENV"]).toBe("production");
      for (const key of [
        "FACTORY_MODEL_API_KEY",
        "FACTORY_OBJECT_S3_SECRET_ACCESS_KEY",
        "FACTORY_LEARNING_MODEL_LIVE",
      ])
        expect(input[key]).toBeUndefined();
      await artifacts(directory);
    });
    expect(calls).toBe(1);
    expect(environment["NODE_ENV"]).toBe("test");
    expect(environment["FACTORY_MODEL_API_KEY"]).toBe("must-not-reach-build");
    expect(environment["FACTORY_BUILD_DIRECTORY"]).toBe(directory);
    await access(resolve(directory, "server/entry.js"));
    await dispose();
    await expect(access(directory)).rejects.toMatchObject({ code: "ENOENT" });
    expect(environment["FACTORY_BUILD_DIRECTORY"]).toBeUndefined();
    expect(await readFile(resolve(other, "retained"), "utf8")).toBe("unrelated build");
  } finally {
    await dispose?.();
    await rm(other, { recursive: true, force: true });
  }
});

test("a browser runner nested in an integration proof neither rebuilds nor removes its caller's artifacts", async () => {
  const parent = resolve(".factory/test-results/application-builds");
  await mkdir(parent, { recursive: true });
  const directory = await mkdtemp(resolve(parent, "browser-caller-"));
  try {
    await artifacts(directory);
    const environment = { FACTORY_BUILD_DIRECTORY: directory };
    const dispose = await prepareBrowserBuild(environment, async () => {
      throw new Error("Must not rebuild caller-owned artifacts");
    });
    await dispose();
    expect(environment.FACTORY_BUILD_DIRECTORY).toBe(directory);
    expect(await readFile(resolve(directory, "server/entry.js"), "utf8")).toBe("owned build");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test.each(["failed", "incomplete"] as const)(
  "browser setup removes its %s build output and selection",
  async (outcome) => {
    const environment: Record<string, string | undefined> = {};
    let directory = "";
    await expect(
      prepareBrowserBuild(environment, async (input) => {
        directory = input["FACTORY_BUILD_DIRECTORY"] ?? "";
        await writeFile(resolve(directory, "partial"), "unfinished");
        if (outcome === "failed") throw new Error("Controlled compilation failure");
      }),
    ).rejects.toThrow();
    expect(environment["FACTORY_BUILD_DIRECTORY"]).toBeUndefined();
    await expect(access(directory)).rejects.toMatchObject({ code: "ENOENT" });
  },
);

test("an invalid inherited browser build fails without deleting or replacing it", async () => {
  const parent = resolve(".factory/test-results/application-builds");
  await mkdir(parent, { recursive: true });
  const directory = await mkdtemp(resolve(parent, "browser-incomplete-caller-"));
  try {
    await writeFile(resolve(directory, "retained"), "do not replace");
    const environment = { FACTORY_BUILD_DIRECTORY: directory };
    await expect(
      prepareBrowserBuild(environment, async () => {
        throw new Error("Must not rebuild an inherited selection");
      }),
    ).rejects.toMatchObject({ code: "ENOENT" });
    expect(environment.FACTORY_BUILD_DIRECTORY).toBe(directory);
    expect(await readFile(resolve(directory, "retained"), "utf8")).toBe("do not replace");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("browser build cancellation keeps a zero-exit compilation interrupted and removes its output", async () => {
  const cancellation = new AbortController();
  const environment: Record<string, string | undefined> = {};
  let directory = "";
  await expect(
    prepareBrowserBuild(
      environment,
      async (input, signal) => {
        expect(signal).toBe(cancellation.signal);
        directory = input["FACTORY_BUILD_DIRECTORY"] ?? "";
        await artifacts(directory);
        cancellation.abort("SIGTERM");
      },
      cancellation.signal,
    ),
  ).rejects.toBe("SIGTERM");
  expect(environment["FACTORY_BUILD_DIRECTORY"]).toBeUndefined();
  await expect(access(directory)).rejects.toMatchObject({ code: "ENOENT" });
});

test("cancelled borrowing leaves the caller's verified build and selection unchanged", async () => {
  const environment: Record<string, string | undefined> = {};
  const dispose = await prepareBrowserBuild(environment, async (input) => {
    await artifacts(input["FACTORY_BUILD_DIRECTORY"] ?? "");
  });
  const directory = environment["FACTORY_BUILD_DIRECTORY"] ?? "";
  try {
    const cancellation = new AbortController();
    const borrowing = prepareBrowserBuild(
      environment,
      async () => {
        throw new Error("Borrowing must not compile");
      },
      cancellation.signal,
    );
    cancellation.abort("SIGINT");
    await expect(borrowing).rejects.toBe("SIGINT");
    expect(environment["FACTORY_BUILD_DIRECTORY"]).toBe(directory);
    expect(await readFile(resolve(directory, "server/entry.js"), "utf8")).toBe("owned build");
    const beforeAdmission = new AbortController();
    beforeAdmission.abort("SIGTERM");
    await expect(
      prepareBrowserBuild(
        {},
        async () => {
          throw new Error("Cancelled build must not be admitted");
        },
        beforeAdmission.signal,
      ),
    ).rejects.toBe("SIGTERM");
  } finally {
    await dispose();
  }
});

test("a selected owned build directory cannot overwrite an existing artifact", async () => {
  const parent = resolve(".factory/test-results/application-builds");
  await mkdir(parent, { recursive: true });
  const directory = await mkdtemp(resolve(parent, "browser-collision-"));
  const environment: Record<string, string | undefined> = {};
  try {
    await writeFile(resolve(directory, "retained"), "other owner's build");
    await expect(
      prepareBrowserBuild(
        environment,
        async () => {
          throw new Error("Colliding build must not be admitted");
        },
        undefined,
        directory,
      ),
    ).rejects.toMatchObject({ code: "EEXIST" });
    expect(environment["FACTORY_BUILD_DIRECTORY"]).toBeUndefined();
    expect(await readFile(resolve(directory, "retained"), "utf8")).toBe("other owner's build");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
