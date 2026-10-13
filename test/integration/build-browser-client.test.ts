import { expect, test } from "bun:test";
import { mkdtemp, realpath, rmdir, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { ensureOpenCodeMessageBoundary } from "../../apps/factory/src/agent/opencode-client";
import { buildModelID } from "../fixtures/change-agent-turns";
import { observe, pinnedOpenCode } from "../fixtures/pinned-opencode";

const jpeg =
  "/9j/2wCEAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDIBCQkJDAsMGA0NGDIhHCEyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMv/AABEIAAEAAQMBIgACEQEDEQH/xAGiAAABBQEBAQEBAQAAAAAAAAAAAQIDBAUGBwgJCgsQAAIBAwMCBAMFBQQEAAABfQECAwAEEQUSITFBBhNRYQcicRQygZGhCCNCscEVUtHwJDNicoIJChYXGBkaJSYnKCkqNDU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6g4SFhoeIiYqSk5SVlpeYmZqio6Slpqeoqaqys7S1tre4ubrCw8TFxsfIycrS09TV1tfY2drh4uPk5ebn6Onq8fLz9PX29/j5+gEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoLEQACAQIEBAMEBwUEBAABAncAAQIDEQQFITEGEkFRB2FxEyIygQgUQpGhscEJIzNS8BVictEKFiQ04SXxFxgZGiYnKCkqNTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqCg4SFhoeIiYqSk5SVlpeYmZqio6Slpqeoqaqys7S1tre4ubrCw8TFxsfIycrS09TV1tfY2dri4+Tl5ufo6ery8/T19vf4+fr/2gAMAwEAAhEDEQA/APn+iiigD//Z";

test("pinned OpenCode API 2 sees a fixed browser CLI screenshot through its actual image read tool", async () => {
  const directory = await realpath(
    await mkdtemp(resolve(tmpdir(), "factory-browser-client-proof-")),
  );
  const path = resolve(directory, "connector");
  const inspectArchitecture = Bun.spawn(["docker", "info", "--format", "{{.Architecture}}"], {
    stdout: "pipe",
    stderr: "ignore",
  });
  const architecture = (await new Response(inspectArchitecture.stdout).text()).trim();
  const goArchitecture = { aarch64: "arm64", arm64: "arm64", x86_64: "amd64", amd64: "amd64" }[
    architecture
  ];
  if ((await inspectArchitecture.exited) !== 0 || !goArchitecture) {
    await rmdir(directory);
    throw new Error("Owned browser proof needs a supported Docker architecture");
  }
  const compile = Bun.spawn(["go", "build", "-o", path, "./cmd/factory-runtime-connector"], {
    cwd: resolve("services/runtime-connector"),
    env: { ...process.env, GOOS: "linux", GOARCH: goArchitecture },
    stdout: "ignore",
    stderr: "pipe",
  });
  const turnID = crypto.randomUUID();
  let upstream: Awaited<ReturnType<typeof pinnedOpenCode>> | undefined;
  const calls: string[] = [];
  const server = Bun.serve({
    hostname: "0.0.0.0",
    port: 0,
    async fetch(request) {
      expect(new URL(request.url).pathname).toBe(`/fixed/${turnID}`);
      expect(request.headers.get("authorization")).toBe("Bearer owned-client-fixture-capability");
      const rpc = (await request.json()) as {
        id: string;
        method: string;
        params: { name: string };
      };
      expect(rpc.method).toBe("tools/call");
      expect(rpc.params.name).toBe("browser_screenshot");
      calls.push(rpc.id);
      if (!upstream) throw new Error("Owned screenshot process is unavailable");
      await upstream.installBrowserScreenshot(turnID, jpeg);
      return Response.json({
        jsonrpc: "2.0",
        id: rpc.id,
        result: {
          content: [{ type: "image", mimeType: "image/jpeg", data: jpeg }],
          structuredContent: {
            sessionId: turnID,
            turnId: turnID,
            runtimeAttemptId: crypto.randomUUID(),
            generation: 1,
            app: "app",
            headCommit: "a".repeat(40),
            workingTreeModified: false,
            observedAt: new Date().toISOString(),
          },
        },
      });
    },
  });
  try {
    const error = await new Response(compile.stderr).text();
    if ((await compile.exited) !== 0)
      throw new Error(`Owned connector compilation failed: ${error}`);
    const inspect = Bun.spawn(
      [
        "docker",
        "image",
        "inspect",
        "--format",
        "{{.Id}}",
        "registry.localhost:5443/open-factory/runtime-host:local",
      ],
      { stdout: "pipe", stderr: "ignore" },
    );
    const image = (await new Response(inspect.stdout).text()).trim();
    if ((await inspect.exited) !== 0) throw new Error("Pinned process image is unavailable");
    upstream = await pinnedOpenCode(image, {
      path,
      turnID,
      endpoint: `http://host.orb.internal:${server.port}/fixed`,
      token: "owned-client-fixture-capability",
    });
    const target = upstream;
    await observe(
      () => target.client.model.list({ location: { directory: "/workspace/project" } }),
      (models) =>
        models.data.some((model) => model.providerID === "factory" && model.id === buildModelID),
    );
    const sessionID = `ses_owned_browser_${turnID.replaceAll("-", "")}`;
    await target.client.session.create({
      id: sessionID,
      title: "Owned browser image read",
      location: { directory: "/workspace/project" },
      model: { providerID: "factory", id: buildModelID },
      permissions: [{ action: "*", resource: "*", effect: "allow" }],
    });
    await ensureOpenCodeMessageBoundary(target.client, sessionID);
    await target.control("/release", "POST");
    await target.client.session.prompt({
      sessionID,
      id: `msg_browser_${turnID.replaceAll("-", "")}`,
      text: "Capture the fixed browser screenshot, read its JPEG and then finish.",
      delivery: "queue",
      resume: true,
    });
    const state = await observe(
      () => target.control(),
      (state) => state.providerRequests >= 3,
      "Native shell/image-read tool cycle did not complete",
    );
    expect(state.imageRequests).toBe(1);
    expect(calls).toHaveLength(1);
    expect(new Set(calls).size).toBe(1);
  } finally {
    await upstream?.dispose();
    await server.stop(true);
    await unlink(path).catch(() => {});
    await rmdir(directory);
  }
}, 45_000);
