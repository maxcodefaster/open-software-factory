import { expect, test } from "bun:test";
import { decodeResponse } from "@solidjs/web/server-functions/client";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type {
  ProjectSetupView,
  SetupInspectionView,
} from "../../packages/project-domain/src/setup";
import type { FactoryServices } from "../../apps/factory/src/server-functions/context";
import { createServerFunctionEndpoint } from "../../apps/factory/src/server-functions/endpoint";
import { factoryBuildDirectory } from "../../apps/factory/src/build-directory";
import { factoryFunctionRequest } from "../fixtures/server-functions";

test("compiled Setup preserves command identities and ignores browser cancellation after admission", async () => {
  const origin = "https://factory.test";
  const actorID = crypto.randomUUID(),
    projectID = crypto.randomUUID(),
    setupID = crypto.randomUUID();
  let maintenance = false,
    authenticated = true;
  const effects: Array<{ method: string; args: unknown[] }> = [];
  const admitted = Promise.withResolvers<void>(),
    release = Promise.withResolvers<void>(),
    finished = Promise.withResolvers<void>();
  let draft: ProjectSetupView = {
    id: setupID,
    version: 1,
    name: "Owned protocol",
    slug: "owned-protocol",
    kind: "import",
    sourceURL: "https://example.invalid/owned.git",
    state: "draft",
    projectID: null,
    commandID: null,
    failure: null,
  };
  const inspection = (id: string, state: SetupInspectionView["state"]): SetupInspectionView => ({
    id,
    projectID,
    sourceCommit: "a".repeat(40),
    state,
    output: null,
    failure: null,
  });
  const services = {
    setup: {
      async draft(actor) {
        expect(actor).toBe(actorID);
        return draft;
      },
      async begin(actor) {
        effects.push({ method: "begin", args: [actor] });
        return draft;
      },
      async save(actor, input) {
        effects.push({ method: "save", args: [actor, input] });
        return draft;
      },
      async create(...args) {
        expect(args).toHaveLength(2);
        expect(args[0]).toBe(actorID);
        effects.push({ method: "create", args });
        draft = { ...draft, state: "checking", commandID: args[1].commandID };
        admitted.resolve();
        await release.promise;
        draft = { ...draft, state: "created", projectID };
        finished.resolve();
        return draft;
      },
      async check(actor, id) {
        effects.push({ method: "check", args: [actor, id] });
        return draft;
      },
      async retry(actor, id) {
        effects.push({ method: "retry", args: [actor, id] });
        return draft;
      },
      async inspect(actor, project, id, continuation) {
        effects.push({ method: "inspect", args: [actor, project, id, continuation] });
        return inspection(id, "inspecting");
      },
      async confirm(actor, project, id) {
        effects.push({ method: "confirm", args: [actor, project, id] });
        return inspection(id, "confirmed");
      },
      async stop(actor, project, id) {
        effects.push({ method: "stop", args: [actor, project, id] });
        return inspection(id, "superseded");
      },
      async retryTask(actor, project, task) {
        effects.push({ method: "retry-task", args: [actor, project, task] });
        return [];
      },
    },
  } satisfies { [K in keyof FactoryServices]?: Partial<FactoryServices[K]> };
  const entry: typeof import("../../apps/factory/src/server-functions/entry") = await import(
    pathToFileURL(resolve(factoryBuildDirectory(), "server/entry.js")).href
  );
  const endpoint = createServerFunctionEndpoint({
    origin,
    services: services as unknown as FactoryServices,
    session: async () => (authenticated ? { user: { id: actorID } } : null),
    maintenance: async () => maintenance,
    requireFresh: async () => {
      throw new Error("Setup did not add a fresh-authentication gate");
    },
    handle: entry.handleServerFunctionRequest,
  });
  const call = async (name: string, args: unknown[]) =>
    decodeResponse(await endpoint(await factoryFunctionRequest(origin, name, args)));
  const commandID = crypto.randomUUID();
  const create = { id: setupID, version: 1, commandID, importToken: "owned-source-credential" };
  const save = {
    id: setupID,
    version: 1,
    name: draft.name,
    slug: draft.slug,
    kind: draft.kind,
    sourceURL: draft.sourceURL,
  };
  maintenance = true;
  for (const [name, args] of [
    ["beginSetupDraft", []],
    ["saveSetupDraft", [save]],
    ["createSetupProject", [create]],
    ["checkSetupProject", [setupID]],
    ["retrySetupProject", [setupID]],
    ["startSetupInspection", [projectID, { id: commandID }]],
    ["confirmSetupInspection", [projectID, commandID]],
    ["stopSetupInspection", [projectID, commandID]],
    ["retrySetupTask", [projectID, "wiki"]],
  ] as Array<[string, unknown[]]>) {
    expect(await call(name, args)).toMatchObject({ ok: false, status: 503 });
  }
  expect(effects).toEqual([]);
  maintenance = false;
  expect(await call("createSetupProject", [{ ...create, actorID: "forged" }])).toMatchObject({
    ok: false,
    status: 400,
  });
  expect(await call("createSetupProject", [{ ...create, version: 0 }])).toMatchObject({
    ok: false,
    status: 400,
  });
  expect(await call("retrySetupTask", [projectID, "unrecognized"])).toMatchObject({
    ok: false,
    status: 400,
  });
  const abort = new AbortController();
  const pending = endpoint(
    await factoryFunctionRequest(origin, "createSetupProject", [create], {}, abort.signal),
  );
  void pending.catch(() => {});
  await admitted.promise;
  abort.abort();
  release.resolve();
  await pending.catch(() => undefined);
  await finished.promise;
  expect(effects).toEqual([{ method: "create", args: [actorID, create] }]);
  expect(await call("getSetupDraft", [])).toMatchObject({
    ok: true,
    value: { state: "created", projectID, commandID },
  });
  await call("startSetupInspection", [projectID, { id: commandID, answers: { port: " 3000 " } }]);
  await call("confirmSetupInspection", [projectID, commandID]);
  await call("stopSetupInspection", [projectID, commandID]);
  await call("retrySetupTask", [projectID, "wiki"]);
  expect(effects.slice(1)).toEqual([
    { method: "inspect", args: [actorID, projectID, commandID, { answers: { port: "3000" } }] },
    { method: "confirm", args: [actorID, projectID, commandID] },
    { method: "stop", args: [actorID, projectID, commandID] },
    { method: "retry-task", args: [actorID, projectID, "wiki"] },
  ]);
  authenticated = false;
  expect((await endpoint(await factoryFunctionRequest(origin, "getSetupDraft", []))).status).toBe(
    401,
  );
});
