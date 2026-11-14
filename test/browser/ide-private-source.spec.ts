import { resolve } from "node:path";
import { expect } from "@playwright/test";
import { test } from "../fixtures/browser-test";

async function privateSourceFixture(secondStatus = 409) {
  const module = resolve(
    "deploy/theia-ide/factory-ide-extension/src/browser/factory-collaboration.ts",
  );
  const built = await Bun.build({
    entrypoints: ["owned-private-source-entry"],
    target: "browser",
    tsconfig: resolve("deploy/theia-ide/factory-ide-extension/tsconfig.json"),
    plugins: [
      {
        name: "owned-collaboration-host",
        setup(build) {
          build.onResolve({ filter: /^owned-private-source-entry$/ }, () => ({
            path: "entry",
            namespace: "owned-source",
          }));
          build.onResolve(
            { filter: /^(?:@theia\/|y-monaco$|owned-theia-host$)|^\.\/factory-workspace-files$/ },
            () => ({ path: "host", namespace: "owned-source" }),
          );
          build.onLoad({ filter: /.*/, namespace: "owned-source" }, ({ path }) => ({
            loader: "js",
            resolveDir: process.cwd(),
            contents:
              path === "host"
                ? `
export const inject=()=>()=>{};
export const injectable=()=>value=>value;
export class CommandRegistry {}
export class EditorManager {}
export class StatusBar {}
export const StatusBarAlignment={LEFT:1};
export const workspaceScheme="factory-workspace";
export function workspaceResource(uri){const u=new URL(uri.toString());return {workspaceID:u.hostname,path:u.pathname.slice(1)};}
export class MonacoEditor {
  constructor(control,model,uri){this.control=control;this.uri=uri;this.document={get dirty(){return model.getValue()!=="saved source\\n"}};}
  getControl(){return this.control;}
}
export class MonacoBinding {constructor(){throw Error("A private Source must not create a shared binding");}}
`
                : `
import {FactoryCollaboration} from ${JSON.stringify(module)};
import {MonacoEditor} from "owned-theia-host";
const field=document.querySelector("textarea");
const model={getValue:()=>field.value};
const uri={scheme:"factory-workspace",toString:()=>"factory-workspace://11111111-1111-4111-8111-111111111111/owned.txt"};
const callbacks=[];
function widget(input){
 const control={getModel:()=>model,updateOptions:options=>{input.readOnly=options.readOnly}};
 return {editor:new MonacoEditor(control,model,uri),onDispose:callback=>{callbacks.push(callback);return {dispose(){}}}};
}
const first=widget(field);
let created;
const editors={all:[first],currentEditor:first,onCreated:callback=>{created=callback}};
const contribution=new FactoryCollaboration();
Object.assign(contribution,{
 commands:{registerCommand(){}},editors,
 status:{setElement(_id,value){document.querySelector('[role="status"]').textContent=value.text},removeElement(){document.querySelector('[role="status"]').textContent=""}}
});
contribution.onDidInitializeLayout();
document.querySelector("button").onclick=()=>{
 const second=document.createElement("textarea");second.setAttribute("aria-label","Second Source view");
 second.value=field.value;document.body.append(second);created(widget(second));
};
window.addEventListener("beforeunload",()=>contribution.onStop());
`,
          }));
        },
      },
    ],
  });
  const output = built.outputs[0];
  if (!built.success || built.outputs.length !== 1 || !output)
    throw new Error("Owned private Source collaboration build failed");
  const script = await output.text();
  let release = () => {};
  const held = new Promise<void>((complete) => {
    release = complete;
  });
  const observed = { syncs: 0 };
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const path = new URL(request.url).pathname;
      if (path === "/collaboration-fixture.js")
        return new Response(script, { headers: { "content-type": "text/javascript" } });
      if (path === "/editor/")
        return new Response(
          `<!doctype html><html lang="en"><title>Owned private Source editor</title>
<h1>Private Source, paused compute</h1>
<label>Source buffer<textarea aria-label="Source buffer">saved source\n</textarea></label>
<button type="button">Open second Source view</button><p role="status"></p>
<script type="module" src="/collaboration-fixture.js"></script></html>`,
          { headers: { "content-type": "text/html" } },
        );
      if (path.endsWith("/collaboration/sync")) {
        observed.syncs++;
        if (observed.syncs === 2) await held;
        const status = observed.syncs === 1 ? 409 : secondStatus;
        return Response.json(
          {
            error:
              status === 409 ? "Enable shared editing for this Workspace first" : "Access lost",
          },
          { status },
        );
      }
      return new Response(null, { status: 404 });
    },
  });
  return {
    url: `http://127.0.0.1:${server.port}/editor/`,
    observed,
    release,
    async dispose() {
      release();
      await server.stop(true);
    },
  };
}

for (const viewport of [
  { name: "desktop", width: 1280, height: 900, touch: false },
  { name: "narrow", width: 390, height: 844, touch: false },
  { name: "touch", width: 768, height: 1024, touch: true },
]) {
  test.describe(viewport.name, () => {
    test.use({
      viewport: { width: viewport.width, height: viewport.height },
      hasTouch: viewport.touch,
    });
    test("known private Source stays writable during another sharing check", async ({
      page,
    }, testInfo) => {
      const owned = await privateSourceFixture();
      try {
        await page.goto(owned.url);
        const field = page.getByRole("textbox", { name: "Source buffer", exact: true });
        await expect(field).toBeEditable();
        await expect.poll(() => owned.observed.syncs).toBe(2);
        // The second real contribution poll is now held at its HTTP boundary.
        // A pending check must not intermittently disable a known private file.
        expect(await field.evaluate((node: HTMLTextAreaElement) => node.readOnly)).toBe(false);
        await field.fill("unsaved private Source\n");
        await page.getByRole("button", { name: "Open second Source view" }).click();
        await expect(page.getByRole("textbox", { name: "Second Source view" })).toBeEditable();
        owned.release();
        await expect(field).toHaveValue("unsaved private Source\n");
        await expect(field).toBeEditable();
        await page.screenshot({ path: testInfo.outputPath("private-source-editable.png") });
      } finally {
        await owned.dispose();
      }
    });

    test("a denied sharing observation still fences a private editor without losing its buffer", async ({
      page,
    }, testInfo) => {
      const owned = await privateSourceFixture(403);
      try {
        await page.goto(owned.url);
        const field = page.getByRole("textbox", { name: "Source buffer", exact: true });
        await expect(field).toBeEditable();
        await expect.poll(() => owned.observed.syncs).toBe(2);
        owned.release();
        await expect(field).not.toBeEditable();
        await expect(field).toHaveValue("saved source\n");
        await page.screenshot({ path: testInfo.outputPath("private-source-access-denied.png") });
      } finally {
        await owned.dispose();
      }
    });
  });
}
