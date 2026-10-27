import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { type Browser, chromium, expect, type Page } from "@playwright/test";
import { z } from "zod";
import { developerIDEOrigin } from "../../apps/factory/src/developer-ide-origin";
import { serverCall } from "../../apps/factory/src/server-functions/result";
import { developerIDEIdentity } from "../../packages/workspace-domain/src/developer-ide";
import { editorFixtureKubectl } from "./editor-source-resources";
import { eventually, type factoryProcess } from "./factory-process";
import { callFactoryFunction } from "./server-functions";

type Factory = Awaited<ReturnType<typeof factoryProcess>>;
const editorState = z.object({
  state: z.string(),
  epoch: z.number(),
  failure: z.string().nullable(),
});

// Real isolated Theia, authenticated Factory routes and native compute. Only
// the outer embedding page is a fixture; it sends the shipped selection message.
export async function automaticIDE(input: {
  factory: Factory;
  projectID: string;
  workspaceID: string;
  userID: string;
  cookie: string;
  artifacts: string;
  expectedPausedAttemptID?: string;
}) {
  const { factory, projectID, workspaceID, userID, cookie, artifacts } = input;
  const authorization = { cookie, origin: factory.base };
  const readEditor = () =>
    serverCall(callFactoryFunction(factory.base, "getDeveloperIDE", [], authorization));
  let browser: Browser | undefined;
  let page: Page | undefined;
  try {
    await serverCall(
      callFactoryFunction(factory.base, "ensureDeveloperIDE", [projectID], authorization),
    );
    const editor = await eventually(
      async () => {
        const current = editorState.parse(await readEditor());
        if (["failed", "stopped", "stop-intended"].includes(current.state))
          throw new Error(current.failure ?? "Owned IDE became unavailable");
        return current;
      },
      (current) => current.state === "ready",
      "Owned IDE did not become ready",
      120_000,
    );
    const database = factory.connect();
    try {
      const attempts = await database.client<
        Array<{ id: string; state: string }>
      >`SELECT id,state FROM factory.runtime_attempt WHERE workspace_id=${workspaceID}`;
      expect(attempts).toEqual(
        input.expectedPausedAttemptID
          ? [{ id: input.expectedPausedAttemptID, state: "paused" }]
          : [],
      );
    } finally {
      await database.client.end({ timeout: 2 });
    }
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ viewport: { width: 1440, height: 950 } });
    await context.addCookies(
      cookie.split(";").map((part) => {
        const pair = part.trim();
        const equals = pair.indexOf("=");
        return { name: pair.slice(0, equals), value: pair.slice(equals + 1), url: factory.base };
      }),
    );
    page = await context.newPage();
    const selectedPage = page;
    const origin = developerIDEOrigin(factory.base, userID, editor.epoch);
    const document = `<!doctype html><title>Owned Factory IDE proof</title>
<style>html,body{margin:0;height:100%}iframe{width:100%;height:100%;border:0}</style>
<script>addEventListener("message",event=>{
const frame=document.querySelector("iframe");
if(event.source!==frame.contentWindow||event.origin!==${JSON.stringify(origin)})return;
if(event.data?.type==="factory:ide-ready")frame.contentWindow.postMessage({type:"factory:select-workspace",workspaceID:${JSON.stringify(workspaceID)}},event.origin);
if(event.data?.type==="factory:workspace-selected")frame.dataset.workspaceId=event.data.workspaceID;
});</script>
<iframe title="Factory IDE" src="/api/developer-ide/access?embed=1&epoch=${editor.epoch}"></iframe>`;
    const started = performance.now();
    // Keep the real loopback response's network policy. A fulfilled synthetic
    // top-level response makes Chromium refuse the isolated localhost frame.
    await page.goto(`${factory.base}/health/ready`);
    await page.setContent(document);
    const frame = page.frameLocator('iframe[title="Factory IDE"]');
    await expect(frame.locator("#theia-app-shell")).toBeVisible({ timeout: 120_000 });
    await expect(page.locator("iframe")).toHaveAttribute("data-workspace-id", workspaceID, {
      timeout: 60_000,
    });
    const selectedMS = Math.round(performance.now() - started);
    const result = {
      page,
      selectedMS,
      async terminal(label: string) {
        await frame.locator(".lm-TabBar-tab").filter({ hasText: "Terminal" }).click();
        const host = frame.locator(".factory-terminal-host:not([hidden])");
        if ((await host.count()) === 0) {
          const add = frame.getByRole("button", { name: "New terminal", exact: true });
          await expect(add).toBeEnabled({ timeout: 420_000 });
          if ((await host.count()) === 0) await add.click();
        }
        await expect(host).toHaveAttribute("data-connection-state", "connected", {
          timeout: 420_000,
        });
        await host.locator(".xterm").click();
        await selectedPage.keyboard.type(`printf 'automatic-${label}='; pwd`);
        await selectedPage.keyboard.press("Enter");
        await expect(host.locator(".xterm-rows")).toContainText(
          `automatic-${label}=/workspace/project`,
          { timeout: 30_000 },
        );
        await selectedPage.screenshot({ path: resolve(artifacts, `automatic-ide-${label}.png`) });
      },
      async closeTerminals() {
        const close = frame.locator(".factory-terminal-close");
        while ((await close.count()) > 0) {
          const count = await close.count();
          await close.first().click();
          await expect(close).toHaveCount(count - 1);
        }
        await expect(frame.locator(".factory-terminal-host")).toHaveCount(0);
      },
      async close() {
        await browser?.close();
        browser = undefined;
      },
    };
    return result;
  } catch (cause) {
    if (page)
      await page
        .screenshot({ path: resolve(artifacts, "automatic-ide-failure.png") })
        .catch(() => {});
    await writeFile(
      resolve(artifacts, "automatic-ide-failure.json"),
      JSON.stringify({ error: cause instanceof Error ? cause.message : "Owned IDE proof failed" }),
      { mode: 0o600 },
    );
    await browser?.close();
    throw cause;
  }
}

