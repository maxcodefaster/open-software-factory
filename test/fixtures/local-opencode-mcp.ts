import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import type { BrowserContext } from "@playwright/test";
import { expect as visible } from "@playwright/test";
import { runProcess } from "../../scripts/owned-client-process";
import { eventually } from "./factory-process";

/** Test the installed client through its normal API/auth discovery, without copying credentials. */
export async function proveLocalOpenCodeMCP(input: {
  factoryURL: string;
  workspaceID: string;
  browser: BrowserContext;
  evidenceDirectory: string;
}) {
  const installed = Bun.which(process.env["FACTORY_LOCAL_OPENCODE_BINARY"] ?? "opencode");
  if (!installed)
    throw new Error(
      "Installed OpenCode V2 executable not found; put opencode on PATH or set FACTORY_LOCAL_OPENCODE_BINARY",
    );
  const binary = installed;
  const id = crypto.randomUUID();
  const name = `fproof_${id.replaceAll("-", "").slice(0, 16)}`;
  const directory = await mkdtemp(resolve(tmpdir(), "factory-mcp-"));
  await writeFile(
    resolve(directory, "opencode.json"),
    JSON.stringify(
      {
        $schema: "https://opencode.ai/config.json",
        mcp: {
          servers: {
            [name]: { type: "remote", url: `${input.factoryURL}/api/mcp`, codemode: false },
          },
        },
        permissions: [
          { action: "*", resource: "*", effect: "deny" },
          { action: `${name}_*`, resource: "*", effect: "allow" },
        ],
      },
      null,
      2,
    ),
    { mode: 0o600 },
  );
  const location = `location[directory]=${encodeURIComponent(directory)}`;
  async function api(method: string, path: string, body?: unknown) {
    const process = await runProcess(
      [
        binary,
        "api",
        method,
        path,
        ...(body === undefined ? [] : ["--data", JSON.stringify(body)]),
      ],
      { cwd: directory, allowFailure: true },
    );
    if (process.code !== 0)
      throw new Error(
        `Local OpenCode API ${method} ${path.split("?")[0]} failed. Sensitive diagnostics suppressed.`,
      );
    return process.stdout.trim() ? JSON.parse(process.stdout) : undefined;
  }
  const info = await api("get", "/api/info");
  const version = await runProcess([binary, "--version"], { cwd: directory, allowFailure: true });
  if (version.code !== 0)
    throw new Error("Installed OpenCode version check failed. Sensitive diagnostics suppressed.");
  const cliVersion = version.stdout.trim();
  const page = await input.browser.newPage();
  try {
    await api("get", `/api/location?${location}`);
    const integrations = (await api("get", `/api/integration?${location}`)) as {
      data: {
        id: string;
        label?: string;
        name?: string;
        methods: { id: string; type: string }[];
      }[];
    };
    const integration = integrations.data.find(
      (value) => value.id.includes(name) || value.label === name || value.name === name,
    );
    const method = integration?.methods.find((value) => value.type === "oauth");
    if (!integration || !method) {
      const locationInfo = await api("get", `/api/location?${location}`);
      const mcps = await api("get", `/api/mcp?${location}`);
      await writeFile(
        resolve(input.evidenceDirectory, "opencode-discovery.json"),
        JSON.stringify(
          {
            name,
            location: locationInfo,
            mcps: mcps.data?.map((server: { name: string; status: { status: string } }) => ({
              name: server.name,
              status: server.status.status,
            })),
            integrations: integrations.data.map((value) => ({
              id: value.id,
              label: value.label,
              name: value.name,
              methods: value.methods.map((method) => ({ id: method.id, type: method.type })),
            })),
          },
          null,
          2,
        ),
      );
      throw new Error("Installed OpenCode did not discover the Factory OAuth integration");
    }
    const started = await api(
      "post",
      `/api/integration/${encodeURIComponent(integration.id)}/connect/oauth?${location}`,
      { methodID: method.id },
    );
    await page.goto(started.data.url);
    await visible(
      page.getByRole("heading", { name: "Connect to Factory", exact: true }),
    ).toBeVisible({ timeout: 30_000 });
    await page.screenshot({ path: resolve(input.evidenceDirectory, "opencode-oauth-consent.png") });
    await page.getByRole("button", { name: "Connect client", exact: true }).click();
    await eventually(
      () => api("get", `/api/mcp?${location}`),
      (value) =>
        value.data?.some(
          (server: { name: string; status: { status: string } }) =>
            server.name === name && server.status.status === "connected",
        ),
      "Installed OpenCode did not confirm the OAuth MCP connection",
      30_000,
    );
    const commandID = crypto.randomUUID();
    const created = await api("post", "/api/session", {
      title: `Factory MCP acceptance ${id}`,
      agent: "build",
      model: { providerID: "github-copilot", id: "gpt-6.1-sol" },
      location: { directory },
      permissions: [
        { action: "*", resource: "*", effect: "deny" },
        { action: `${name}_*`, resource: "*", effect: "allow" },
      ],
    });
    if (created.data?.location?.directory !== directory)
      throw new Error(
        "Local OpenCode acceptance Session did not keep its explicit isolated Location",
      );
    const sessionID = String(created.data.id);
    const prompt = `This is an acceptance test of Factory MCP. Use only the ${name} MCP tools, not local files or shell tools. Call ${name}_getWorkspace for workspaceID ${input.workspaceID}. Then call ${name}_runCommand with workspaceID ${input.workspaceID}, requestID ${commandID}, command "printf local-opencode-native-proof". Observe that exact command ID with getCommand and readCommandOutput until it exits. Do not start another execution, edit files, approve or deliver anything. Report its actual exit code and output. If any step fails, report failure instead of claiming success.`;
    const {
      stdout,
      stderr,
      code: status,
    } = await runProcess(
      [
        binary,
        "run",
        "--session",
        sessionID,
        "--model",
        "github-copilot/gpt-6.1-sol",
        "--agent",
        "build",
        "--format",
        "json",
        "--auto",
        "--title",
        `Factory MCP acceptance ${id}`,
        prompt,
      ],
      { cwd: directory, allowFailure: true },
    );
    // The test prompt contains only owned IDs. Redact transport credentials if an upstream diagnostic includes one.
    const redact = (value: string) =>
      value
        .replace(/Bearer\s+\S+/gi, "Bearer <REDACTED>")
        .replace(/([?&](?:code|state|factory-grant)=)[^&\s"']+/g, "$1<REDACTED>");
    await writeFile(resolve(input.evidenceDirectory, "local-opencode.jsonl"), redact(stdout));
    await writeFile(resolve(input.evidenceDirectory, "local-opencode.stderr.log"), redact(stderr));
    if (status !== 0)
      throw new Error("Installed OpenCode acceptance run failed; sanitized diagnostics retained");
    return {
      cliVersion,
      serverVersion: String(info.version),
      commandID,
      serverName: name,
      sessionID,
    };
  } finally {
    await page.close();
    await runProcess([binary, "mcp", "logout", name], {
      cwd: directory,
      allowFailure: true,
    });
    await api("delete", `/api/experimental/mcp/${encodeURIComponent(name)}?${location}`).catch(
      () => undefined,
    );
    // Remove only this proof's public configuration; OAuth stays in OpenCode's native credential store.
    const content = await readFile(resolve(directory, "opencode.json"), "utf8");
    const config = JSON.parse(content);
    if (config.mcp?.servers?.[name]?.url === `${input.factoryURL}/api/mcp`)
      await writeFile(
        resolve(directory, "opencode.json"),
        JSON.stringify(
          { $schema: "https://opencode.ai/config.json", mcp: { servers: {} } },
          null,
          2,
        ),
        { mode: 0o600 },
      );
  }
}
