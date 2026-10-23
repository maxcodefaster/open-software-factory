import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import {
  factoryServerComposeOverlay,
  prepareFactoryServerContainer,
  requireFactoryServerImage,
  requireFactoryServerRuntimeHost,
  retainedFactoryServerContainer,
  stopFactoryServerContainer,
} from "./server-container";

const image = `sha256:${"a".repeat(64)}`;
const containerID = "b".repeat(64);
const startupID = "b253ade6-c86e-41b4-a9c2-1bd78e8a311c";
const ok = (stdout = "") => ({ exitCode: 0, stdout, stderr: "" });
const missing = () => ({ exitCode: 1, stdout: "", stderr: "Error: No such container" });

test("Linux server networking adds only the exact private Forgejo binding", () => {
  expect(factoryServerComposeOverlay("192.168.139.2", 51419)).toEqual({
    services: { forgejo: { ports: ["192.168.139.2:51419:3000"] } },
  });
  expect(factoryServerComposeOverlay("10.12.0.4", 33030)).toEqual({
    services: { forgejo: { ports: ["10.12.0.4:33030:3000"] } },
  });
  for (const host of ["0.0.0.0", "127.0.0.1", "8.8.8.8", "host.orb.internal", "192.168.1.2:80"])
    expect(() => factoryServerComposeOverlay(host, 33030)).toThrow("private IPv4");
  for (const port of [0, 1023, 65536, 33030.5, Number.NaN])
    expect(() => factoryServerComposeOverlay("192.168.139.2", port)).toThrow("listener port");
});

async function fixture(nodeEnv?: string) {
  const directory = await mkdtemp(resolve(tmpdir(), "factory-server-container-"));
  const prepared = await prepareFactoryServerContainer(
    {
      stateDirectory: directory,
      sharedStateDirectory: directory,
      image,
      startupID,
      environment: {
        NODE_ENV: nodeEnv,
        FACTORY_RUNTIME_HOST: "192.168.139.2",
        FACTORY_MODEL_API_KEY: "private-provider-key",
        FACTORY_STARTUP_ID: startupID,
        DATABASE_URL: "postgresql://factory:private-password@127.0.0.1:57432/factory",
        HOME: "/host-home-is-not-container-home",
      },
    },
    async (args) => {
      if (args[0] === "kubectl") return ok("apiVersion: v1\nclusters: []\n");
      const intended = JSON.parse(
        await readFile(resolve(directory, "server-container.json"), "utf8"),
      );
      return ok(
        JSON.stringify({
          id: containerID,
          image,
          name: `/${intended.name}`,
          labels: {
            "factory.dev/server-owner": intended.owner,
            "factory.dev/server-startup": startupID,
          },
        }),
      );
    },
  );
  const intended = await retainedFactoryServerContainer(directory);
  if (!intended) throw new Error("Expected the persisted server identity");
  const actual = {
    id: containerID,
    image,
    name: `/${intended.name}`,
    labels: {
      "factory.dev/server-owner": intended.owner,
      "factory.dev/server-startup": startupID,
    },
  };
  return { directory, prepared, intended, actual };
}

test("server image is resolved before replacement and rejects missing or unsafe references", async () => {
  expect(await requireFactoryServerImage("factory:local", async () => ok(`${image}\n`))).toBe(
    image,
  );
  await expect(requireFactoryServerImage("factory:missing", async () => missing())).rejects.toThrow(
    "before replacing",
  );
  let called = false;
  await expect(
    requireFactoryServerImage("factory:local --privileged", async () => {
      called = true;
      return ok(image);
    }),
  ).rejects.toThrow("Invalid");
  expect(called).toBe(false);
});

