import { expect, test } from "bun:test";
import { mkdtemp, realpath, rmdir, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { ensureOpenCodeMessageBoundary } from "../../apps/factory/src/agent/opencode-client";
import { projectMessages } from "../../apps/factory/src/agent/controller";
import { buildModelID } from "../fixtures/change-agent-turns";
import { observe, pinnedOpenCode } from "../fixtures/pinned-opencode";
import { ownedBrowserJPEG as jpeg } from "../fixtures/browser-image";

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
  let sessionID = "";
  try {
    const error = await new Response(compile.stderr).text();
    if ((await compile.exited) !== 0)
      throw new Error(`Owned connector compilation failed: ${error}`);
    upstream = await pinnedOpenCode(undefined, {
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
    sessionID = `ses_owned_browser_${turnID.replaceAll("-", "")}`;
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
    if (state.imageRequests !== 1)
      console.error(
        "Owned native browser diagnostic",
        JSON.stringify({
          browserRequests: calls.length,
          messages: projectMessages(await target.client.message.list({ sessionID, limit: 20 })),
        }),
      );
    expect(state.imageRequests).toBe(1);
    expect(calls).toHaveLength(1);
    expect(new Set(calls).size).toBe(1);
  } catch (cause) {
    if (upstream)
      console.error("Owned retained browser diagnostic", {
        calls: calls.length,
        control: await upstream.control(),
        messages: sessionID
          ? projectMessages(await upstream.client.message.list({ sessionID, limit: 20 }))
          : [],
        ...(await upstream.diagnostics()),
      });
    throw cause;
  } finally {
    await upstream?.dispose();
    await server.stop(true);
    await unlink(path).catch(() => {});
    await rmdir(directory);
  }
}, 180_000);
