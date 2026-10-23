import { expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { chromium, expect as browserExpect } from "@playwright/test";
import type { ServerWebSocket } from "bun";

// Real pinned Theia and xterm, with owned Linux PTYs. Source/authority responses
// are controlled; this tests terminal UI, not Envbox admission or Connector routing.
const enabled = process.env["FACTORY_TERMINAL_UI_PROOF"] === "1";
type Socket =
  | { kind: "theia"; target: WebSocket; pending: Array<string | Buffer> }
  | { kind: "terminal"; id: string };

test.skipIf(!enabled)(
  "Terminal keeps focus, tab semantics, fitting and live stdin",
  async () => {
    const owner = crypto.randomUUID();
    const name = `factory-terminal-ui-${owner}`;
    const workspace = crypto.randomUUID();
    const attempt = crypto.randomUUID();
    const artifacts = `.factory/test-results/chat-terminal-polish/terminal-${owner}`;
    await mkdir(artifacts, { recursive: true });
    async function docker(...args: string[]) {
      const child = Bun.spawn(["docker", ...args], { stdout: "pipe", stderr: "pipe" });
      const [output, error, code] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      if (code) throw new Error(`Owned terminal fixture ${args[0]} failed: ${error}`);
      return output.trim();
    }
    const image = await docker(
      "image",
      "inspect",
      process.env["FACTORY_EDITOR_PROOF_IMAGE"] ?? "factory-editor:chat-terminal-proof",
      "--format",
      "{{.Id}}",
    );
    const sessions = new Map<
      string,
      {
        child: Bun.Subprocess<"pipe", "pipe", "ignore">;
        peers: Set<ServerWebSocket<Socket>>;
        output: string;
        ready: boolean;
      }
    >();
    let proxy: ReturnType<typeof Bun.serve<Socket>> | undefined;
    let created = false;
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await writeFile(
      `${artifacts}/intent.json`,
      JSON.stringify({ owner, name, image, workspace, attempt }),
    );
    try {
      await docker(
        "run",
        "--detach",
        "--name",
        name,
        "--label",
        `factory.terminal-ui-proof=${owner}`,
        "--tmpfs",
        "/tmp",
        "--tmpfs",
        "/home/node:uid=1000,gid=1000",
        "--publish",
        "127.0.0.1::4400",
        image,
      );
      created = true;
      const origin = `http://${await docker("port", name, "4400/tcp")}`;
      await browserExpect
        .poll(
          async () => {
            try {
              return (await fetch(origin)).ok;
            } catch {
              return false;
            }
          },
          { timeout: 30_000 },
        )
        .toBe(true);
      proxy = Bun.serve<Socket>({
        hostname: "127.0.0.1",
        port: 0,
        idleTimeout: 0,
        async fetch(request, server) {
          const url = new URL(request.url);
          const path = url.pathname;
          if (path === "/_proof")
            return new Response(
              `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body style="margin:0"><iframe title="Factory IDE" style="position:fixed;inset:0;width:100%;height:100%;border:0" src="/?workspace=${workspace}"></iframe></body></html>`,
              { headers: { "content-type": "text/html" } },
            );
          if (path === `/__factory/workspaces/${workspace}/writer`)
            return Response.json({ state: "human", yours: true, canWrite: true, epoch: 1 });
          if (path.endsWith("/writer/activity")) return new Response(null, { status: 204 });
          if (path === `/__factory/workspaces/${workspace}/runtime`)
            return Response.json({
              workspaceID: workspace,
              attemptID: attempt,
              state: "ready",
              failure: null,
            });
          if (path.endsWith("/source/context"))
            return Response.json({ workspaceID: workspace, label: "Terminal UI proof" });
          if (path.endsWith("/source/stat"))
            return Response.json({ kind: "directory", size: 0, mtime: 1, ctime: 1 });
          if (path.endsWith("/source/list")) return Response.json([]);
          if (path.endsWith("/processes")) return Response.json({ processes: [] });
          if (path.endsWith("/events"))
            return new Response(
              new ReadableStream({
                start(controller) {
                  controller.enqueue(new TextEncoder().encode(": owned fixture\n\n"));
                  request.signal.addEventListener(
                    "abort",
                    () => {
                      try {
                        controller.close();
                      } catch {}
                    },
                    { once: true },
                  );
                },
              }),
              { headers: { "content-type": "text/event-stream" } },
            );
          const closing = path.match(/\/terminals\/([a-zA-Z0-9_-]+)$/);
          const closingID = closing?.[1];
          if (closingID && request.method === "DELETE") {
            const session = sessions.get(closingID);
            session?.child.kill();
            for (const peer of session?.peers ?? []) peer.close(1000);
            sessions.delete(closingID);
            // Exercise socket-close arriving before the DELETE response.
            await Bun.sleep(100);
            return new Response(null, { status: 204 });
          }
          if (request.headers.get("upgrade") === "websocket") {
            const terminal = path.match(/\/terminal\/([a-zA-Z0-9_-]+)$/);
            const terminalID = terminal?.[1];
            if (terminalID) {
              if (server.upgrade(request, { data: { kind: "terminal", id: terminalID } })) return;
            } else {
              const target = new WebSocket(`${origin.replace("http:", "ws:")}${path}${url.search}`);
              if (server.upgrade(request, { data: { kind: "theia", target, pending: [] } })) return;
              target.close();
            }
            return new Response(null, { status: 400 });
          }
          const headers = new Headers(request.headers);
          headers.set("accept-encoding", "identity");
          const upstream = await fetch(`${origin}${path}${url.search}`, {
            method: request.method,
            headers,
            body: request.body,
          });
          const responseHeaders = new Headers(upstream.headers);
          responseHeaders.delete("content-length");
          responseHeaders.delete("content-encoding");
          return new Response(upstream.body, { status: upstream.status, headers: responseHeaders });
        },
        websocket: {
          open(socket) {
            const data = socket.data;
            if (data.kind === "theia") {
              data.target.binaryType = "arraybuffer";
              data.target.onopen = () => {
                for (const value of data.pending.splice(0))
                  data.target.send(typeof value === "string" ? value : new Uint8Array(value));
              };
              data.target.onmessage = (event) => socket.send(event.data);
              data.target.onclose = () => socket.close();
              data.target.onerror = () => socket.close();
              return;
            }
            let session = sessions.get(data.id);
            if (!session) {
              const child = Bun.spawn(
                [
                  "docker",
                  "exec",
                  "-i",
                  name,
                  "script",
                  "--quiet",
                  "--command",
                  "env TERM=xterm-256color PS1='proof$ ' bash --noprofile --norc",
                  "/dev/null",
                ],
                { stdin: "pipe", stdout: "pipe", stderr: "ignore" },
              );
              session = { child, peers: new Set(), output: "", ready: false };
              sessions.set(data.id, session);
              const current = session;
              void (async () => {
                for await (const bytes of child.stdout) {
                  current.output = (current.output + new TextDecoder().decode(bytes)).slice(
                    -64_000,
                  );
                  if (!current.ready && current.output.includes("proof$ ")) {
                    current.ready = true;
                    for (const peer of current.peers) peer.send('{"type":"terminal-ready"}');
                  }
                  for (const peer of current.peers) peer.send(bytes);
                }
              })();
            }
            session.peers.add(socket);
            if (session.ready) socket.send('{"type":"terminal-ready"}');
            if (session.output) socket.send(session.output);
          },
          message(socket, message) {
            const data = socket.data;
            if (data.kind === "theia") {
              if (data.target.readyState === WebSocket.OPEN) data.target.send(message);
              else if (data.target.readyState === WebSocket.CONNECTING) data.pending.push(message);
            } else if (typeof message !== "string")
              sessions.get(data.id)?.child.stdin.write(message);
          },
          close(socket) {
            if (socket.data.kind === "theia") socket.data.target.close();
            else sessions.get(socket.data.id)?.peers.delete(socket);
          },
        },
      });
      await page.goto(`${proxy.url}_proof`);
      const ide = page.frameLocator("iframe");
      await ide.locator(".lm-TabBar-tab").filter({ hasText: "Terminal" }).click();
      const terminal = ide.locator(".factory-terminal-widget");
      const active = terminal.locator(".factory-terminal-host:not([hidden])");
      await browserExpect(active).toHaveAttribute("data-connection-state", "connected");
      await active.locator(".xterm").click();
      await page.keyboard.type("printf 'native-%s\\n' proof");
      await page.keyboard.press("Enter");
      await browserExpect(active.locator(".xterm-rows")).toContainText("native-proof");
      await page.screenshot({ path: `${artifacts}/terminal-wide.png` });
      const colors = await active.evaluate((node) => {
        const xterm = node.querySelector(".xterm");
        const viewport = node.querySelector(".xterm-viewport");
        if (!xterm || !viewport) throw new Error("Terminal canvas is missing");
        return {
          padding: getComputedStyle(xterm).backgroundColor,
          viewport: getComputedStyle(viewport).backgroundColor,
        };
      });
      expect(colors.padding).toBe(colors.viewport);
      expect(colors.viewport).toBe("rgb(245, 246, 242)");
      await terminal.getByRole("button", { name: "New terminal" }).click();
      await browserExpect(terminal.locator(".factory-terminal-tab")).toHaveCount(2);
      await browserExpect(active.locator(".xterm-helper-textarea")).toBeFocused();
      await browserExpect(active).toHaveAttribute("data-connection-state", "connected");
      await page.keyboard.type("printf 'second-%s\\n' terminal");
      await page.keyboard.press("Enter");
      await browserExpect(active.locator(".xterm-rows")).toContainText("second-terminal");
      const tabs = terminal.getByRole("tab");
      await tabs.first().focus();
      await page.keyboard.press("ArrowRight");
      await browserExpect(tabs.nth(1)).toHaveAttribute("aria-selected", "true");
      await browserExpect(tabs.nth(1)).toBeFocused();
      await page.keyboard.press("F2");
      await terminal.getByRole("textbox", { name: "Terminal name" }).fill("Build output");
      await page.keyboard.press("Enter");
      await browserExpect(
        terminal.getByRole("tab", { name: "Build output", exact: true }),
      ).toBeFocused();
      await page.reload();
      await ide.locator(".lm-TabBar-tab").filter({ hasText: "Terminal" }).click();
      await browserExpect(
        terminal.getByRole("tab", { name: "Build output", exact: true }),
      ).toHaveAttribute("aria-selected", "true");
      await browserExpect(active).toHaveAttribute("data-connection-state", "connected");
      await active.locator(".xterm").click();
      await terminal.getByRole("button", { name: "Close Terminal 1", exact: true }).click();
      await browserExpect(active.locator(".xterm-helper-textarea")).toBeFocused();
      await page.keyboard.type("printf 'retained-%s\\n' stdin");
      await page.keyboard.press("Enter");
      await browserExpect(active.locator(".xterm-rows")).toContainText("retained-stdin");
      await terminal.screenshot({ path: `${artifacts}/terminal-panel-wide.png` });
      for (const width of [700, 390]) {
        await page.setViewportSize({ width, height: 800 });
        await browserExpect
          .poll(() => terminal.evaluate((node) => node.scrollWidth - node.clientWidth))
          .toBeLessThanOrEqual(1);
        await browserExpect
          .poll(() =>
            active.evaluate((node) => {
              const screen = node.querySelector(".xterm-screen");
              if (!screen) return false;
              const bounds = screen.getBoundingClientRect();
              const host = node.getBoundingClientRect();
              return bounds.right <= host.right + 1 && bounds.bottom <= host.bottom + 1;
            }),
          )
          .toBe(true);
        await browserExpect(active.locator(".xterm-rows")).toContainText("retained-stdin");
        await page.screenshot({ path: `${artifacts}/terminal-${width}.png` });
      }
      await page.reload();
      await ide.locator(".lm-TabBar-tab").filter({ hasText: "Terminal" }).click();
      await browserExpect(
        terminal.getByRole("tab", { name: "Build output", exact: true }),
      ).toBeVisible();
      await browserExpect(active).toHaveAttribute("data-connection-state", "connected");
      await active.locator(".xterm").click();
      await page.keyboard.type("printf 'reload-%s\\n' retained");
      await page.keyboard.press("Enter");
      await browserExpect(active.locator(".xterm-rows")).toContainText("reload-retained");
      await terminal.getByRole("button", { name: "Close Build output", exact: true }).click();
      await browserExpect(terminal.getByRole("button", { name: "New terminal" })).toBeFocused();
      await page.reload();
      await ide.locator(".lm-TabBar-tab").filter({ hasText: "Terminal" }).click();
      await browserExpect(terminal.getByRole("tab")).toHaveCount(0);
      await browserExpect(terminal.getByRole("status")).toContainText("No open terminals.");
      await terminal.getByRole("button", { name: "New terminal" }).click();
      await browserExpect(active).toHaveAttribute("data-connection-state", "connected");
      expect(errors).toEqual([]);
      await writeFile(
        `${artifacts}/result.json`,
        JSON.stringify({ result: "passed", image, nativePTYs: sessions.size }),
      );
    } catch (cause) {
      await page.screenshot({ path: `${artifacts}/failure.png` }).catch(() => {});
      throw cause;
    } finally {
      await browser.close();
      for (const session of sessions.values()) {
        session.child.kill();
        await session.child.exited;
      }
      await proxy?.stop(true);
      if (created) {
        expect(
          await docker(
            "inspect",
            "--format",
            '{{index .Config.Labels "factory.terminal-ui-proof"}}',
            name,
          ),
        ).toBe(owner);
        await docker("rm", "--force", name);
      }
    }
  },
  120_000,
);
