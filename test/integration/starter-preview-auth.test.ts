import { expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium, expect as visible } from "@playwright/test";
import { appRuntimeHeaders, scopeAppCookies } from "../../apps/factory/src/runtime/hub";
import { eventually } from "../fixtures/factory-process";
import { starterApplication } from "../fixtures/starter-application";

const ClientSocket = WebSocket as typeof WebSocket & {
  new (url: string, protocols: string[], options: Bun.WebSocketOptions): WebSocket;
};

test.each(["development", "production"] as const)(
  "Starter %s uses native Server Functions behind the scoped App proxy and retains only its own session",
  async (mode) => {
    const starter = await starterApplication();
    let proxy: ReturnType<typeof Bun.serve> | undefined;
    let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
    const port = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
    const number = port.port;
    await port.stop(true);
    const id = crypto.randomUUID();
    const host = `${id.replaceAll("-", "")}-app.runtime.localhost:3000`;
    const prefix = `/runtime/${id}/preview/app`;
    const screenshots = resolve(starter.directory, "screenshots");
    const releaseRequests: (() => void)[] = [];
    try {
      await mkdir(screenshots, { recursive: true });
      await starter.command(["npm", "run", "db:migrate"]);
      let sessionPath = "";
      if (mode === "production") {
        await starter.command(["npm", "run", "build"]);
        sessionPath = await starter.sessionPath();
      }
      starter.spawn(["node", mode === "production" ? ".output/server/index.mjs" : "src/dev.ts"], {
        BETTER_AUTH_URL: `http://localhost:${number}`,
        PORT: String(number),
        NODE_ENV: mode,
      });
      const sessionRead = (headers: Record<string, string>) =>
        fetch(
          `http://127.0.0.1:${number}${sessionPath}?args=${encodeURIComponent(
            JSON.stringify([{ method: "POST", context: {} }]),
          )}`,
          {
            method: "POST",
            headers,
            redirect: "manual",
          },
        );
      await eventually(
        () => fetch(`http://127.0.0.1:${number}/health`).catch(() => null),
        (value) => value?.ok === true,
        "Starter server unavailable",
      );
      if (mode === "development") {
        const source = await fetch(
          `http://127.0.0.1:${number}/src/server-functions/session.ts`,
        ).then((response) => response.text());
        const id = source.match(/createClientRpc\("([^"]+)"\)/)?.[1];
        expect(id, source).toBeDefined();
        sessionPath = `/_server/data/${id}`;
      }
      const headers = {
        "x-forwarded-host": host,
        "x-forwarded-proto": "http",
        "x-forwarded-prefix": prefix,
        origin: `http://${host}`,
      };
      expect((await fetch(`http://127.0.0.1:${number}/`)).status).toBe(200);
      // The isolated coding browser dials the declared loopback App target and
      // rewrites Origin to that exact target, not the human runtime hostname.
      const nativeOrigin = `http://127.0.0.1:${number}`;
      const nativeSignup = await fetch(`${nativeOrigin}/api/auth/sign-up/email`, {
        method: "POST",
        headers: {
          origin: nativeOrigin,
          "content-type": "application/json",
          "x-forwarded-for": "192.0.2.10",
        },
        body: JSON.stringify({
          name: "Native browser member",
          email: `native-${id}@starter.test`,
          password: crypto.randomUUID(),
        }),
      });
      expect(nativeSignup.status).toBe(200);
      const nativeCookie = nativeSignup.headers
        .getSetCookie()
        .map((value) => value.split(";")[0])
        .join("; ");
      expect((await sessionRead({ origin: nativeOrigin, cookie: nativeCookie })).status).toBe(200);
      expect((await fetch(`${nativeOrigin}/api/session`)).status).toBe(404);
      for (const origin of [
        "https://foreign.example",
        `http://127.0.0.1:${number === 4300 ? 4301 : 4300}`,
      ]) {
        const rejected = await fetch(`${nativeOrigin}/api/auth/sign-up/email`, {
          method: "POST",
          headers: {
            origin,
            "content-type": "application/json",
            "x-forwarded-for": "192.0.2.12",
          },
          body: JSON.stringify({
            name: "Rejected origin",
            email: `${crypto.randomUUID()}@starter.test`,
            password: crypto.randomUUID(),
          }),
        });
        expect(rejected.status).toBe(403);
        expect((await sessionRead({ origin, cookie: nativeCookie })).status).toBe(403);
      }
      const html = await fetch(`http://127.0.0.1:${number}/`, { headers }).then((r) => r.text());
      expect(html).toContain(`<base href="${prefix}/">`);
      if (mode === "development")
        expect(html).toContain(`${prefix}/@id/virtual:tanstack-start-dev-client-entry`);
      else {
        expect(html).not.toContain("@vite/client");
        expect(html).toContain(`src="${prefix}/assets/`);
      }
      if (mode === "development") {
        const client = await fetch(`http://127.0.0.1:${number}/@vite/client`, { headers }).then(
          (r) => r.text(),
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
      }
      const signup = await fetch(`http://127.0.0.1:${number}/api/auth/sign-up/email`, {
        method: "POST",
        // This API fixture is a different client from the browser journeys.
        headers: {
          ...headers,
          "content-type": "application/json",
          "x-forwarded-for": "192.0.2.11",
        },
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
      const session = await sessionRead({ ...headers, cookie });
      expect(session.status).toBe(200);
      expect(session.headers.get("cache-control")).toBe("no-store");
      expect(await session.json()).toMatchObject({ result: { name: "App user" } });
      expect(await (await sessionRead(headers)).json()).toMatchObject({ result: null });
      const assetPaths: string[] = [];
      proxy = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        async fetch(request) {
          const url = new URL(request.url);
          if (
            ["127.0.0.1", "localhost"].includes(url.hostname) &&
            url.pathname === "/factory-shell"
          ) {
            return new Response(
              `<h1>Factory shell</h1><iframe title="Starter preview" width="100%" height="680" src="http://${id.replaceAll("-", "")}-app.runtime.localhost:${url.port}${prefix}/"></iframe>`,
              { headers: { "content-type": "text/html" } },
            );
          }
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
      if (mode === "development") {
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
      }
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      page.on("response", (response) => {
        const expectedMissingRoute =
          response.status() === 404 && new URL(response.url()).pathname === `${prefix}/missing`;
        if (response.status() >= 400 && !expectedMissingRoute)
          errors.push(`HTTP ${response.status()} ${response.url()}`);
      });
      const appURL = `http://${id.replaceAll("-", "")}-app.runtime.localhost:${proxy.port}${prefix}/`;
      await page.goto(appURL);
      async function navigateHome() {
        const missing = await page.goto(`${appURL}missing`);
        expect(missing?.status()).toBe(404);
        await visible(page.getByRole("heading", { name: "Page not found" })).toBeVisible();
        await visible(page.getByRole("link", { name: "Go home" })).toHaveAttribute(
          "href",
          `${prefix}/`,
        );
        await page.evaluate(() => {
          document.documentElement.dataset["navigationProof"] = "same-document";
        });
        await page.getByRole("link", { name: "Go home" }).click();
        expect(await page.evaluate(() => document.documentElement.dataset["navigationProof"])).toBe(
          "same-document",
        );
      }
      if (mode === "development") {
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
      }
      const pageRequests: string[] = [];
      page.on("request", (request) => pageRequests.push(new URL(request.url()).pathname));
      const directEmail = `${crypto.randomUUID()}@starter.test`;
      const directPassword = crypto.randomUUID();
      await page.getByRole("button", { name: "Create an account", exact: true }).click();
      await page.getByLabel("Name", { exact: true }).fill("Browser app user");
      await page.getByLabel("Email", { exact: true }).fill(directEmail);
      await page.getByLabel("Password", { exact: true }).fill(directPassword);
      const signupGate = Promise.withResolvers<void>();
      releaseRequests.push(signupGate.resolve);
      let signups = 0;
      await page.route("**/api/auth/sign-up/email", async (route) => {
        signups++;
        await signupGate.promise;
        await route.continue();
      });
      // Two events in one JS turn precede Solid 2's batched DOM update.
      await page.locator("form").evaluate((element) => {
        const form = element as HTMLFormElement;
        form.requestSubmit();
        form.requestSubmit();
      });
      await visible(page.getByRole("button", { name: "Please wait…" })).toBeDisabled();
      await visible(page.getByLabel("Email", { exact: true })).toBeDisabled();
      await visible.poll(() => signups).toBe(1);
      await page.screenshot({ path: resolve(screenshots, "signup-pending.png") });
      signupGate.resolve();
      await visible(page.getByRole("heading", { name: "You're home." })).toBeVisible();
      expect(signups).toBe(1);
      await page.unroute("**/api/auth/sign-up/email");
      const signoutGate = Promise.withResolvers<void>();
      releaseRequests.push(signoutGate.resolve);
      let signouts = 0;
      await page.route("**/api/auth/sign-out", async (route) => {
        signouts++;
        await signoutGate.promise;
        await route.continue();
      });
      await page.getByRole("button", { name: "Sign out", exact: true }).evaluate((element) => {
        const button = element as HTMLButtonElement;
        button.click();
        button.click();
      });
      await visible(page.getByRole("button", { name: "Signing out…" })).toBeDisabled();
      await visible.poll(() => signouts).toBe(1);
      signoutGate.resolve();
      await visible(page.getByRole("heading", { name: "Welcome back", exact: true })).toBeVisible();
      expect(signouts).toBe(1);
      await page.unroute("**/api/auth/sign-out");
      await page.screenshot({
        path: resolve(screenshots, "immediate-signout-signin.png"),
        animations: "disabled",
      });
      await page.getByLabel("Email", { exact: true }).fill(directEmail);
      await page.getByLabel("Password", { exact: true }).fill(directPassword);
      await page.getByRole("button", { name: "Sign in", exact: true }).click();
      await visible(page.getByRole("heading", { name: "You're home." })).toBeVisible();
      await page.reload();
      await visible(page.getByRole("heading", { name: "You're home." })).toBeVisible();
      await page.screenshot({
        path: resolve(screenshots, "home.png"),
        animations: "disabled",
      });
      await page.getByRole("button", { name: "Sign out", exact: true }).click();
      await visible(page.getByRole("button", { name: "Sign in", exact: true })).toBeVisible();
      expect(pageRequests.some((path) => path.startsWith(`${prefix}/_server/`))).toBe(true);
      expect(pageRequests.some((path) => path.endsWith("/api/session"))).toBe(false);

      // A pending read belongs to Loading, not a null/undefined session sentinel.
      const { promise: paused, resolve: resume } = Promise.withResolvers<void>();
      releaseRequests.push(resume);
      await page.route("**/_server/**", async (route) => {
        await paused;
        await route.continue();
      });
      await navigateHome();
      await visible(page.getByRole("status")).toHaveText("Loading…");
      await page.screenshot({ path: resolve(screenshots, "session-loading.png") });
      resume();
      await visible(page.getByRole("heading", { name: "Welcome back", exact: true })).toBeVisible();
      await page.unroute("**/_server/**");

      // A failed read stays an error. Retrying it never resends credentials.
      let authWrites = 0;
      page.on("request", (request) => {
        if (new URL(request.url()).pathname.includes("/api/auth/") && request.method() === "POST")
          authWrites++;
      });
      await page.route("**/_server/**", (route) => route.abort("failed"));
      await navigateHome();
      await visible(
        page.getByRole("heading", { name: "Could not load your session" }),
      ).toBeVisible();
      await page.screenshot({ path: resolve(screenshots, "session-error.png") });
      await page.unroute("**/_server/**");
      await page.getByRole("button", { name: "Try again", exact: true }).click();
      await visible(page.getByRole("heading", { name: "Welcome back", exact: true })).toBeVisible();
      expect(authWrites).toBe(0);

      const beforeSignIn = authWrites;
      await page.route("**/_server/**", (route) => route.abort("failed"));
      await page.getByLabel("Email", { exact: true }).fill(directEmail);
      await page.getByLabel("Password", { exact: true }).fill(directPassword);
      await page.getByRole("button", { name: "Sign in", exact: true }).click();
      await visible(
        page.getByRole("heading", { name: "Could not load your session" }),
      ).toBeVisible();
      expect(authWrites - beforeSignIn).toBe(1);
      await page.unroute("**/_server/**");
      await page.getByRole("button", { name: "Try again", exact: true }).click();
      await visible(page.getByRole("heading", { name: "You're home." })).toBeVisible();
      expect(authWrites - beforeSignIn).toBe(1);
      await page.route("**/api/auth/sign-out", (route) => route.abort("failed"));
      await page.getByRole("button", { name: "Sign out", exact: true }).click();
      await visible(page.getByRole("alert")).toContainText("Could not sign out");
      await visible(page.getByRole("heading", { name: "You're home." })).toBeVisible();
      await page.screenshot({ path: resolve(screenshots, "signout-error.png") });
      await page.unroute("**/api/auth/sign-out");
      await page.getByRole("button", { name: "Sign out", exact: true }).click();
      await visible(page.getByRole("heading", { name: "Welcome back", exact: true })).toBeVisible();
      await page.setViewportSize({ width: 390, height: 844 });
      await page.screenshot({ path: resolve(screenshots, "signin-narrow.png") });

      const embeddedContext = await browser.newContext({ viewport: { width: 1280, height: 800 } });
      const embedded = await embeddedContext.newPage();
      await embedded.goto(`http://127.0.0.1:${proxy.port}/factory-shell`);
      const app = embedded.frameLocator('iframe[title="Starter preview"]');
      await app.getByRole("button", { name: "Create an account", exact: true }).click();
      await app.getByLabel("Name", { exact: true }).fill("Embedded app user");
      await app.getByLabel("Email", { exact: true }).fill(`${crypto.randomUUID()}@starter.test`);
      await app.getByLabel("Password", { exact: true }).fill(crypto.randomUUID());
      await app.getByRole("button", { name: "Create account", exact: true }).click();
      await visible(app.getByRole("heading", { name: "You're home." })).toBeVisible({
        timeout: 5000,
      });
      await embedded.reload();
      await visible(app.getByRole("heading", { name: "You're home." })).toBeVisible();
      await embedded.screenshot({
        path: resolve(screenshots, "embedded-home.png"),
        animations: "disabled",
      });

      // Another top-level site must not inherit the embedded App session, even
      // though both pages use the same browser cookie jar and exact App origin.
      const otherShell = await embeddedContext.newPage();
      await otherShell.goto(`http://localhost:${proxy.port}/factory-shell`);
      await visible(
        otherShell
          .frameLocator('iframe[title="Starter preview"]')
          .getByRole("heading", { name: "Welcome back", exact: true }),
      ).toBeVisible();
      await otherShell.close();

      await app.getByRole("button", { name: "Sign out", exact: true }).click();
      await visible(app.getByRole("button", { name: "Sign in", exact: true })).toBeVisible();
      await embeddedContext.close();
      expect(errors).toEqual([]);
      expect(assetPaths.filter((path) => !path.startsWith(`${prefix}/`))).toEqual([]);
    } finally {
      for (const release of releaseRequests) release();
      await browser?.close();
      await proxy?.stop(true);
      await starter.dispose();
    }
  },
  60_000,
);