export async function stopAutomaticIDE(
  factory: Factory,
  userID: string,
  cookie: string,
  artifacts: string,
) {
  const authorization = { cookie, origin: factory.base };
  await serverCall(callFactoryFunction(factory.base, "stopDeveloperIDE", [], authorization));
  await eventually(
    async () =>
      editorState.parse(
        await serverCall(callFactoryFunction(factory.base, "getDeveloperIDE", [], authorization)),
      ),
    (current) => current.state === "stopped",
    "Owned IDE did not Stop",
    120_000,
  );
  const database = factory.connect();
  try {
    const [editor] = await database.client<
      Array<{ resourceID: string; epoch: number; namespaceUID: string | null }>
    >`SELECT resource_id AS "resourceID",service_epoch::float8 AS epoch,
        namespace_uid AS "namespaceUID" FROM factory.developer_ide WHERE user_id=${userID} AND state='stopped'`;
    if (!editor?.namespaceUID) return;
    const identity = developerIDEIdentity(userID, editor.epoch, editor.resourceID);
    const read = async () => {
      const raw = await editorFixtureKubectl([
        "get",
        "namespace",
        identity.namespace,
        "--ignore-not-found",
        "-o",
        "json",
      ]);
      return raw.trim()
        ? z
            .object({
              metadata: z.object({ uid: z.string(), labels: z.record(z.string(), z.string()) }),
            })
            .parse(JSON.parse(raw)).metadata
        : null;
    };
    const namespace = await read();
    if (!namespace) return;
    expect(namespace.uid).toBe(editor.namespaceUID);
    expect(namespace.labels).toMatchObject({
      "app.kubernetes.io/managed-by": "open-software-factory",
      "factory.dev/runtime-owner": userID,
    });
    const resources = z
      .object({
        items: z.array(z.object({ kind: z.string(), metadata: z.object({ name: z.string() }) })),
      })
      .parse(
        JSON.parse(
          await editorFixtureKubectl([
            "get",
            "all,pvc,secret,cm,serviceaccounts,networkpolicies",
            "-n",
            identity.namespace,
            "-o",
            "json",
          ]),
        ),
      );
    for (const resource of resources.items)
      expect(["ConfigMap/kube-root-ca.crt", "ServiceAccount/default"]).toContain(
        `${resource.kind}/${resource.metadata.name}`,
      );
    await writeFile(
      resolve(artifacts, "automatic-ide-cleanup-intent.json"),
      JSON.stringify({ identity, namespaceUID: namespace.uid }),
      { flag: "wx", mode: 0o600 },
    );
    await editorFixtureKubectl(
      ["delete", "--raw", `/api/v1/namespaces/${identity.namespace}`, "-f", "-"],
      {
        apiVersion: "v1",
        kind: "DeleteOptions",
        preconditions: { uid: namespace.uid },
        propagationPolicy: "Foreground",
      },
    );
    await eventually(read, (current) => current === null, "Owned IDE namespace remained", 120_000);
    await writeFile(
      resolve(artifacts, "automatic-ide-cleanup.json"),
      JSON.stringify({ namespace: identity.namespace, uid: namespace.uid, absenceConfirmed: true }),
      { flag: "wx", mode: 0o600 },
    );
  } finally {
    await database.client.end({ timeout: 2 });
  }
}
