import { expect, test } from "bun:test";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium, expect as browserExpect, type Page } from "@playwright/test";
import { languageToolsFixture } from "../fixtures/language-tools";
import { fixtureValue } from "../fixtures/value";

const enabled = process.env["FACTORY_RUN_INDEPENDENT_EDITOR_PROOF"] === "1";
const root = resolve(import.meta.dir, "../..");
const nodeImage =
  "docker.io/library/node:24.21.0-alpine3.23@sha256:9ec4a2e289874ed0d722e1772ec2de45d2801541db8612f3638b26f128c69ac2";
const fixtureSecrets = new Set<string>();

function redacted(value: string): string {
  let result = value.replace(/Bearer\s+\S+/g, "Bearer <REDACTED>");
  for (const token of fixtureSecrets) result = result.replaceAll(token, "<REDACTED>");
  return result;
}

async function docker(...args: string[]): Promise<string> {
  const result = Bun.spawn(["docker", ...args], { cwd: root, stdout: "pipe", stderr: "pipe" });
  const [output, failure, status] = await Promise.all([
    new Response(result.stdout).text(),
    new Response(result.stderr).text(),
    result.exited,
  ]);
  if (status !== 0) throw new Error(`Docker ${args[0]} failed: ${redacted(failure)}`);
  return output.trim();
}