test("server preparation rejects unsupported callback addresses before commands or intent", async () => {
  for (const value of ["10.0.0.2", "172.16.0.2", "172.31.255.254", "192.168.139.2"])
    expect(requireFactoryServerRuntimeHost(value)).toBe(value);
  for (const runtimeHost of [
    "host.orb.internal",
    "localhost",
    "127.0.0.2",
    "0.0.0.0",
    "::1",
    "192.168.139.2/invalid",
    "8.8.8.8",
  ]) {
    const directory = await mkdtemp(resolve(tmpdir(), "factory-server-container-"));
    let called = false;
    try {
      await expect(
        prepareFactoryServerContainer(
          {
            stateDirectory: directory,
            sharedStateDirectory: directory,
            image,
            startupID,
            environment: { FACTORY_RUNTIME_HOST: runtimeHost },
          },
          async () => {
            called = true;
            return ok("private-kubeconfig");
          },
        ),
      ).rejects.toThrow("private IPv4");
      expect(called).toBe(false);
      expect(await retainedFactoryServerContainer(directory)).toBeNull();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
});

test("server launch persists identity and keeps secrets out of arguments and public metadata", async () => {
  const { directory, prepared, intended } = await fixture();
  try {
    expect(prepared.command.join(" ")).not.toContain("docker.sock");
    expect(prepared.command).toContain("host");
    expect(prepared.command).toContain(image);
    expect(prepared.command.join(" ")).not.toContain("private-provider-key");
    expect(prepared.command.join(" ")).not.toContain("private-password");
    expect(JSON.stringify(intended)).not.toContain("private-provider-key");
    const privateDirectory = resolve(directory, "server-runtime", startupID);
    const environment = await readFile(resolve(privateDirectory, "environment"), "utf8");
    expect(environment).toContain("FACTORY_MODEL_API_KEY=private-provider-key");
    expect(environment).toContain("KUBECONFIG=/run/factory/kubeconfig");
    expect(environment).toContain("NODE_ENV=development");
    expect(environment).not.toContain("HOME=");
    expect((await stat(resolve(privateDirectory, "environment"))).mode & 0o777).toBe(0o600);
    expect((await stat(resolve(privateDirectory, "kubeconfig"))).mode & 0o777).toBe(0o600);
    expect(intended.containerID).toBeNull();
    expect(intended.runtimeHost).toBe("192.168.139.2");
    await expect(
      prepareFactoryServerContainer(
        {
          stateDirectory: directory,
          sharedStateDirectory: directory,
          image,
          startupID,
          environment: {},
        },
        async () => ok("unused"),
      ),
    ).rejects.toThrow("Stop the recorded");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("an explicit production environment is never weakened by the local server launcher", async () => {
  const { directory } = await fixture("production");
  try {
    expect(
      await readFile(resolve(directory, "server-runtime", startupID, "environment"), "utf8"),
    ).toContain("NODE_ENV=production");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("configured OpenBao files outside installation state are mounted read-only", async () => {
  const directory = await mkdtemp(resolve(tmpdir(), "factory-server-container-"));
  const credentials = await mkdtemp(resolve(tmpdir(), "factory-server-credentials-"));
  const ca = resolve(credentials, "root CA.pem");
  const token = resolve(credentials, "token");
  try {
    await writeFile(ca, "certificate", { mode: 0o600 });
    await writeFile(token, "private-store-token", { mode: 0o600 });
    const prepared = await prepareFactoryServerContainer(
      {
        stateDirectory: directory,
        sharedStateDirectory: directory,
        image,
        startupID,
        environment: {
          FACTORY_RUNTIME_HOST: "192.168.139.2",
          FACTORY_OPENBAO_TOKEN_FILE: token,
          FACTORY_OPENBAO_CA_FILE: ca,
        },
      },
      async () => ok("apiVersion: v1\nclusters: []\n"),
    );
    expect(prepared.command).toContain(`type=bind,src=${ca},dst=${ca},readonly`);
    expect(prepared.command).toContain(`type=bind,src=${token},dst=${token},readonly`);
    expect(prepared.command.join(" ")).not.toContain("private-store-token");
  } finally {
    await rm(directory, { recursive: true, force: true });
    await rm(credentials, { recursive: true, force: true });
  }
});

test("missing credential files refuse preparation without an external create or retained intent", async () => {
  const directory = await mkdtemp(resolve(tmpdir(), "factory-server-container-"));
  let called = false;
  try {
    await expect(
      prepareFactoryServerContainer(
        {
          stateDirectory: directory,
          sharedStateDirectory: directory,
          image,
          startupID,
          environment: {
            FACTORY_RUNTIME_HOST: "192.168.139.2",
            FACTORY_OPENBAO_CA_FILE: resolve(directory, "missing-ca"),
          },
        },
        async () => {
          called = true;
          return ok("unused");
        },
      ),
    ).rejects.toThrow("FACTORY_OPENBAO_CA_FILE must name an available regular file");
    expect(called).toBe(false);
    expect(await retainedFactoryServerContainer(directory)).toBeNull();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("creation confirmation freezes the observed container and removes its environment file", async () => {
  const { directory, prepared } = await fixture();
  try {
    await prepared.confirm();
    await prepared.confirm();
    expect((await retainedFactoryServerContainer(directory))?.containerID).toBe(containerID);
    expect(
      await Bun.file(resolve(directory, "server-runtime", startupID, "environment")).exists(),
    ).toBe(false);
    expect(
      await Bun.file(resolve(directory, "server-runtime", startupID, "kubeconfig")).exists(),
    ).toBe(true);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Stop recovers an unknown create by its exact name without replaying creation", async () => {
  const { directory, actual } = await fixture();
  try {
    // The launcher first leaves intent with a deterministic name, then confirms
    // the same externally observed container after exact HTTP readiness.
    const file = resolve(directory, "server-container.json");
    const intended = JSON.parse(await readFile(file, "utf8"));
    const calls: string[][] = [];
    const stopped = await stopFactoryServerContainer(directory, async (args) => {
      calls.push([...args]);
      if (args[1] === "inspect")
        return calls.some((call) => call[1] === "rm") ? missing() : ok(JSON.stringify(actual));
      return ok();
    });
    expect(stopped).toBe(true);
    expect(calls[0]?.at(-1)).toBe(intended.name);
    expect(calls.find((call) => call[1] === "stop")?.at(-1)).toBe(containerID);
    expect(await Bun.file(file).exists()).toBe(false);
    expect(
      await Bun.file(resolve(directory, "server-runtime", startupID, "environment")).exists(),
    ).toBe(false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Stop rejects changed labels, image or identity and preserves unrelated retained files", async () => {
  for (const changed of [
    { labels: { "factory.dev/server-owner": "foreign", "factory.dev/server-startup": startupID } },
    { image: `sha256:${"c".repeat(64)}` },
    { name: "/other-server" },
  ]) {
    const { directory, actual } = await fixture();
    try {
      const retained = resolve(directory, "auth-secret");
      await writeFile(retained, "retained-value");
      const calls: string[][] = [];
      await expect(
        stopFactoryServerContainer(directory, async (args) => {
          calls.push([...args]);
          return ok(JSON.stringify({ ...actual, ...changed }));
        }),
      ).rejects.toThrow("different ownership");
      expect(calls).toHaveLength(1);
      expect(await readFile(retained, "utf8")).toBe("retained-value");
      expect(await retainedFactoryServerContainer(directory)).not.toBeNull();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
});

test("unavailable Docker observation never becomes confirmed absence or permission to remove", async () => {
  const { directory } = await fixture();
  try {
    await expect(
      stopFactoryServerContainer(directory, async () => ({
        exitCode: 1,
        stdout: "",
        stderr: "Cannot connect to Docker",
      })),
    ).rejects.toThrow("observation is unavailable");
    expect(await retainedFactoryServerContainer(directory)).not.toBeNull();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Stop does not adopt a replacement container under an already confirmed name", async () => {
  const { directory, prepared, actual } = await fixture();
  try {
    await prepared.confirm();
    const calls: string[][] = [];
    await expect(
      stopFactoryServerContainer(directory, async (args) => {
        calls.push([...args]);
        return ok(JSON.stringify({ ...actual, id: "c".repeat(64) }));
      }),
    ).rejects.toThrow("different ownership");
    expect(calls).toHaveLength(1);
    expect((await retainedFactoryServerContainer(directory))?.containerID).toBe(containerID);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("an exactly recorded absent server cleans only its own private startup state", async () => {
  const { directory } = await fixture();
  try {
    const retained = resolve(directory, "auth-secret");
    await writeFile(retained, "retained-value");
    expect(await stopFactoryServerContainer(directory, async () => missing())).toBe(true);
    expect(await readFile(retained, "utf8")).toBe("retained-value");
    expect(await stopFactoryServerContainer(directory, async () => missing())).toBe(false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("failed preparation removes private credentials before any external create is admitted", async () => {
  const directory = await mkdtemp(resolve(tmpdir(), "factory-server-container-"));
  try {
    await expect(
      prepareFactoryServerContainer(
        {
          stateDirectory: directory,
          sharedStateDirectory: directory,
          image,
          startupID,
          environment: {
            FACTORY_RUNTIME_HOST: "192.168.139.2",
            FACTORY_MODEL_API_KEY: "private-value\ninvalid-second-line",
          },
        },
        async () => ok("private-kubeconfig"),
      ),
    ).rejects.toThrow("must be a single line");
    expect(await retainedFactoryServerContainer(directory)).toBeNull();
    expect(
      await Bun.file(resolve(directory, "server-runtime", startupID, "kubeconfig")).exists(),
    ).toBe(false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
