import { expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { chromium, expect as visible } from "@playwright/test";
import { appRuntimeHeaders, scopeAppCookies } from "../../apps/factory/src/runtime/hub";
import { eventually, factoryProcess } from "../fixtures/factory-process";

const ClientSocket = WebSocket as typeof WebSocket & {
  new (url: string, protocols: string[], options: Bun.WebSocketOptions): WebSocket;
};

test("Starter authentication works behind the real scoped App proxy path and retains only its own session", async () => {
  const process = await factoryProcess();
  const database = process.connect();
  let server: ReturnType<typeof Bun.spawn> | undefined;
  let proxy: ReturnType<typeof Bun.serve> | undefined;
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  const port = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
  const number = port.port;
  await port.stop(true);
  const id = crypto.randomUUID();
  const host = `${id.replaceAll("-", "")}.app.runtime.localhost:3000`;
  const prefix = `/runtime/${id}/preview/app`;
  try {
    await database.client`CREATE DATABASE starter`;
    const url = new URL(process.databaseURL);
    url.pathname = "/starter";
    const env = {
      ...globalThis.process.env,
      DATABASE_URL: url.toString(),
      BETTER_AUTH_SECRET: "owned-proxy-secret-not-a-production-key",
      PORT: String(number),
    };
    const migrate = Bun.spawn(["npm", "run", "db:migrate"], {
      cwd: "templates/starter-app",
      env,
      stdout: "ignore",
      stderr: "ignore",
    });
    expect(await migrate.exited).toBe(0);
    server = Bun.spawn(["node", "--watch", "src/server.ts"], {
      cwd: "templates/starter-app",
      env,
      stdout: "ignore",
      stderr: "ignore",
    });
    await eventually(
      () => fetch(`http://127.0.0.1:${number}/health`).catch(() => null),
      (value) => value?.ok === true,
      "Starter server unavailable",
    );
    const headers = {
      "x-forwarded-host": host,
      "x-forwarded-proto": "http",
      "x-forwarded-prefix": prefix,
      origin: `http://${host}`,
    };
    expect((await fetch(`http://127.0.0.1:${number}/`)).status).toBe(200);
    const html = await fetch(`http://127.0.0.1:${number}/`, { headers }).then((r) => r.text());
    expect(html).toContain(`<base href="${prefix}/">`);
    expect(html).toContain(`src="${prefix}/src/web.tsx"`);
    const client = await fetch(`http://127.0.0.1:${number}/@vite/client`, { headers }).then((r) =>
      r.text(),
    );
    const wsToken = client.match(/const wsToken = "([A-Za-z0-9_-]+)"/)?.[1];
    expect(wsToken).toBeDefined();
    const scopedSocket = new ClientSocket(
      `ws://127.0.0.1:${number}/?token=${wsToken}`,
      ["vite-hmr"],
      {
        headers,
      },
    );
    try {
      const connected = new Promise<string>((resolve, reject) => {
        scopedSocket.onmessage = (event) => resolve(String(event.data));
        scopedSocket.onerror = () => reject(new Error("Scoped Starter HMR handshake failed"));
      });
      expect(await Promise.race([connected, Bun.sleep(3000).then(() => "timed out")])).toBe(
        '{"type":"connected"}',
      );
    } finally {
      scopedSocket.close();
    }
    const signup = await fetch(`http://127.0.0.1:${number}/api/auth/sign-up/email`, {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({
        name: "App user",
        email: `${id}@starter.test`,
        password: crypto.randomUUID(),
      }),
    });
    expect(signup.status).toBe(200);
    const cookies = signup.headers.getSetCookie();
    expect(cookies.some((cookie) => cookie.includes(`Path=${prefix}/`))).toBe(true);
    const cookie = cookies.map((value) => value.split(";")[0]).join("; ");
    const session = await fetch(`http://127.0.0.1:${number}/api/session`, {
      headers: { ...headers, cookie },
    });
    expect(session.status).toBe(200);
    expect(await session.json()).toEqual({ name: "App user" });
    expect((await fetch(`http://127.0.0.1:${number}/api/session`, { headers })).status).toBe(401);
    const assetPaths: string[] = [];
    proxy = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        const url = new URL(request.url);
        assetPaths.push(url.pathname);
        if (!url.pathname.startsWith(`${prefix}/`))
          return new Response("Unscoped request", { status: 404 });
        const path = url.pathname.slice(prefix.length) + url.search;
        const response = await fetch(`http://127.0.0.1:${number}${path}`, {
          method: request.method,
          headers: appRuntimeHeaders(request, path),
          ...(request.body ? { body: request.body } : {}),
          redirect: "manual",
        });
        return scopeAppCookies(response, prefix);
      },
    });
    browser = await chromium.launch({
      headless: true,
      ...(globalThis.process.env["PLAYWRIGHT_CHROMIUM_EXECUTABLE"]
        ? { executablePath: globalThis.process.env["PLAYWRIGHT_CHROMIUM_EXECUTABLE"] }
        : {}),
    });
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    const directPage = await browser.newPage();
    let directHMR = false;
    directPage.on("websocket", (socket) =>
      socket.on("framereceived", ({ payload }) => {
        if (String(payload) === '{"type":"connected"}') directHMR = true;
      }),
    );
    await directPage.goto(`http://127.0.0.1:${number}/`);
    await visible.poll(() => directHMR, { timeout: 5000 }).toBe(true);
    await directPage.close();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("response", (response) => {
      if (response.status() >= 400 && !response.url().includes("/api/session"))
        errors.push(`HTTP ${response.status()}`);
    });
    await page.goto(
      `http://${id.replaceAll("-", "")}.app.runtime.localhost:${proxy.port}${prefix}/`,
    );
    const module = await fetch(`http://127.0.0.1:${number}/src/web.tsx`, { headers });
    const source = await module.text();
    const check = Bun.spawn(["node", "--input-type=module", "--check"], {
      stdin: "pipe",
      stdout: "ignore",
      stderr: "pipe",
    });
    check.stdin.write(source);
    check.stdin.end();
    await new Response(check.stderr).text();
    expect(await check.exited).toBe(0);
    await page.getByRole("button", { name: "Create an account", exact: true }).click();
    await page.getByLabel("Name", { exact: true }).fill("Browser app user");
    await page.getByLabel("Email", { exact: true }).fill(`${crypto.randomUUID()}@starter.test`);
    await page.getByLabel("Password", { exact: true }).fill(crypto.randomUUID());
    await page.getByRole("button", { name: "Create account", exact: true }).click();
    await visible(page.getByRole("heading", { name: "You're home." })).toBeVisible();
    await page.reload();
    await visible(page.getByRole("heading", { name: "You're home." })).toBeVisible();
    await mkdir(".factory/screenshots/project-setup", { recursive: true });
    await page.screenshot({
      path: ".factory/screenshots/project-setup/starter-home.png",
      animations: "disabled",
    });
    await page.getByRole("button", { name: "Sign out", exact: true }).click();
    await visible(page.getByRole("button", { name: "Sign in", exact: true })).toBeVisible();
    expect(errors).toEqual([]);
    expect(assetPaths.filter((path) => !path.startsWith(`${prefix}/`))).toEqual([]);
  } finally {
    await browser?.close();
    await proxy?.stop(true);
    if (server) {
      server.kill("SIGKILL");
      await server.exited;
    }
    await database.client.end({ timeout: 2 });
    await process.dispose();
  }
}, 60_000);
