import { mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { expect, test } from "@playwright/test";
import solid from "@solidjs/vite-plugin";
import { createServer, type ViteDevServer } from "vite";
import type { z } from "zod";
import {
  type skillLibrarySaveInput,
  skillLibraryView,
} from "../../packages/conversation-domain/src/skill-library";
import { mockFactoryFunctions } from "../fixtures/server-functions";
import { factoryFixtureStart } from "../fixtures/start-plugins";
import { fixtureValue } from "../fixtures/value";

const directory = ".factory/test-results/skill-transport";
const cache = resolve(".factory/test-results/vite", `skill-transport-${crypto.randomUUID()}`);
let server: ViteDevServer;
let origin: string;
test.setTimeout(60_000);
test.beforeAll(async () => {
  server = await createServer({
    configFile: false,
    root: resolve("test/fixtures"),
    cacheDir: cache,
    publicDir: resolve("apps/factory/public"),
    optimizeDeps: { entries: ["skill-library.html"] },
    plugins: [factoryFixtureStart(), solid({ ssr: false })],
    server: { host: "127.0.0.1", port: 0 },
  });
  await server.listen();
  origin = fixtureValue(
    fixtureValue(server.resolvedUrls, "server.resolvedUrls").local[0],
    "server.resolvedUrls!.local[0]",
  ).replace(/\/$/, "");
  await mkdir(directory, { recursive: true });
});
test.afterAll(async () => {
  await server?.close();
  await rm(cache, { recursive: true, force: true });
});

test("Skill library without a Project uses native JSON calls and explicitly retries the same unconfirmed save", async ({
  page,
}) => {
  let view = skillLibraryView.parse({
    entries: [],
    sharedVersions: [],
    choices: [],
    proposals: [],
    canManageProject: false,
    canManageSystem: false,
  });
  const calls: z.output<typeof skillLibrarySaveInput>[] = [];
  const errors: string[] = [];
  const retired: string[] = [];
  let reads = 0,
    lost = false;
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("request", (request) => {
    if (new URL(request.url()).pathname.startsWith("/api/skills")) retired.push(request.url());
  });
  await mockFactoryFunctions(
    page,
    {
      skills: {
        async library(_actor, projectID) {
          expect(projectID).toBeUndefined();
          reads++;
          return view;
        },
        async save(_actor, input) {
          calls.push(structuredClone(input));
          if (calls.length === 1) {
            view = {
              ...view,
              entries: [
                {
                  id: input.libraryId,
                  scope: "personal",
                  ownerId: crypto.randomUUID(),
                  projectId: null,
                  editable: true,
                  revisions: [
                    {
                      id: input.revisionId,
                      revision: 1,
                      published: true,
                      digest: "a".repeat(64),
                      content: input.content,
                    },
                  ],
                },
              ],
            };
            lost = true;
          } else expect(input).toEqual(calls[0]);
          return { libraryId: input.libraryId, revisionId: input.revisionId };
        },
      },
    },
    () => {
      if (!lost) return false;
      lost = false;
      return true;
    },
  );
  await page.goto(`${origin}/skill-library.html`);
  await expect(page.getByText("0 skills", { exact: true })).toBeVisible();
  expect(reads).toBe(1);
  await page.getByRole("button", { name: "Add skill", exact: true }).click();
  const editor = page.getByRole("form", { name: "Skill editor", exact: true });
  const resume = page.getByRole("button", { name: "Resume draft", exact: true });
  await expect(resume).toBeHidden();
  await editor.getByLabel("Name", { exact: true }).fill("Owned private guidance");
  await editor.getByRole("button", { name: "Back to library", exact: true }).click();
  await expect(resume).toBeVisible();
  await expect(resume).toBeFocused();
  await resume.click();
  await expect(resume).toBeHidden();
  await expect(editor.getByLabel("Name", { exact: true })).toHaveValue("Owned private guidance");
  await page.screenshot({ path: `${directory}/resumed-editor.png` });
  await editor
    .getByLabel("When to use", { exact: true })
    .fill("When checking the exact approved work.");
  await editor
    .getByLabel("Instructions", { exact: true })
    .fill("Keep the original command identity on explicit retry.");
  await editor.getByRole("button", { name: "Save skill", exact: true }).click();
  await expect(editor.getByRole("alert")).toBeVisible();
  expect(calls).toHaveLength(1);
  await expect(editor.getByLabel("Name", { exact: true })).toHaveValue("Owned private guidance");
  await editor.getByRole("button", { name: "Save skill", exact: true }).click();
  await expect(
    page.getByText("Skill saved. Choose where to enable it.", { exact: true }),
  ).toBeVisible();
  expect(calls).toHaveLength(2);
  expect(calls[0]).toEqual(calls[1]);
  await page.screenshot({ path: `${directory}/private-desktop.png`, fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole("region", { name: "Skill details", exact: true })).toBeVisible();
  await page.screenshot({ path: `${directory}/private-narrow.png`, fullPage: true });
  expect(errors).toEqual([]);
  expect(retired).toEqual([]);
});
