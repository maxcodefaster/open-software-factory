import { expect, test } from "bun:test";
import { chromium } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { z } from "zod";
import { createForgejoAccess, forgeUsername } from "../../packages/forge/src/access";
import { createForgejoClient } from "../../packages/forge/src/forge";
import { createForgeAccessReconciliation } from "../../apps/factory/src/access/forge";
import { ensureLocalForgeIdentity } from "../../scripts/factory/forge-identity";
import { installForgeBrowserLogout } from "../../scripts/factory/forge-logout";
import { eventually, factoryProcess } from "../fixtures/factory-process";

test("pinned Forgejo recovers passwordless identity creation and confirms private grants and exact branch writers", async () => {
  const id = crypto.randomUUID();
  const container = `factory-owned-access-forge-${id}`;
  let created = false;
  let discovery: ReturnType<typeof Bun.serve> | undefined;
  const fixture = await factoryProcess();
  const database = fixture.connect();
  let wiredFactory: Awaited<ReturnType<typeof factoryProcess>> | undefined;
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  let checkout: string | undefined;
  let helperListener: ReturnType<typeof Bun.serve> | undefined;
  const listener = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response(null) });
  const forgePort = listener.port;
  await listener.stop(true);
  const origin = `http://127.0.0.1:${forgePort}`;
  async function command(args: string[]) {
    const child = Bun.spawn(args, { stdout: "pipe", stderr: "ignore" });
    const output = await new Response(child.stdout).text();
    if ((await child.exited) !== 0)
      throw new Error(`Owned Forge operation ${args[0]} failed. Sensitive output suppressed.`);
    return output.trim();
  }
  try {
    await command([
      "docker",
      "run",
      "--detach",
      "--name",
      container,
      "--label",
      `factory.owned-access=${id}`,
      "--volume",
      "/var/lib/gitea",
      "--volume",
      "/etc/gitea",
      "--env",
      "FORGEJO__security__INSTALL_LOCK=true",
      "--env",
      "FORGEJO__database__DB_TYPE=sqlite3",
      "--env",
      "FORGEJO__service__DISABLE_REGISTRATION=true",
      "--env",
      `FORGEJO__server__ROOT_URL=${origin}/`,
      "--env",
      "FORGEJO__oauth2_client__ACCOUNT_LINKING=disabled",
      "--env",
      "FORGEJO__oauth2_client__ENABLE_AUTO_REGISTRATION=false",
      "--env",
      "FORGEJO__oauth2__DEFAULT_APPLICATIONS=git-credential-oauth",
      "--publish",
      `127.0.0.1:${forgePort}:3000`,
      "codeberg.org/forgejo/forgejo:15.0.10-rootless@sha256:6ffebd9ab9ee9f6677e3523fa60debd9de630ff2a226fa681d6cc0c7ba541d77",
    ]);
    created = true;
    await eventually(
      () => fetch(`${origin}/api/healthz`).catch(() => undefined),
      (r) => r?.ok === true,
      "Owned Forge unavailable",
      30_000,
    );
    await command([
      "docker",
      "exec",
      container,
      "forgejo",
      "admin",
      "user",
      "create",
      "--username",
      "factory-control",
      "--random-password",
      "--email",
      "control@factory.invalid",
      "--admin",
      "--must-change-password=false",
    ]);
    const token = await command([
      "docker",
      "exec",
      container,
      "forgejo",
      "admin",
      "user",
      "generate-access-token",
      "--username",
      "factory-control",
      "--token-name",
      "owned-access",
      "--scopes",
      "all",
      "--raw",
    ]);
    discovery = Bun.serve({
      hostname: "0.0.0.0",
      port: 0,
      fetch(request) {
        const root = `http://host.orb.internal:${discovery?.port}`;
        return Response.json(
          new URL(request.url).pathname.endsWith("jwks")
            ? { keys: [] }
            : {
                issuer: root,
                authorization_endpoint: `${root}/authorize`,
                token_endpoint: `${root}/token`,
                jwks_uri: `${root}/jwks`,
                userinfo_endpoint: `${root}/userinfo`,
                response_types_supported: ["code"],
                subject_types_supported: ["public"],
                id_token_signing_alg_values_supported: ["RS256"],
              },
        );
      },
    });
    await command([
      "docker",
      "exec",
      container,
      "forgejo",
      "admin",
      "auth",
      "add-oauth",
      "--name",
      "Factory",
      "--provider",
      "openidConnect",
      "--key",
      "factory-forgejo",
      "--secret",
      "owned-test-only-client-secret",
      "--auto-discover-url",
      `http://host.orb.internal:${discovery.port}/.well-known/openid-configuration`,
    ]);
    const listing = await command([
      "docker",
      "exec",
      container,
      "forgejo",
      "admin",
      "auth",
      "list",
    ]);
    const sourceID = Number(
      listing
        .split("\n")
        .find((line) => line.includes("Factory"))
        ?.trim()
        .split(/\s+/)[0],
    );
    expect(sourceID).toBeGreaterThan(0);
    const apiURL = `${origin}/api/v1/`;
    let lost = false;
    const access = createForgejoAccess({
      apiURL,
      token,
      async fetch(input, init) {
        const result = await fetch(input, init);
        if (
          !lost &&
          init?.method === "POST" &&
          String(input).endsWith("admin/users") &&
          result.ok
        ) {
          lost = true;
          await result.body?.cancel();
          throw new DOMException("Owned lost account response", "AbortError");
        }
        return result;
      },
    });
    const input = {
      userID: id,
      sourceID,
      email: `${id}@factory.invalid`,
      name: "Owned developer",
      enabled: true,
    };
    const accountID = await access.ensureAccount(input);
    expect(lost).toBe(true);
    expect(accountID).toBeGreaterThan(0);
    expect(await access.ensureAccount(input)).toBe(accountID);
    await expect(access.ensureAccount({ ...input, sourceID: sourceID + 1 })).rejects.toThrow(
      "identity differs",
    );
    const forge = createForgejoClient({ apiURL, token });
    const repository = { owner: "factory-control", name: "owned-product" };
    await forge.createSetupRepository({ repository, setupID: id });
    await forge.createSetupFiles({
      repository,
      setupID: id,
      branch: "main",
      files: [{ path: "README.md", content: "# Owned product\n" }],
    });
    const foreign = { owner: repository.owner, name: "owned-unregistered" };
    await forge.createSetupRepository({ repository: foreign, setupID: crypto.randomUUID() });
    await access.repositoryGrant(foreign.owner, foreign.name, id, true);
    await access.removeAlternativeGrants(id);
    // A separate native collaborator grant cannot bypass Factory Project membership.
    await access.repositoryGrant(foreign.owner, foreign.name, id, false);
    await database.client`INSERT INTO auth."user"(id,name,email) VALUES(${id},'Owned developer',${input.email})`;
    await database.client`INSERT INTO factory.project(id,slug,name,repository_url,default_branch,devcontainer_path,created_by)
      VALUES(${id},${repository.name},'Owned product',${`${origin}/${repository.owner}/${repository.name}`},'main','.devcontainer/devcontainer.json',${id})`;
    await database.client`INSERT INTO factory.project_membership(project_id,user_id,role,updated_by) VALUES(${id},${id},'developer',${id})`;
    await database.client`INSERT INTO factory.forge_connection(source_name,discovery_url,redirect_uri,source_id,state,intended_by)
      VALUES('Factory',${`http://host.orb.internal:${discovery.port}/.well-known/openid-configuration`},${`${origin}/user/oauth2/Factory/callback`},${sourceID},'ready',${id})`;
    const reconcile = createForgeAccessReconciliation({
      database,
      forge: access,
      owner: repository.owner,
    });
    await reconcile.reconcile(id);
    // Both clone URL spellings identify the same exact Factory-owned repository.
    await database.client`UPDATE factory.project SET repository_url=${`${origin}/${repository.owner}/${repository.name}.git`} WHERE id=${id}`;
    await reconcile.reconcile(id);
    expect(
      (
        await database.client`SELECT state FROM factory.forge_account_intent WHERE user_id=${id}`
      )[0]?.["state"],
    ).toBe("ready");
    expect(
      (
        await database.client`SELECT confirmed FROM factory.forge_grant_intent WHERE user_id=${id}`
      )[0]?.["confirmed"],
    ).toBe(true);
    await access.repositoryGrant(repository.owner, repository.name, id, true);
    await access.protectBranch({
      ...repository,
      repository: repository.name,
      branch: "main",
      writers: [],
      merger: repository.owner,
    });
    const branch = "factory/owned-change";
    await forge.ensureBranch(
      repository,
      branch,
      (await forge.getDefaultBranch(repository)).headSha,
    );
    await access.protectBranch({
      owner: repository.owner,
      repository: repository.name,
      branch,
      writers: [forgeUsername(id)],
      merger: repository.owner,
    });
    await access.protectBranch({
      owner: repository.owner,
      repository: repository.name,
      branch,
      writers: [],
      merger: repository.owner,
    });
    await access.removeAlternativeGrants(id);
    await access.repositoryGrant(repository.owner, repository.name, id, false);
    await access.ensureAccount({ ...input, enabled: false });
    expect(await access.readAccount(forgeUsername(id))).toMatchObject({
      active: false,
      prohibit_login: true,
      is_admin: false,
    });
    await database.client`UPDATE factory.project_membership SET role='product-contributor' WHERE user_id=${id}`;
    await reconcile.reconcile(id);
    expect(
      (
        await database.client`SELECT state FROM factory.forge_account_intent WHERE user_id=${id}`
      )[0]?.["state"],
    ).toBe("disabled");
    expect(
      (
        await database.client`SELECT confirmed FROM factory.forge_grant_intent WHERE user_id=${id}`
      )[0]?.["confirmed"],
    ).toBe(false);
    wiredFactory = await factoryProcess(undefined, {
      FACTORY_FORGEJO_API_URL: apiURL,
      FACTORY_FORGEJO_OWNER: repository.owner,
      FACTORY_FORGEJO_ADMIN_TOKEN: token,
    });
    await wiredFactory.start();
    let reloads = 0;
    const wiring = {
      factoryURL: wiredFactory.base,
      forgeURL: origin,
      discoveryURL: `http://host.orb.internal:${new URL(wiredFactory.base).port}/api/auth/.well-known/openid-configuration`,
      email: `owned-${wiredFactory.id}@factory.local`,
      password: "owned-process-password-not-a-secret",
      signingKey: "owned-process-auth-secret-not-a-production-credential",
      execute: (args: string[]) => command(["docker", "exec", container, "forgejo", ...args]),
      installLogout: () =>
        installForgeBrowserLogout({
          factoryURL: wiredFactory!.base,
          execute: (args) => command(["docker", "exec", container, ...args]),
          copy: (source, destination) =>
            command(["docker", "cp", source, `${container}:${destination}`]),
        }),
      reload: async () => {
        reloads++;
        await command(["docker", "restart", container]);
        await eventually(
          () => fetch(`${origin}/api/healthz`).catch(() => undefined),
          (r) => r?.ok === true,
          "Owned Forge reload unavailable",
          30_000,
        );
      },
    };
    const identity = await ensureLocalForgeIdentity(wiring);
    expect(reloads).toBe(1);
    expect(
      await ensureLocalForgeIdentity({ ...wiring, retainedSourceID: identity.sourceID }),
    ).toEqual(identity);
    expect(reloads).toBe(1);
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(wiring.factoryURL);
    await page.evaluate(
      async ({ factoryURL, email, password }) => {
        const response = await fetch(`${factoryURL}/api/auth/sign-in/email`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ email, password }),
        });
        if (!response.ok) throw new Error("Owned login failed");
      },
      { factoryURL: wiring.factoryURL, email: wiring.email, password: wiring.password },
    );
    await page.goto(`${origin}/user/oauth2/Factory`);
    await page.waitForURL((url) => url.origin === origin && url.pathname === "/", {
      timeout: 15_000,
    });
    const nativeUsername = forgeUsername("01994a7d-0000-7000-8000-000000000001");
    expect(await page.locator("body").innerText()).toContain(nativeUsername);
    const callbackResult = Promise.withResolvers<URL>();
    helperListener = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
        callbackResult.resolve(new URL(request.url));
        return new Response("Owned helper callback", { headers: { "content-type": "text/html" } });
      },
    });
    const helperCallback = `http://127.0.0.1:${helperListener.port}/`;
    const verifier = crypto.randomUUID() + crypto.randomUUID();
    const authorization = new URL(`${origin}/login/oauth/authorize`);
    for (const [key, value] of Object.entries({
      client_id: "a4792ccc-144e-407e-86c9-5e7d8d9c3269",
      redirect_uri: helperCallback,
      response_type: "code",
      state: "owned-helper-state",
      code_challenge_method: "S256",
      code_challenge: new Bun.CryptoHasher("sha256").update(verifier).digest("base64url"),
    }))
      authorization.searchParams.set(key, value);
    const callbackTimeout = setTimeout(
      () => callbackResult.reject(new Error("Native helper callback missing")),
      10_000,
    );
    await page.goto(authorization.href);
    await page.locator("#authorize-app").click();
    const helperResult = await callbackResult.promise;
    clearTimeout(callbackTimeout);
    expect(helperResult.searchParams.get("state")).toBe("owned-helper-state");
    const exchange = await fetch(`${origin}/login/oauth/access_token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: "a4792ccc-144e-407e-86c9-5e7d8d9c3269",
        grant_type: "authorization_code",
        redirect_uri: helperCallback,
        code: helperResult.searchParams.get("code") ?? "",
        code_verifier: verifier,
      }),
    });
    expect(exchange.status).toBe(200);
    const helperToken = z
      .object({ access_token: z.string() })
      .parse(await exchange.json()).access_token;
    const nativeAuth = {
      authorization: `Basic ${Buffer.from(`${nativeUsername}:${helperToken}`).toString("base64")}`,
    };
    expect((await fetch(`${apiURL}user`, { headers: nativeAuth })).status).toBe(200);
    await page.goto(`${origin}/user/login`);
    expect(
      await page.evaluate(async () => new URL((await fetch("/user/settings")).url).pathname),
    ).toBe("/user/settings");
    // Leave the native page before logout to avoid its logout SSE navigation.
    await page.goto(`${origin}/assets/factory-sign-out.html`);
    await page.waitForURL(wiring.factoryURL, { timeout: 10_000 });
    await page.goto(`${origin}/user/login`);
    const nativeSession = await page.evaluate(async () => {
      const response = await fetch("/user/settings", { redirect: "follow" });
      return new URL(response.url).pathname;
    });
    expect(nativeSession).toBe("/user/login");
    expect((await fetch(`${apiURL}user`, { headers: nativeAuth })).status).toBe(200);
    await access.repositoryGrant(
      repository.owner,
      repository.name,
      "01994a7d-0000-7000-8000-000000000001",
      true,
    );
    checkout = await mkdtemp(join(tmpdir(), "factory-owned-native-git-"));
    async function git(args: string[]) {
      if (!checkout) throw new Error("Owned checkout is unavailable");
      const child = Bun.spawn(["git", ...args], {
        cwd: checkout,
        env: {
          ...process.env,
          GIT_TERMINAL_PROMPT: "0",
          GIT_CONFIG_COUNT: "1",
          GIT_CONFIG_KEY_0: "http.extraHeader",
          GIT_CONFIG_VALUE_0: nativeAuth.authorization.replace("Basic ", "Authorization: Basic "),
        },
        stdout: "ignore",
        stderr: "ignore",
      });
      return child.exited;
    }
    expect(await git(["clone", `${origin}/${repository.owner}/${repository.name}.git`, "."])).toBe(
      0,
    );
    expect(
      await git([
        "-c",
        "user.name=Owned developer",
        "-c",
        "user.email=owned@factory.invalid",
        "commit",
        "--allow-empty",
        "-m",
        "Owned human edit",
      ]),
    ).toBe(0);
    expect(await git(["push", "origin", "HEAD:main"])).not.toBe(0);
    await access.protectBranch({
      owner: repository.owner,
      repository: repository.name,
      branch,
      writers: [nativeUsername],
      merger: repository.owner,
    });
    expect(await git(["push", "origin", `HEAD:${branch}`])).toBe(0);
    await access.protectBranch({
      owner: repository.owner,
      repository: repository.name,
      branch,
      writers: [],
      merger: repository.owner,
    });
    expect(
      await git([
        "-c",
        "user.name=Owned developer",
        "-c",
        "user.email=owned@factory.invalid",
        "commit",
        "--allow-empty",
        "-m",
        "Owned fenced edit",
      ]),
    ).toBe(0);
    expect(await git(["push", "origin", `HEAD:${branch}`])).not.toBe(0);
    await access.ensureAccount({
      userID: "01994a7d-0000-7000-8000-000000000001",
      sourceID,
      email: wiring.email,
      name: "Owned system manager",
      enabled: false,
      suspended: true,
    });
    expect(await git(["ls-remote", "origin"])).not.toBe(0);
    const wiredDatabase = wiredFactory.connect();
    try {
      expect(
        await wiredDatabase.client`SELECT id FROM factory.forge_connection WHERE state='ready'`,
      ).toHaveLength(1);
      expect(await wiredDatabase.client`SELECT "clientId" FROM auth."oauthClient"`).toHaveLength(1);
      expect(
        await wiredDatabase.client`SELECT username FROM factory.forge_account_intent WHERE state='ready'`,
      ).toHaveLength(1);
    } finally {
      await wiredDatabase.client.end();
    }
  } finally {
    await browser?.close();
    await helperListener?.stop(true);
    if (checkout) await rm(checkout, { recursive: true, force: true });
    await wiredFactory?.dispose();
    await discovery?.stop(true);
    if (created) {
      const owner = await command([
        "docker",
        "inspect",
        "--format",
        '{{index .Config.Labels "factory.owned-access"}}',
        container,
      ]);
      expect(owner).toBe(id);
      await command(["docker", "rm", "--force", "--volumes", container]);
    }
    await database.client.end();
    await fixture.dispose();
  }
}, 90_000);
