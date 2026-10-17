import { expect, test } from "bun:test";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium, expect as browserExpect, type Page } from "@playwright/test";

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
      await docker("rm", "--force", container);
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
    const label = `factory.dev.independent-editor-proof=${proofID}`;
    const artifacts = resolve(root, ".factory/test-results/independent-editor", proofID);
    await mkdir(artifacts, { recursive: true });
    const sourceImage = await docker(
      "image",
      "inspect",
      "factory-slice17-workspace-files:proof",
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
      JSON.stringify({ proofID, sourceImage, editorImage, editorName }),
    );
    const sources = new Map<string, SourceFixture>();
    let proxy: ReturnType<typeof Bun.serve<ProxySocket>> | undefined;
    let capturedPage: Page | undefined;
    const browserErrors: string[] = [];
    const sourceRequests: Array<{ workspaceID: string; operation: string; status: number }> = [];
    const browser = await chromium.launch({ headless: true });
    let failed = false;
    const shutdown = new AbortController();
    try {
      for (const [index, workspaceID] of ["workspace-a", "workspace-b"].entries()) {
        const token = randomBytes(32).toString("hex");
        fixtureSecrets.add(token);
        const serviceID = `source-${index}`;
        const volume = `factory-source-proof-${proofID}-${index}`;
        const container = `factory-source-proof-${proofID}-${index}`;
        await writeFile(
          resolve(artifacts, `source-${index}-intent.json`),
          JSON.stringify({ workspaceID, serviceID, volume, container, sourceImage }),
        );
        volumes.push(volume);
        await docker("volume", "create", "--label", label, volume);
        const authored = `export const workspace = '${workspaceID}';\n`;
        const initialize = `const fs=require('fs');fs.mkdirSync('/data/source',{mode:0o755});fs.mkdirSync('/data/control',{mode:0o755});fs.chownSync('/data/source',101000,101000);for(const [name,content] of [['app.ts',${JSON.stringify(authored)}],['unopened.txt','canonical search fixture ${workspaceID}']]){fs.writeFileSync('/data/source/'+name,content);fs.chownSync('/data/source/'+name,101000,101000)}fs.writeFileSync('/data/control/access.json',JSON.stringify(${JSON.stringify({ workspaceId: workspaceID, serviceId: serviceID, epoch: 1, token })}),{mode:0o444});`;
        await docker(
          "run",
          "--rm",
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
        expect(await listing.json()).toEqual([
          expect.objectContaining({ name: "app.ts", kind: "file" }),
          expect.objectContaining({ name: "unopened.txt", kind: "file" }),
        ]);
        expect(await docker("inspect", container, "--format", "{{.Config.User}}")).toBe(
          "101000:101000",
        );
      }
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
              `<!doctype html><button id="a" onclick="pick('workspace-a')">A</button><button id="b" onclick="pick('workspace-b')">B</button><iframe style="position:absolute;inset:40px 0 0;width:100%;height:calc(100% - 40px);border:0" src="/?workspace=workspace-a"></iframe><script>function pick(workspaceID){document.querySelector('iframe').contentWindow.postMessage({type:'factory:select-workspace',workspaceID},location.origin)}</script>`,
              { headers: { "content-type": "text/html" } },
            );
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
            const target = new WebSocket(
              `${editorOrigin.replace("http:", "ws:")}${url.pathname}${url.search}`,
            );
            if (server.upgrade(request, { data: { target, pending: [], bytes: 0 } })) return;
            target.close();
            return new Response(null, { status: 400 });
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
      await page.goto(`${proxy.url}_proof`);
      const frame = page.frameLocator("iframe");
      await browserExpect(frame.getByText("Editor settings", { exact: true })).toBeVisible();
      await browserExpect(frame.getByText("Save: manual", { exact: true })).toBeVisible();
      await frame.getByText("Editor settings", { exact: true }).click();
      await browserExpect(frame.locator(".theia-settings-container")).toBeVisible();
      await page.screenshot({ path: resolve(artifacts, "editor-preferences.png") });
      await frame.locator("#files").getByText("app.ts", { exact: true }).dblclick();
      await browserExpect(frame.locator(".monaco-editor").first()).toBeVisible();
      await browserExpect(frame.locator(".view-lines").first()).toContainText("workspace-a");
      const editor = frame.locator(".monaco-editor:visible");
      await browserExpect(editor).toHaveAttribute(
        "data-uri",
        "factory-workspace://workspace-a/app.ts",
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
        frame.locator('[id="factory-workspace://workspace-b/app.ts"]'),
      ).toBeVisible();
      await frame.locator('[id="factory-workspace://workspace-b/app.ts"]').dblclick();
      await browserExpect(
        frame.locator(".view-lines").filter({ hasText: "workspace-b" }).first(),
      ).toBeVisible();
      const switchMS = Math.round(performance.now() - switched);
      expect(switchMS).toBeLessThan(3000);
      await browserExpect(frame.locator(".monaco-editor:visible")).toHaveAttribute(
        "data-uri",
        "factory-workspace://workspace-b/app.ts",
      );
      expect(await frame.locator("body").evaluate(() => performance.timeOrigin)).toBe(documentID);
      await page.screenshot({ path: resolve(artifacts, "selected-source.png") });
      await page.locator("#a").click();
      await browserExpect(
        frame.locator('[id="factory-workspace://workspace-a/app.ts"]'),
      ).toBeVisible();
      await frame.locator('[id="factory-workspace://workspace-a/app.ts"]').dblclick();
      await browserExpect(frame.locator(".monaco-editor:visible .view-lines")).toContainText(
        "unsaved workspace-a edit",
      );
      await browserExpect(frame.locator(".monaco-editor:visible")).toHaveAttribute(
        "data-uri",
        "factory-workspace://workspace-a/app.ts",
      );
      await frame
        .locator(".monaco-editor:visible [role='textbox']:not([aria-hidden='true'])")
        .press("ControlOrMeta+s");
      await browserExpect
        .poll(
          async () =>
            sourceRequests.filter(
              (request) =>
                request.workspaceID === "workspace-a" &&
                request.operation === "write" &&
                request.status === 200,
            ).length,
        )
        .toBe(1);
      const original = sources.get("workspace-a");
      const alternate = sources.get("workspace-b");
      if (!original || !alternate) throw new Error("Expected exact source fixtures");
      const canonical = async (source: SourceFixture) =>
        docker(
          "run",
          "--rm",
          "--user",
          "101000:101000",
          "--mount",
          `type=volume,source=${source.volume},target=/source,volume-subpath=source,readonly`,
          nodeImage,
          "node",
          "-e",
          'process.stdout.write(require("fs").readFileSync("/source/app.ts","utf8"))',
        );
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
              request.workspaceID === "workspace-a" &&
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
            request.workspaceID === "workspace-a" &&
            request.operation === "search" &&
            request.status === 200,
        ),
      ).toBe(true);
      await page.screenshot({ path: resolve(artifacts, "canonical-search.png") });
      const external = async (content: string) =>
        docker(
          "run",
          "--rm",
          "--user",
          "101000:101000",
          "--mount",
          `type=volume,source=${original.volume},target=/source,volume-subpath=source`,
          nodeImage,
          "node",
          "-e",
          `require('fs').writeFileSync('/source/app.ts',${JSON.stringify(content)})`,
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
      await writeFile(
        resolve(artifacts, "result.json"),
        JSON.stringify({
          proofID,
          independentEditor: true,
          sourceWithoutExecution: true,
          sourceImage,
          editorImage,
          switchMS,
          dirtyBufferPreserved: true,
          canonicalSave: true,
          canonicalSearch: true,
          externalWatch: true,
          staleSavePreservesHumanBuffer: true,
        }),
      );
    } catch (error) {
      failed = true;
      if (capturedPage) {
        await capturedPage
          .screenshot({ path: resolve(artifacts, "failed-source.png") })
          .catch(() => {});
        const frames = await Promise.all(
          capturedPage.frames().map(async (frame) => ({
            url: frame.url(),
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
      shutdown.abort();
      await browser.close();
      await proxy?.stop(true);
      await cleanOwnedFixtures(proofID, containers, volumes, artifacts, failed);
      for (const source of sources.values()) fixtureSecrets.delete(source.token);
    }
  },
  120_000,
);
