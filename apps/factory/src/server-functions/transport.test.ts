import { expect, test } from "bun:test";
import { existsSync } from "node:fs";

test("migrated UI calls shared services without parallel HTTP command adapters", async () => {
  for (const file of [
    "models/system-settings.tsx",
    "models/project-settings.tsx",
    "models/connection-settings.tsx",
    "environments/settings.tsx",
    "agent/build-model-controls.tsx",
    "agent/configuration.tsx",
    "skills/library.tsx",
    "skills/import-panel.tsx",
    "skills/revision-editor.tsx",
    "skills/chat-picker.tsx",
    "mcp/library.tsx",
    "monitoring/settings.tsx",
    "writer-status.tsx",
    "review/panel.tsx",
    "access/settings.tsx",
    "access/fresh-authentication.tsx",
    "setup/panel.tsx",
    "setup/inspection-panel.tsx",
    "setup/readiness-panel.tsx",
    "ticket-draft-workspace.tsx",
  ]) {
    const source = await Bun.file(new URL(`../${file}`, import.meta.url)).text();
    expect(source).not.toMatch(/\bapiRequest\b|\bfetch\s*\(|\/api\//);
    expect(source).toContain("serverCall");
  }
  for (const file of [
    "models/routes.ts",
    "models/connection-routes.ts",
    "environments/routes.ts",
    "access/routes.ts",
    "setup/routes.ts",
    "skills/routes.ts",
    "mcp/routes.ts",
    "workspace/developer-ide-routes.ts",
    "workspace/source-routes.ts",
    "routes/projects.ts",
  ])
    expect(existsSync(new URL(`../${file}`, import.meta.url))).toBe(false);
  const host = (
    await Promise.all(
      ["server.ts", "server/application.ts", "server/protocols.ts", "server/transport.ts"].map(
        (file) => Bun.file(new URL(`../${file}`, import.meta.url)).text(),
      ),
    )
  ).join("\n");
  expect(host).not.toMatch(/create(?:ProjectModel|ModelConnection|Environment)Routes/);
  expect(host).not.toContain("createAccessRoutes");
  expect(host).not.toContain("createProjectSetupRoutes");
  expect(host).not.toContain("createSkillRoutes");
  expect(host).not.toContain("createMCPRoutes");
  expect(host).not.toContain("monitoringRoutes.settings");
  expect(host).not.toContain("writerRoute");
  expect(host).not.toContain("visualReviewRoute");
  expect(host).not.toContain("recordingSettingRoute");
  expect(host).toContain("createReviewMediaRoutes");
  expect(host).not.toContain("createDeveloperIDERoutes");
  expect(host).not.toContain("createWorkspaceSourceRoutes");
  expect(host).toContain("createWorkspaceSourceProtocol");
  expect(host).not.toContain("const knowledgePageRoute");
  expect(host).not.toContain("const knowledgeGeneration");
  expect(host).not.toContain("const knowledgeSearch");
  expect(host).not.toContain("const repositoryDocuments");
  expect(host).not.toContain("createProjectRoute");
  expect(host).not.toContain("const ticketDetail");
  expect(host).not.toContain("const documentSave");
  expect(host).not.toContain("const ticketFollowUp");
  expect(host).not.toContain("const trashCommand");
  expect(host).not.toContain("const implementationStart");
  expect(host).not.toContain("const deliveryRoute");
  const mainUI = await Bun.file(new URL("../factory.tsx", import.meta.url)).text();
  expect(mainUI).not.toMatch(/\/api\/tickets\//);
  expect(mainUI).not.toMatch(/["'`]\/api\/projects["'`]/);
  expect(mainUI).not.toMatch(/\/api\/changes\/[^"'\n]*\/delivery/);
  const editor = await Bun.file(new URL("../developer-ide-workspace.tsx", import.meta.url)).text();
  expect(editor).not.toMatch(/\bapiRequest\b|\bfetch\s*\(/);
  expect(editor.match(/\/api\/[^`"'\s]*/g)).toEqual([
    `/api/developer-ide/access?embed=1&epoch=\${current.epoch}`,
  ]);
  expect(editor).toContain("serverCall");
  const attachments = await Bun.file(new URL("../attachments/ui.tsx", import.meta.url)).text();
  expect(attachments).not.toMatch(/\bapiRequest\b|\bfetch\s*\(|\/api\//);
  expect(attachments).toContain("apiUpload");
  expect(attachments).toContain("beginAttachment");
  const attachmentRoutes = await Bun.file(
    new URL("../attachments/routes.ts", import.meta.url),
  ).text();
  expect(attachmentRoutes).not.toMatch(/retainDraft|store\.begin|store\.usage|metadata\|/);
  const entry = await Bun.file(new URL("../factory-entry.tsx", import.meta.url)).text();
  expect(entry).not.toMatch(/\bapiRequest\b|\bfetch\s*\(|\/api\//);
  expect(entry).toContain("loadBootstrap");
  for (const file of ["access/security-settings.tsx", "access/identity-settings.tsx"]) {
    const source = await Bun.file(new URL(`../${file}`, import.meta.url)).text();
    expect(source).not.toMatch(/\/api\/security\/|\/api\/admin\/users/);
    expect(source).toContain("serverCall");
    // These two retain only the native auth provider's login/logout protocol.
    expect(source).toContain("/api/auth/");
  }
  // Cover helpers as well as TSX callers. Retired UI adapters must not return
  // through an alias in a utility or through the composition root.
  const root = new URL("../", import.meta.url).pathname;
  for await (const path of new Bun.Glob("**/*.{ts,tsx}").scan(root)) {
    if (path.endsWith(".test.ts")) continue;
    const source = await Bun.file(`${root}${path}`).text();
    expect(source).not.toMatch(
      /\/api\/(?:admin\/users|security\/(?:session|authentication|configuration|sign-out))/,
    );
    expect(source).not.toMatch(/\/api\/(?:admin\/)?skills|\/skill-settings|\/skills\/invocations/);
    expect(source).not.toMatch(/\/api\/mcp(?!\/oauth\/callback)/);
    expect(source).not.toMatch(/\/api\/knowledge\/pages\//);
    expect(source).not.toMatch(
      /\/api\/projects\/[^"'\n]*\/knowledge\/(?:generation|documents|search)/,
    );
    expect(source).not.toMatch(/source-workspace\/ensure|\/api\/developer-ide(?:["'`]|\/stop)/);
  }
  // Named application functions call their shared services, never an HTTP
  // router or a generic path-based forwarding endpoint.
  for (const file of [
    "access",
    "usage",
    "models",
    "environments",
    "bootstrap",
    "setup",
    "skills",
    "mcp",
    "inputs",
    "writer",
    "review",
    "attachments",
    "workspaces",
    "knowledge",
    "tickets",
    "projects",
    "delivery",
  ]) {
    const source = await Bun.file(new URL(`./${file}.ts`, import.meta.url)).text();
    expect(source).not.toMatch(/\bfetch\s*\(|\bapiRequest\b|new Request\s*\(/);
    expect(source).toContain("createServerFn(");
    expect(source).not.toContain('"use server"');
  }
  const start = await Bun.file(new URL("../start-server.ts", import.meta.url)).text();
  expect(start).toContain("createStartHandler");
  expect(start).not.toContain("virtual:solid-server-function-handler");
  const config = await Bun.file(new URL("../../vite.config.ts", import.meta.url)).text();
  expect(config).not.toContain("factoryServerFunctionManifest");
  expect(config).not.toContain("factoryFunctionManifestID");

  // Keep the persistent desktop as composition, not a second giant render or command hook.
  for (const component of ["TicketWorkspace", "TicketBoardContents", "ConversationSwitcher"])
    expect(mainUI).not.toContain(`<${component}`);
  for (const command of ["sendProjectMessage", "promptAgent", "implementTicket"])
    expect(mainUI).not.toMatch(new RegExp(`async function ${command}\\b`));
});
