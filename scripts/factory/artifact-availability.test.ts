import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { inspectRegistryArtifact, requireAvailableRuntimeArtifacts } from "./artifact-availability";
import { runtimeArtifactNames } from "./artifacts";

const body = JSON.stringify({
  schemaVersion: 2,
  mediaType: "application/vnd.oci.image.manifest.v1+json",
  config: {
    mediaType: "application/vnd.oci.image.config.v1+json",
    digest: `sha256:${"a".repeat(64)}`,
    size: 2,
  },
  layers: [],
});
const digest = `sha256:${createHash("sha256").update(body).digest("hex")}`;
const reference = `registry.example/open-factory/browser-tools@${digest}`;

test("artifact readiness reads the remote exact manifest instead of trusting a pin file or warming the image cache", async () => {
  const requests: Array<{ method: string; path: string; accept: string | null }> = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      requests.push({
        method: request.method,
        path: new URL(request.url).pathname,
        accept: request.headers.get("accept"),
      });
      return new Response(body, {
        headers: { "content-type": "application/vnd.oci.image.manifest.v1+json" },
      });
    },
  });
  try {
    await inspectRegistryArtifact({ name: "browser-tools", reference, origin: server.url.origin });
    expect(requests).toEqual([
      {
        method: "GET",
        path: `/v2/open-factory/browser-tools/manifests/${digest}`,
        accept: expect.stringContaining("application/vnd.oci.image.manifest.v1+json"),
      },
    ]);
  } finally {
    await server.stop(true);
  }
});

test("a pinned reference with a publication tag still checks the repository's exact digest", async () => {
  const paths: string[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      paths.push(new URL(request.url).pathname);
      return new Response(body);
    },
  });
  try {
    await inspectRegistryArtifact({
      name: "browser-tools",
      reference: reference.replace("@", ":publication@"),
      origin: server.url.origin,
    });
    expect(paths).toEqual([`/v2/open-factory/browser-tools/manifests/${digest}`]);
  } finally {
    await server.stop(true);
  }
});

test.each([404, 401, 503])(
  "HTTP %s rejects unavailable artifacts without exposing Registry response bodies",
  async (status) => {
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () => new Response("secret-sentinel", { status }),
    });
    try {
      await expect(
        inspectRegistryArtifact({
          name: "browser-tools",
          reference,
          origin: server.url.origin,
        }),
      ).rejects.toThrow(`browser-tools artifact is unavailable (Registry HTTP ${status})`);
      try {
        await inspectRegistryArtifact({
          name: "browser-tools",
          reference,
          origin: server.url.origin,
        });
      } catch (cause) {
        expect(String(cause)).not.toContain("secret-sentinel");
      }
    } finally {
      await server.stop(true);
    }
  },
);

test("a successful HTTP response with different content is not the approved immutable artifact", async () => {
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => new Response(JSON.stringify({ ...JSON.parse(body), layers: ["different"] })),
  });
  try {
    await expect(
      inspectRegistryArtifact({
        name: "browser-tools",
        reference,
        origin: server.url.origin,
      }),
    ).rejects.toThrow("manifest digest differs");
  } finally {
    await server.stop(true);
  }
});

test("an unavailable Registry fails within the observation window without retrying", async () => {
  let reads = 0;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch() {
      reads++;
      await Bun.sleep(300);
      return new Response(null);
    },
  });
  const start = performance.now();
  try {
    await expect(
      inspectRegistryArtifact({
        name: "browser-tools",
        reference,
        origin: server.url.origin,
        timeoutMS: 100,
      }),
    ).rejects.toThrow("Registry request failed");
    expect(performance.now() - start).toBeLessThan(500);
    expect(reads).toBe(1);
  } finally {
    await server.stop(true);
  }
});

test("startup observes all six role manifests, and a missing role stops the check without retrying", async () => {
  const references = Object.fromEntries(
    runtimeArtifactNames.map((name) => [name, `registry.invalid/open-factory/${name}@${digest}`]),
  );
  const calls: string[][] = [];
  const inspect = async (args: string[]) => {
    calls.push(args);
    return { text: body, code: 0 };
  };
  await requireAvailableRuntimeArtifacts(references, inspect);
  expect(calls).toEqual(
    Object.values(references).map((reference) => [
      "docker",
      "buildx",
      "imagetools",
      "inspect",
      "--raw",
      reference,
    ]),
  );
  calls.length = 0;
  await expect(
    requireAvailableRuntimeArtifacts(references, async (args) => {
      const result = await inspect(args);
      return { ...result, code: args.at(-1)?.includes("/browser-tools@") ? 1 : 0 };
    }),
  ).rejects.toThrow("browser-tools artifact manifest could not be read");
  const failedIndex = Object.keys(references).indexOf("browser-tools");
  expect(calls.map((args) => args.at(-1))).toEqual(
    Object.values(references).slice(0, failedIndex + 1),
  );
});

test("an invalid remote manifest is refused without including provider output in the error", async () => {
  const references = Object.fromEntries(
    runtimeArtifactNames.map((name) => [name, `registry.invalid/open-factory/${name}@${digest}`]),
  );
  await expect(
    requireAvailableRuntimeArtifacts(references, async () => ({
      text: "secret-sentinel",
      code: 0,
    })),
  ).rejects.toThrow("runtime-host artifact returned an invalid image manifest");
});