async function waitReady(url: string): Promise<void> {
  const deadline = performance.now() + 30_000;
  while (performance.now() < deadline) {
    try {
      if ((await fetch(url)).ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Independent editor did not become ready");
}

async function editorLogs(name: string) {
  const child = Bun.spawn(["docker", "logs", "--tail", "120", name], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [output, diagnostic] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return redacted(`${output}\n${diagnostic}`);
}

interface SourceFixture {
  readonly workspaceID: string;
  readonly serviceID: string;
  readonly token: string;
  readonly volume: string;
  readonly container: string;
  readonly origin: string;
}

interface ProxySocket {
  readonly target: WebSocket;
  readonly pending: Array<string | Buffer>;
  bytes: number;
}

async function cleanOwnedFixtures(
  proofID: string,
  containers: readonly string[],
  volumes: readonly string[],
  artifacts: string,
  priorFailure: boolean,
): Promise<void> {
  const removedContainers: string[] = [];
  const removedVolumes: string[] = [];
  try {
    for (const container of [...containers].reverse()) {
      const present = await docker(
        "container",
        "ls",
        "--all",
        "--filter",
        `name=^/${container}$`,
        "--format",
        "{{.Names}}",
      );
      if (!present) continue;
      if (present !== container) throw new Error("Unexpected fixture container identity");
      const owner = await docker(
        "inspect",
        container,
        "--format",
        '{{index .Config.Labels "factory.dev.independent-editor-proof"}}',
      );
      if (owner !== proofID) throw new Error("Refusing unowned fixture container cleanup");
      await docker("rm", "--force", "--volumes", container);
      removedContainers.push(container);
    }
    for (const volume of volumes) {
      const present = await docker(
        "volume",
        "ls",
        "--filter",
        `name=^${volume}$`,
        "--format",
        "{{.Name}}",
      );
      if (!present) continue;
      if (present !== volume) throw new Error("Unexpected fixture volume identity");
      const owner = await docker(
        "volume",
        "inspect",
        volume,
        "--format",
        '{{index .Labels "factory.dev.independent-editor-proof"}}',
      );
      if (owner !== proofID) throw new Error("Refusing unowned fixture volume cleanup");
      await docker("volume", "rm", volume);
      removedVolumes.push(volume);
    }
    await writeFile(
      resolve(artifacts, "cleanup.json"),
      JSON.stringify({
        proofID,
        removedOwnedContainers: removedContainers,
        removedOwnedVolumes: removedVolumes,
      }),
    );
  } catch (error) {
    await writeFile(
      resolve(artifacts, "cleanup-failed.json"),
      JSON.stringify({
        proofID,
        removedContainers,
        removedVolumes,
        error: redacted(String(error)),
      }),
    );
    if (!priorFailure) throw error;
    console.error(`Owned fixture cleanup failed: ${redacted(String(error))}`);
  }
}

test.skipIf(!enabled)(
  "real independent Theia opens and saves canonical source without execution",
  async () => {
    const proofID = randomUUID();
    const workspaceA = randomUUID();
    const workspaceB = randomUUID();
    const label = `factory.dev.independent-editor-proof=${proofID}`;
    const artifacts = resolve(root, ".factory/test-results/independent-editor", proofID);
    await mkdir(artifacts, { recursive: true });
    const sourceImage = await docker(
      "image",
      "inspect",
      process.env["FACTORY_SOURCE_PROOF_IMAGE"] ?? "factory-slice17-workspace-files:proof",
      "--format",
      "{{.Id}}",
    );
    const editorImage = await docker(
      "image",
      "inspect",
      process.env["FACTORY_EDITOR_PROOF_IMAGE"] ?? "factory-slice17-developer-ide:proof",
      "--format",
      "{{.Id}}",
    );
    const volumes: string[] = [];
    const containers: string[] = [];
    const editorName = `factory-ide-proof-${proofID}`;
    // The names and exact immutable image identities are recorded before creates.
    await writeFile(
      resolve(artifacts, "intent.json"),
      JSON.stringify({ proofID, sourceImage, editorImage, editorName, workspaceA, workspaceB }),
    );
    const sources = new Map<string, SourceFixture>();
    let tools: Awaited<ReturnType<typeof languageToolsFixture>> | undefined;
    let proxy: ReturnType<typeof Bun.serve<ProxySocket>> | undefined;
    let capturedPage: Page | undefined;
    const browserErrors: string[] = [];
    const editingSignals: { workspaceID: string; kind: string }[] = [];
    const sourceRequests: Array<{ workspaceID: string; operation: string; status: number }> = [];
    const browser = await chromium.launch({ headless: true });
    let failed = false;
    const shutdown = new AbortController();
    try {
      for (const [index, workspaceID] of [workspaceA, workspaceB].entries()) {
        const fixtureName = index === 0 ? "workspace-a" : "workspace-b";
        const token = randomBytes(32).toString("hex");
        fixtureSecrets.add(token);
        const serviceID = `source-${index}`;
        const volume = `factory-source-proof-${proofID}-${index}`;
        const container = `factory-source-proof-${proofID}-${index}`;
        const initializer = `factory-source-init-${proofID}-${index}`;
        await writeFile(
          resolve(artifacts, `source-${index}-intent.json`),
          JSON.stringify({ workspaceID, serviceID, volume, container, initializer, sourceImage }),
        );
        volumes.push(volume);
        await docker("volume", "create", "--label", label, volume);
        const authored = `export const workspace = '${fixtureName}';\n`;
        const files = [
          ["app.ts", authored],
          ["unopened.txt", `canonical search fixture ${fixtureName}`],
          ["view.tsx", 'export const View = () => <button title="Save">Save</button>;\n'],
          ["web.css", ".button { color: red; }\n"],
          ["index.html", '<!doctype html><button title="Save">Save</button>\n'],
          ["package.json", '{"private":true}\n'],
          ["tsconfig.json", '// project compiler options\n{"compilerOptions":{"strict":true}}\n'],
          [
            "language.ts",
            'import { payment } from "fixture-dep";\nconst total: string = payment.amount;\npayment.\n',
          ],
          [
            "language.py",
            "from fixture_amount import amount\nwrong: str = amount()\nvalue = amount()\nvalue.\n",
          ],
        ];
        const initialize = `const fs=require('fs');fs.mkdirSync('/data/source',{mode:0o755});fs.mkdirSync('/data/control',{mode:0o755});fs.chownSync('/data/source',101000,101000);for(const [name,content] of ${JSON.stringify(files)}){fs.writeFileSync('/data/source/'+name,content);fs.chownSync('/data/source/'+name,101000,101000)}fs.writeFileSync('/data/control/access.json',JSON.stringify(${JSON.stringify({ workspaceId: workspaceID, serviceId: serviceID, epoch: 1, token })}),{mode:0o444});`;
        containers.push(initializer);
        await docker(
          "run",
          "--rm",
          "--name",
          initializer,
          "--label",
          label,
          "--mount",
          `type=volume,source=${volume},target=/data`,
          nodeImage,
          "node",
          "-e",
          initialize,
        );
        containers.push(container);
        await docker(
          "run",
          "--detach",
          "--name",
          container,
          "--label",
          label,
          "--read-only",
          "--cap-drop",
          "ALL",
          "--security-opt",
          "no-new-privileges",
          "--publish",
          "127.0.0.1::4600",
          "--mount",
          `type=volume,source=${volume},target=/source,volume-subpath=source`,
          "--mount",
          `type=volume,source=${volume},target=/control,volume-subpath=control,readonly`,
          sourceImage,
          "--root",
          "/source",
          "--assignment",
          "/control/access.json",
          "--listen",
          "0.0.0.0:4600",
        );
        const address = await docker("port", container, "4600/tcp");
        sources.set(workspaceID, {
          workspaceID,
          serviceID,
          token,
          volume,
          container,
          origin: `http://${address}`,
        });
        const listSource = () =>
          fetch(`http://${address}/v1/workspaces/${workspaceID}/list`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${token}`,
              "X-Factory-Source-Service": serviceID,
              "X-Factory-Source-Epoch": "1",
            },
            body: JSON.stringify({ path: "" }),
          });
        await browserExpect
          .poll(
            async () => {
              try {
                const response = await listSource();
                await response.arrayBuffer();
                return response.status;
              } catch {
                return 0;
              }
            },
            { timeout: 5000, intervals: [100] },
          )
          .toBe(200);
        const listing = await listSource();
        expect(listing.status).toBe(200);
        const listed = await listing.json();
        expect(listed).toHaveLength(files.length);
        expect(listed).toEqual(
          expect.arrayContaining(
            files.map(([name]) => expect.objectContaining({ name, kind: "file" })),
          ),
        );
        expect(await docker("inspect", container, "--format", "{{.Config.User}}")).toBe(
          "101000:101000",
        );
      }
      if (process.env["FACTORY_LANGUAGE_PROOF_IMAGE"])
        tools = await languageToolsFixture({
          image: await docker(
            "image",
            "inspect",
            process.env["FACTORY_LANGUAGE_PROOF_IMAGE"],
            "--format",
            "{{.Id}}",
          ),
          proofID,
          artifacts,
          sources: [...sources.values()],
          containers,
          docker,
        });
      containers.push(editorName);
      await docker(
        "run",
        "--detach",
        "--name",
        editorName,
        "--label",
        label,
        "--read-only",
        "--cap-drop",
        "ALL",
        "--security-opt",
        "no-new-privileges",
        "--publish",
        "127.0.0.1::4400",
        "--tmpfs",
        "/tmp:size=32m,mode=1777",
        "--tmpfs",
        "/home/node/.factory-theia:size=32m,uid=1000,gid=1000,mode=0700",
        editorImage,
      );
      const editorOrigin = `http://${await docker("port", editorName, "4400/tcp")}`;
      await waitReady(editorOrigin);
      proxy = Bun.serve<ProxySocket>({
        hostname: "127.0.0.1",
        port: 0,
        idleTimeout: 0,
        error(error) {
          if (!shutdown.signal.aborted) browserErrors.push(redacted(String(error)));
          return new Response(null, { status: 503 });
        },
        async fetch(request, server) {
          const url = new URL(request.url);
          if (url.pathname === "/_proof")
            return new Response(
              `<!doctype html><button id="a" onclick="pick('${workspaceA}')">A</button><button id="b" onclick="pick('${workspaceB}')">B</button><iframe style="position:absolute;inset:40px 0 0;width:100%;height:calc(100% - 40px);border:0" src="/?workspace=${workspaceA}"></iframe><script>function pick(workspaceID){document.querySelector('iframe').contentWindow.postMessage({type:'factory:select-workspace',workspaceID},location.origin)}</script>`,
              { headers: { "content-type": "text/html" } },
            );
          const presentation = url.pathname.match(
            /^\/__factory\/workspaces\/([0-9a-f-]{36})\/source\/context$/,
          );
          if (presentation?.[1]) {
            if (!sources.has(presentation[1])) return new Response(null, { status: 403 });
            return Response.json({
              workspaceID: presentation[1],
              label: presentation[1] === workspaceA ? "Personal · Fixture A" : "Ticket · Fixture B",
            });
          }
          const context = url.pathname.match(
            /^\/__factory\/workspaces\/([0-9a-f-]{36})\/(writer|runtime)(\/(?:ensure|activity))?$/,
          );
          if (context?.[1]) {
            if (!sources.has(context[1])) return new Response(null, { status: 403 });
            if (
              context[2] === "writer" &&
              context[3] === "/activity" &&
              request.method === "POST"
            ) {
              const activity = (await request.json()) as { epoch: number; kind: string };
              expect(Object.keys(activity).sort()).toEqual(["epoch", "kind"]);
              expect(activity.epoch).toBe(1);
              expect(["edit", "heartbeat"]).toContain(activity.kind);
              editingSignals.push({ workspaceID: context[1], kind: activity.kind });
              return new Response(null, { status: 204 });
            }
            if (context[2] === "runtime" && context[3] && request.method === "POST" && tools) {
              await tools.start(context[1]);
              return Response.json(tools.context(context[1]), { status: 202 });
            }
            if (request.method !== "GET" || context[3])
              throw new Error("Source-only proof must not start compute or take editing authority");
            return Response.json(
              context[2] === "writer"
                ? { state: "human", canWrite: true, yours: true, epoch: 1 }
                : (tools?.context(context[1]) ?? {
                    workspaceID: context[1],
                    attemptID: null,
                    state: "stopped",
                    failure: null,
                  }),
            );
          }
          const sourcePath = url.pathname.match(
            /^\/__factory\/workspaces\/([a-z0-9-]+)\/source\/(stat|list|read|write|mkdir|rename|delete|search|events)$/,
          );
          if (sourcePath) {
            const source = sources.get(sourcePath[1] ?? "");
            if (!source) return new Response(null, { status: 403 });
            const headers = new Headers(request.headers);
            headers.set("Authorization", `Bearer ${source.token}`);
            headers.set("X-Factory-Source-Service", source.serviceID);
            headers.set("X-Factory-Source-Epoch", "1");
            const response = await fetch(
              `${source.origin}/v1/workspaces/${source.workspaceID}/${sourcePath[2]}`,
              {
                method: request.method,
                headers,
                body: request.body,
                signal: shutdown.signal,
              },
            );
            sourceRequests.push({
              workspaceID: source.workspaceID,
              operation: sourcePath[2] ?? "",
              status: response.status,
            });
            return response;
          }
          if (request.headers.get("upgrade") === "websocket") {
            const language = url.pathname.match(
              /^\/__factory\/workspaces\/([0-9a-f-]{36})\/runtime\/([0-9a-f-]{36})\/language\/(typescript|python)$/,
            );
            if (
              url.pathname.startsWith("/__factory/") &&
              (!language ||
                !tools ||
                tools.context(fixtureValue(language[1], "language[1]")).attemptID !== language[2])
            )
              return new Response(null, { status: 403 });
            const target = new WebSocket(
              language && tools
                ? tools.target(
                    fixtureValue(language[1], "language[1]"),
                    fixtureValue(language[3], "language[3]"),
                  )
                : `${editorOrigin.replace("http:", "ws:")}${url.pathname}${url.search}`,
            );
            if (server.upgrade(request, { data: { target, pending: [], bytes: 0 } })) return;
            target.close();
            return new Response(null, { status: 400 });
          }
          const processes = url.pathname.match(
            /^\/__factory\/workspaces\/([0-9a-f-]{36})\/runtime\/([0-9a-f-]{36})\/processes(\/events)?$/,
          );
          if (
            processes &&
            tools &&
            tools.context(fixtureValue(processes[1], "processes[1]")).attemptID === processes[2]
          ) {
            return processes[3]
              ? tools.processEvents(fixtureValue(processes[1], "processes[1]"), request.signal)
              : Response.json(tools.processes(fixtureValue(processes[1], "processes[1]")));
          }
          const headers = new Headers(request.headers);
          headers.set("Accept-Encoding", "identity");
          const upstream = await fetch(`${editorOrigin}${url.pathname}${url.search}`, {
            method: request.method,
            headers,
            body: request.body,
            signal: shutdown.signal,
          });
          const responseHeaders = new Headers(upstream.headers);
          responseHeaders.delete("content-encoding");
          responseHeaders.delete("content-length");
          return new Response(upstream.body, { status: upstream.status, headers: responseHeaders });
        },
        websocket: {
          open(socket) {
            const { target, pending } = socket.data;
            target.binaryType = "arraybuffer";
            target.onopen = () => {
              for (const message of pending.splice(0))
                target.send(typeof message === "string" ? message : new Uint8Array(message));
              socket.data.bytes = 0;
            };
            target.onmessage = (event) => socket.send(event.data);
            target.onclose = () => socket.close();
            target.onerror = () => socket.close();
          },
          message(socket, message) {
            if (socket.data.target.readyState === WebSocket.OPEN) socket.data.target.send(message);
            else if (socket.data.target.readyState === WebSocket.CONNECTING) {
              socket.data.bytes += Buffer.byteLength(message);
              if (socket.data.bytes > 1 << 20) socket.close();
              else socket.data.pending.push(message);
            }
          },
          close(socket) {
            socket.data.target.close();
          },
        },
      });
      const page = await browser.newPage({ viewport: { width: 1440, height: 950 } });
      capturedPage = page;
      page.on("pageerror", (error) => browserErrors.push(error.message));
      page.on("console", (message) => {
        if (message.type() === "error") browserErrors.push(message.text().slice(0, 2000));
      });
      const pageStarted = performance.now();
      await page.goto(`${proxy.url}_proof`);
      const frame = page.frameLocator("iframe");
      await browserExpect(frame.getByText("Editor settings", { exact: true })).toBeVisible({
        timeout: 30_000,
      });
      const editorReadyMS = Math.round(performance.now() - pageStarted);
      await writeFile(resolve(artifacts, "startup.json"), JSON.stringify({ editorReadyMS }));
      await browserExpect(frame.getByText("Save: manual", { exact: true })).toBeVisible();
      await browserExpect(frame.getByText("Personal · Fixture A", { exact: true })).toBeVisible();
      expect(
        await frame
          .locator("#theia-left-side-panel")
          .evaluate((element) => element.getBoundingClientRect().width),
      ).toBeGreaterThanOrEqual(200);
      const validStatusLabels = async () => {
        const invalid = await frame
          .locator("#theia-statusBar [aria-label]")
          .evaluateAll((elements) =>
            elements
              .map((element) => element.getAttribute("aria-label"))
              .filter((label) => label?.includes("[object ")),
          );
        expect(invalid).toEqual([]);
      };
      await validStatusLabels();
      await browserExpect(frame.locator("#status-bar-session-preference-status")).toHaveAttribute(
        "aria-label",
        /These settings are overridden for this session/,
      );
      await frame.locator("#status-bar-session-preference-status").click();
      await browserExpect(
        frame.getByText("These settings are overridden for this session", { exact: true }),
      ).toBeVisible();
      await page.screenshot({ path: resolve(artifacts, "readable-session-preferences.png") });
      await frame.getByText("Editor settings", { exact: true }).click();
      await browserExpect(frame.locator(".theia-settings-container")).toBeVisible();
      await page.screenshot({ path: resolve(artifacts, "editor-preferences.png") });
      for (const [filename, language] of [
        ["view.tsx", "TypeScript JSX"],
        ["web.css", "CSS"],
        ["index.html", "HTML"],
        ["package.json", "JSON"],
        ["tsconfig.json", "JSON with Comments"],
      ] as const) {
        await frame.locator("#files").getByText(filename, { exact: true }).dblclick();
        await browserExpect(frame.locator("#status-bar-editor-status-language")).toHaveText(
          language,
        );
        await browserExpect
          .poll(() =>
            frame
              .locator(".monaco-editor:visible .view-line span")
              .evaluateAll(
                (elements) =>
                  new Set(
                    elements
                      .filter((element) => element.textContent?.trim())
                      .map((element) => getComputedStyle(element).color),
                  ).size,
              ),
          )
          .toBeGreaterThan(1);
        await page.screenshot({ path: resolve(artifacts, `language-${filename}.png`) });
      }
      await frame.locator("#files").getByText("app.ts", { exact: true }).dblclick();
      await browserExpect(frame.locator(".monaco-editor").first()).toBeVisible();
      await browserExpect(frame.locator(".view-lines").first()).toContainText("workspace-a");
      await browserExpect(frame.locator("#status-bar-editor-status-language")).toHaveText(
        "TypeScript",
      );
      await browserExpect
        .poll(() =>
          frame.locator(".monaco-editor:visible .view-line span").evaluateAll((elements) => {
            const colors = elements
              .filter((element) => element.textContent?.trim())
              .map((element) => getComputedStyle(element).color);
            return new Set(colors).size;
          }),
        )
        .toBeGreaterThan(1);
      await browserExpect(frame.locator("#status-bar-factory-buffer-workspace")).toHaveText(
        "File · Personal · Fixture A",
      );
      await validStatusLabels();
      const explorer = frame.locator("#theia-left-side-panel");
      const initialExplorerWidth = await explorer.evaluate(
        (element) => element.getBoundingClientRect().width,
      );
      const sidebar = await frame.locator("#theia-left-content-panel").boundingBox();
      if (!sidebar) throw new Error("The real Explorer resize boundary is unavailable");
      // The pinned Lumino sash has a zero-width box and a visible CSS hit area.
      const sashX = sidebar.x + sidebar.width;
      const sashY = sidebar.y + Math.min(120, sidebar.height / 2);
      await page.mouse.move(sashX, sashY);
      await page.mouse.down();
      await page.mouse.move(sashX + 72, sashY, { steps: 8 });
      await page.mouse.up();
      await browserExpect
        .poll(() => explorer.evaluate((element) => element.getBoundingClientRect().width))
        .toBeGreaterThan(initialExplorerWidth + 40);
      const resizedExplorerWidth = await explorer.evaluate(
        (element) => element.getBoundingClientRect().width,
      );
      const editor = frame.locator(".monaco-editor:visible");
      await browserExpect(editor).toHaveAttribute(
        "data-uri",
        `factory-workspace://${workspaceA}/app.ts`,
      );
      const input = editor.locator("[role='textbox']:not([aria-hidden='true'])");
      const mac = await frame.locator("body").evaluate(() => navigator.platform.startsWith("Mac"));
      await input.focus();
      await input.press(mac ? "Meta+ArrowDown" : "Control+End");
      await input.pressSequentially("// unsaved workspace-a edit");
      await browserExpect(editor.locator(".view-lines")).toContainText("unsaved workspace-a edit");
      const documentID = await frame.locator("body").evaluate(() => performance.timeOrigin);
      await page.screenshot({ path: resolve(artifacts, "independent-source.png") });
      const switched = performance.now();
      await page.locator("#b").click();
      await browserExpect(
        frame.locator(`[id="factory-workspace://${workspaceB}/app.ts"]`),
      ).toBeVisible();
      await browserExpect(frame.getByText("Ticket · Fixture B", { exact: true })).toBeVisible();
      expect(
        await explorer.evaluate((element) => element.getBoundingClientRect().width),
      ).toBeGreaterThanOrEqual(resizedExplorerWidth - 2);
      await frame.locator(`[id="factory-workspace://${workspaceB}/app.ts"]`).dblclick();
      await browserExpect(
        frame.locator(".view-lines").filter({ hasText: "workspace-b" }).first(),
      ).toBeVisible();
      const switchMS = Math.round(performance.now() - switched);
      expect(switchMS).toBeLessThan(3000);
      await browserExpect(frame.locator(".monaco-editor:visible")).toHaveAttribute(
        "data-uri",
        `factory-workspace://${workspaceB}/app.ts`,
      );
      expect(await frame.locator("body").evaluate(() => performance.timeOrigin)).toBe(documentID);
      await page.screenshot({ path: resolve(artifacts, "selected-source.png") });
      const navigate = async (
        workspaceID: string,
        path: string,
        kind: "file" | "diff" = "file",
      ) => {
        const target = {
          type: "factory:open-activity",
          id: randomUUID(),
          workspaceID,
          path,
          kind,
          ...(kind === "diff" ? { diff: "--- app.ts\n+++ app.ts\n@@ -1 +1 @@\n-old\n+new" } : {}),
        };
        await page.evaluate((message) => {
          function fixtureValue<T>(value: T, description: string): NonNullable<T> {
            if (value === undefined || value === null)
              throw new Error(`Missing fixture value: ${description}`);
            return value;
          }

          fixtureValue(
            fixtureValue(document.querySelector("iframe"), 'document.querySelector("iframe")')
              .contentWindow,
            'document.querySelector("iframe")!.contentWindow',
          ).postMessage(message, location.origin);
        }, target);
        return target.id;
      };
      await navigate(workspaceA, "unopened.txt");
      await page.waitForTimeout(150);
      await browserExpect(frame.locator(".monaco-editor:visible")).toHaveAttribute(
        "data-uri",
        `factory-workspace://${workspaceB}/app.ts`,
      );
      await navigate(workspaceB, "unopened.txt");
      await browserExpect(frame.locator(".monaco-editor:visible")).toHaveAttribute(
        "data-uri",
        `factory-workspace://${workspaceB}/unopened.txt`,
      );
      const writesBeforeDiff = sourceRequests.filter(
        (request) => request.operation === "write",
      ).length;
      const diffID = await navigate(workspaceB, "app.ts", "diff");
      await browserExpect(frame.locator(".monaco-editor:visible")).toHaveAttribute(
        "data-uri",
        `factory-activity://${workspaceB}/${diffID}/app.ts.diff`,
      );
      await browserExpect(frame.locator(".monaco-editor:visible .view-lines")).toContainText(
        "Recorded tool diff",
      );
      const diffInput = frame.locator(
        ".monaco-editor:visible [role='textbox']:not([aria-hidden='true'])",
      );
      await diffInput.focus();
      await diffInput.pressSequentially("must-not-edit");
      await browserExpect(frame.locator(".monaco-editor:visible .view-lines")).not.toContainText(
        "must-not-edit",
      );
      expect(sourceRequests.filter((request) => request.operation === "write")).toHaveLength(
        writesBeforeDiff,
      );
      await page.screenshot({ path: resolve(artifacts, "chat-recorded-diff.png") });
      await frame.locator(`[id="factory-workspace://${workspaceB}/app.ts"]`).dblclick();
      await browserExpect(frame.locator(".monaco-editor:visible")).toHaveAttribute(
        "data-uri",
        `factory-workspace://${workspaceB}/app.ts`,
      );
      await browserExpect(frame.locator("#status-bar-factory-buffer-workspace")).toHaveText(
        "File · Ticket · Fixture B",
      );
      const retainedTab = frame.locator(".lm-TabBar-tab").filter({ hasText: "app.ts" }).first();
      await retainedTab.click();
      await browserExpect(frame.locator(".monaco-editor:visible")).toHaveAttribute(
        "data-uri",
        `factory-workspace://${workspaceA}/app.ts`,
      );
      await browserExpect(frame.locator("#status-bar-factory-buffer-workspace")).toHaveText(
        "File · Personal · Fixture A",
      );
      await browserExpect(frame.getByText("Ticket · Fixture B", { exact: true })).toBeVisible();
      editingSignals.length = 0;
      const originalBufferInput = frame.locator(
        ".monaco-editor:visible [role='textbox']:not([aria-hidden='true'])",
      );
      await originalBufferInput.focus();
      await originalBufferInput.pressSequentially("Q");
      await browserExpect(frame.locator(".monaco-editor:visible .view-lines")).toContainText("Q");
      await originalBufferInput.press("Backspace");
      await browserExpect
        .poll(() =>
          editingSignals
            .filter((signal) => signal.kind === "edit")
            .map((signal) => signal.workspaceID),
        )
        .toEqual([workspaceA]);
      await page.screenshot({ path: resolve(artifacts, "retained-buffer-workspace.png") });
      await page.locator("#a").click();
      await browserExpect(
        frame.locator(`[id="factory-workspace://${workspaceA}/app.ts"]`),
      ).toBeVisible();
      await browserExpect(frame.getByText("Personal · Fixture A", { exact: true })).toBeVisible();
      await frame.locator(`[id="factory-workspace://${workspaceA}/app.ts"]`).dblclick();
      await browserExpect(frame.locator(".monaco-editor:visible .view-lines")).toContainText(
        "unsaved workspace-a edit",
      );
      await browserExpect(frame.locator(".monaco-editor:visible")).toHaveAttribute(
        "data-uri",
        `factory-workspace://${workspaceA}/app.ts`,
      );
      await frame
        .locator(".monaco-editor:visible [role='textbox']:not([aria-hidden='true'])")
        .press("ControlOrMeta+s");
      await browserExpect
        .poll(
          async () =>
            sourceRequests.filter(
              (request) =>
                request.workspaceID === workspaceA &&
                request.operation === "write" &&
                request.status === 200,
            ).length,
        )
        .toBe(1);
      const original = sources.get(workspaceA);
      const alternate = sources.get(workspaceB);
      if (!original || !alternate) throw new Error("Expected exact source fixtures");
      const canonical = async (source: SourceFixture) =>
        docker("exec", "--user", "101000:101000", source.container, "cat", "/source/app.ts");
      expect(await canonical(original)).toBe(
        "export const workspace = 'workspace-a';\n// unsaved workspace-a edit",
      );
      expect(await canonical(alternate)).toBe("export const workspace = 'workspace-b';");
      await page.screenshot({ path: resolve(artifacts, "saved-original-source.png") });
      await frame.locator("#shell-tab-search-view-container").click();
      const search = frame.locator("#search-input-field");
      await search.fill("canonical search fixture workspace-a");
      await search.press("Enter");
      await browserExpect
        .poll(() =>
          sourceRequests.some(
            (request) =>
              request.workspaceID === workspaceA &&
              request.operation === "search" &&
              request.status === 200,
          ),
        )
        .toBe(true);
      await browserExpect(
        frame
          .locator("#search-view-container span.match")
          .filter({ hasText: "canonical search fixture workspace-a" }),
      ).toBeVisible();
      expect(
        sourceRequests.some(
          (request) =>
            request.workspaceID === workspaceA &&
            request.operation === "search" &&
            request.status === 200,
        ),
      ).toBe(true);
      await page.screenshot({ path: resolve(artifacts, "canonical-search.png") });
      const external = async (content: string) =>
        docker(
          "exec",
          "--user",
          "101000:101000",
          original.container,
          "sh",
          "-c",
          'printf "%s" "$1" > /source/app.ts',
          "fixture-write",
          content,
        );
      const externalContent = "export const workspace = 'workspace-a';\n// external source edit\n";
      await external(externalContent);
      await browserExpect(frame.locator(".monaco-editor:visible .view-lines")).toContainText(
        "external source edit",
      );
      const dirtyInput = frame.locator(
        ".monaco-editor:visible [role='textbox']:not([aria-hidden='true'])",
      );
      await dirtyInput.focus();
      await dirtyInput.press(mac ? "Meta+ArrowDown" : "Control+End");
      await dirtyInput.pressSequentially("// pending human change");
      await external("export const workspace = 'workspace-a';\n// newer external source\n");
      await dirtyInput.press("ControlOrMeta+s");
      await browserExpect(frame.locator("body")).toContainText(
        "has been changed on the file system",
      );
      await frame.getByRole("button", { name: "No", exact: true }).click();
      await browserExpect(frame.locator(".monaco-editor:visible .view-lines")).toContainText(
        "pending human change",
      );
      expect(await canonical(original)).toBe(
        "export const workspace = 'workspace-a';\n// newer external source",
      );
      await page.screenshot({ path: resolve(artifacts, "stale-save-keeps-buffer.png") });
      let languageMetrics: { languageProcesses: number; memoryBytes: number } | undefined;
      if (tools) {
        expect(tools.starts).toBe(0);
        expect(tools.languageConnections).toBe(0);
        await frame.locator("body").press(mac ? "Meta+Shift+E" : "Control+Shift+E");
        await frame.locator("#files").getByText("language.ts", { exact: true }).dblclick();
        const status = frame.locator("#status-bar-factory-language-tools");
        await browserExpect(status).toContainText("Start tools");
        await page.screenshot({ path: resolve(artifacts, "project-tools-explicit-start.png") });
        await status.click();
        // Explicit compute preparation has the product's existing five-minute
        // bound. Connected language requests are checked separately below.
        await browserExpect(status).toHaveText("TypeScript tools", { timeout: 300_000 });
        expect(tools.starts).toBe(1);
        const code = frame.locator(".monaco-editor:visible");
        await browserExpect(code.locator(".squiggly-error").first()).toBeVisible({
          timeout: 20_000,
        });
        await frame.locator("#shell-tab-problems").click();
        await browserExpect(frame.locator("#problems")).toContainText(
          "Type 'number' is not assignable to type 'string'",
          { timeout: 20_000 },
        );
        await page.screenshot({ path: resolve(artifacts, "typescript-semantic-diagnostic.png") });
        const codeInput = code.locator("[role='textbox']:not([aria-hidden='true'])");
        await codeInput.focus();
        await codeInput.press(mac ? "Meta+ArrowDown" : "Control+End");
        await codeInput.press("ArrowUp");
        await codeInput.press(mac ? "Meta+ArrowRight" : "End");
        await codeInput.press("Control+Space");
        await browserExpect(
          frame.locator(".suggest-widget.visible").getByText("amount", { exact: true }),
        ).toBeVisible();
        await page.screenshot({ path: resolve(artifacts, "typescript-project-completion.png") });
        await codeInput.press("Escape");
        // Definition goes to the actual installed dependency in the same Workspace.
        await codeInput.press(mac ? "Meta+ArrowUp" : "Control+Home");
        await codeInput.press("ArrowDown");
        await codeInput.press(mac ? "Meta+ArrowLeft" : "Home");
        for (let column = 0; column < 31; column++) await codeInput.press("ArrowRight");
        await codeInput.press("F12");
        await browserExpect(frame.locator(".monaco-editor:visible")).toHaveAttribute(
          "data-uri",
          new RegExp(
            `factory-language://${workspaceA}/.+/opt/project-seed/node_modules/fixture-dep/index.d.ts$`,
          ),
        );
        await page.screenshot({ path: resolve(artifacts, "typescript-project-definition.png") });
        await browserExpect(
          frame.locator(".monaco-editor:visible [role='textbox']:not([aria-hidden='true'])"),
        ).toHaveAttribute("aria-autocomplete", "none");
        await frame.locator("#files").getByText("language.py", { exact: true }).dblclick();
        await browserExpect(status).toHaveText("Python tools", { timeout: 20_000 });
        await browserExpect(
          frame.locator(".monaco-editor:visible .squiggly-error").first(),
        ).toBeVisible({ timeout: 20_000 });
        await browserExpect(frame.locator("#problems")).toContainText(
          /Type "int" is not assignable/,
          { timeout: 20_000 },
        );
        await page.screenshot({ path: resolve(artifacts, "python-semantic-diagnostic.png") });
        const pythonInput = frame.locator(
          ".monaco-editor:visible [role='textbox']:not([aria-hidden='true'])",
        );
        await pythonInput.focus();
        await pythonInput.press(mac ? "Meta+ArrowDown" : "Control+End");
        await pythonInput.press("ArrowUp");
        await pythonInput.press(mac ? "Meta+ArrowRight" : "End");
        await pythonInput.press("Control+Space");
        await browserExpect(
          frame.locator(".suggest-widget.visible").getByText("bit_length", { exact: true }),
        ).toBeVisible();
        await page.screenshot({ path: resolve(artifacts, "python-project-completion.png") });
        await pythonInput.press("Escape");
        await pythonInput.press(mac ? "Meta+ArrowUp" : "Control+Home");
        await pythonInput.press(mac ? "Meta+ArrowRight" : "End");
        await pythonInput.press("ArrowLeft");
        await pythonInput.press("F12");
        await browserExpect(frame.locator(".monaco-editor:visible")).toHaveAttribute(
          "data-uri",
          new RegExp(
            `factory-language://${workspaceA}/.+/opt/project-venv/lib/python3.14/site-packages/fixture_amount.py$`,
          ),
        );
        await page.screenshot({ path: resolve(artifacts, "python-environment-definition.png") });
        await browserExpect(
          frame.locator(".monaco-editor:visible [role='textbox']:not([aria-hidden='true'])"),
        ).toHaveAttribute("aria-autocomplete", "none");
        languageMetrics = await tools.processMetrics(workspaceA);
        expect(languageMetrics.languageProcesses).toBeGreaterThanOrEqual(2);
        await frame.locator("#files").getByText("language.ts", { exact: true }).dblclick();
        const reconnectInput = frame.locator(
          ".monaco-editor:visible [role='textbox']:not([aria-hidden='true'])",
        );
        await reconnectInput.focus();
        await reconnectInput.press(mac ? "Meta+ArrowDown" : "Control+End");
        await reconnectInput.pressSequentially("// retained through language reconnect");
        for (let reconnect = 0; reconnect < 3; reconnect++) {
          tools.disconnect(workspaceA);
          await browserExpect(status).toContainText("Retry tools");
          await status.click();
          await browserExpect(status).toHaveText("TypeScript tools", { timeout: 20_000 });
          await browserExpect(frame.locator("#problems")).toContainText(
            "Type 'number' is not assignable to type 'string'",
            { timeout: 20_000 },
          );
          await browserExpect(frame.locator(".monaco-editor:visible .view-lines")).toContainText(
            "retained through language reconnect",
          );
          expect(tools.starts).toBe(1);
        }
        await page.screenshot({ path: resolve(artifacts, "project-language-reconnect.png") });
        await page.locator("#b").click();
        await browserExpect(frame.getByText("Ticket · Fixture B", { exact: true })).toBeVisible();
        await frame.locator("#files").getByText("language.ts", { exact: true }).dblclick();
        await browserExpect(status).toContainText("Start tools");
        expect(tools.starts).toBe(1);
        await page.locator("#a").click();
        await browserExpect(frame.getByText("Personal · Fixture A", { exact: true })).toBeVisible();
        await frame.locator("#files").getByText("language.ts", { exact: true }).dblclick();
        await browserExpect(status).toHaveText("TypeScript tools", { timeout: 20_000 });
        await browserExpect(frame.locator("#problems")).toContainText(
          "Type 'number' is not assignable to type 'string'",
          { timeout: 20_000 },
        );
        await browserExpect(frame.locator(".monaco-editor:visible .view-lines")).toContainText(
          "retained through language reconnect",
        );
        await page.screenshot({
          path: resolve(artifacts, "project-tools-workspace-retention.png"),
        });
        await page.setViewportSize({ width: 800, height: 900 });
        await browserExpect
          .poll(() => explorer.evaluate((element) => element.getBoundingClientRect().width))
          .toBeLessThanOrEqual(300);
        await browserExpect
          .poll(() => status.evaluate((element) => element.getBoundingClientRect().right))
          .toBeLessThanOrEqual(800);
        await browserExpect(status).toBeInViewport();
        await page.screenshot({ path: resolve(artifacts, "project-language-narrow.png") });
        await status.click();
        await browserExpect(status).toContainText("Start tools");
        await browserExpect
          .poll(
            async () =>
              (await fixtureValue(tools, "tools").processMetrics(workspaceA)).languageProcesses,
          )
          .toBe(0);
        await page.setViewportSize({ width: 1440, height: 950 });
        await browserExpect
          .poll(async () =>
            Math.abs(
              (await explorer.evaluate((element) => element.getBoundingClientRect().width)) -
                resizedExplorerWidth,
            ),
          )
          .toBeLessThan(3);
      }
      const editorLog = await editorLogs(editorName);
      expect(editorLog).not.toContain("EROFS");
      expect(editorLog).not.toContain("Uncaught Exception");
      if (tools)
        await writeFile(
          resolve(artifacts, "language-observations.json"),
          JSON.stringify(tools.observations, null, 2),
        );
      await writeFile(
        resolve(artifacts, "result.json"),
        JSON.stringify({
          proofID,
          independentEditor: true,
          sourceWithoutExecution: true,
          sourceImage,
          editorImage,
          editorReadyMS,
          switchMS,
          dirtyBufferPreserved: true,
          canonicalSave: true,
          canonicalSearch: true,
          externalWatch: true,
          staleSavePreservesHumanBuffer: true,
          workspaceNamesAndCaptions: true,
          usableExplorerMinimum: true,
          readableStatusAccessibility: true,
          richStatusHoverPreserved: true,
          explorerUserResizePreserved: true,
          activeBufferWorkspaceVisible: true,
          starterSyntaxWithoutExecution: true,
          projectLanguageTools: tools
            ? {
                starts: tools.starts,
                image: tools.image,
                languageConnections: tools.languageConnections,
                typeScriptDependencies: true,
                pythonVirtualEnvironment: true,
                completion: true,
                semanticDiagnostics: true,
                definitions: true,
                reconnectRetainsBuffers: true,
                languageMetrics,
                languageStopConfirmed: true,
              }
            : null,
        }),
      );
    } catch (error) {
      failed = true;
      if (tools)
        await writeFile(
          resolve(artifacts, "language-observations.json"),
          JSON.stringify(tools.observations, null, 2),
        );
      await writeFile(resolve(artifacts, "editor.log"), await editorLogs(editorName));
      if (capturedPage) {
        await capturedPage
          .screenshot({ path: resolve(artifacts, "failed-source.png") })
          .catch(() => {});
        const frames = await Promise.all(
          capturedPage.frames().map(async (frame) => ({
            url: frame.url(),
            document: await frame
              .locator("body")
              .evaluate((element) => ({
                readyState: element.ownerDocument.readyState,
                classes: element.className,
                children: element.children.length,
              }))
              .catch(() => null),
            text: (
              await frame
                .locator("body")
                .innerText({ timeout: 1000 })
                .catch(() => "unavailable")
            ).slice(0, 10000),
          })),
        );
        await writeFile(
          resolve(artifacts, "failure.json"),
          JSON.stringify({ proofID, browserErrors, sourceRequests, frames }),
        );
      }
      console.error(JSON.stringify({ proofID, browserErrors, sourceRequests }));
      throw error;
    } finally {
      await browser.close();
      shutdown.abort();
      await tools?.dispose();
      await proxy?.stop(true);
      await cleanOwnedFixtures(proofID, containers, volumes, artifacts, failed);
      for (const source of sources.values()) fixtureSecrets.delete(source.token);
    }
  },
  600_000,
);
