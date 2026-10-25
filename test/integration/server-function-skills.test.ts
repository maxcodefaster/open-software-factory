import { expect, test } from "bun:test";
import { decodeResponse } from "@solidjs/web/server-functions/client";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { FactoryServices } from "../../apps/factory/src/server-functions/context";
import { createServerFunctionEndpoint } from "../../apps/factory/src/server-functions/endpoint";
import { factoryBuildDirectory } from "../../apps/factory/src/build-directory";
import { factoryFunctionRequest } from "../fixtures/server-functions";
import type { SkillContent, SkillRevision } from "../../packages/conversation-domain/src/skills";

test("compiled Skill functions bind the actor, validate exact revisions and fence writes without browser-owned work", async () => {
  const origin = "https://factory.test",
    actor = crypto.randomUUID(),
    project = crypto.randomUUID();
  const libraryID = crypto.randomUUID(),
    revisionID = crypto.randomUUID(),
    sharingID = crypto.randomUUID();
  const content: SkillContent = {
    key: "owned-native",
    name: "Owned native",
    description: "Check native transport",
    roles: ["planning", "build"],
    instructions: "Retain the exact admitted revision.",
    references: [],
  };
  const revision: SkillRevision = {
    id: revisionID,
    revision: 1,
    content,
    digest: "a".repeat(64),
    published: true,
  };
  const effects: Array<{ method: string; args: unknown[] }> = [];
  const record = (method: string, args: unknown[]) => effects.push({ method, args });
  let maintenance = true,
    signedIn = true;
  const admitted = Promise.withResolvers<void>(),
    release = Promise.withResolvers<void>();
  const services = {
    skills: {
      async save(...args) {
        record("save", args);
        admitted.resolve();
        await release.promise;
        return { libraryId: libraryID, revisionId: revisionID };
      },
      async choose(...args) {
        record("choose", args);
        return { saved: true };
      },
      async propose(...args) {
        record("propose", args);
        return { id: sharingID };
      },
      async accept(...args) {
        record("accept", args);
        return { libraryId: libraryID };
      },
      async previewImport(...args) {
        record("preview-import", args);
        return { content, warnings: [] };
      },
      async previewRepository(...args) {
        record("preview-repository", args);
        return { content, warnings: [] };
      },
      async publish(...args) {
        record("publish", args);
        return revision;
      },
      async setPublication(...args) {
        record("publication", args);
        return {
          settings: {
            version: 1,
            planning: { required: [], optional: [], selected: [] },
            build: { required: [], optional: [], selected: [] },
          },
          revisions: [revision],
        };
      },
      async invocations(...args) {
        record("invocations", args);
        return {
          skills: [
            {
              id: revisionID,
              key: content.key,
              name: content.name,
              description: content.description,
            },
          ],
          conflicts: [],
        };
      },
      async revision(...args) {
        record("revision", args);
        return revision;
      },
      async sourceUpdate(...args) {
        record("source-update", args);
        return { current: true as const };
      },
      async saveSystem(...args) {
        record("system", args);
        return { settings: args[1], revisions: [] };
      },
      async saveProject(...args) {
        record("project", args);
        throw new Error("Not admitted during maintenance");
      },
      async savePersonal(...args) {
        record("personal", args);
        throw new Error("Not admitted during maintenance");
      },
    },
  } satisfies { [K in keyof FactoryServices]?: Partial<FactoryServices[K]> };
  const entry: typeof import("../../apps/factory/src/server-functions/entry") = await import(
    pathToFileURL(resolve(factoryBuildDirectory(), "server/entry.js")).href
  );
  const endpoint = createServerFunctionEndpoint({
    origin,
    services: services as unknown as FactoryServices,
    session: async () => (signedIn ? { user: { id: actor } } : null),
    maintenance: async () => maintenance,
    requireFresh: async () => {
      throw new Error("Skill commands did not acquire a fresh-auth gate");
    },
    handle: entry.handleServerFunctionRequest,
  });
  const call = async (name: string, args: unknown[]) =>
    decodeResponse(await endpoint(await factoryFunctionRequest(origin, name, args)));
  const save = {
    libraryId: libraryID,
    revisionId: revisionID,
    expectedRevision: 0,
    scope: "personal",
    projectId: project,
    content,
  };
  const choice = {
    libraryId: libraryID,
    role: "build",
    scope: "personal",
    projectId: project,
    revisionId: revisionID,
    expectedVersion: 0,
    state: "enable",
  };
  const share = { id: sharingID, revisionId: revisionID, target: "project", projectId: project };
  const files = {
    files: [
      {
        path: "SKILL.md",
        body: "---\nname: owned-native\ndescription: Test\n---\nTest",
        encoding: "utf8",
      },
    ],
  };
  const repository = {
    repository: "https://github.com/example/skills",
    commit: "a".repeat(40),
    path: "skills/owned/SKILL.md",
  };
  const empty = { required: [], optional: [], selected: [] };
  const system = { version: 0, planning: empty, build: empty };
  const inherited = {
    version: 0,
    planning: { required: [], optional: null, selected: null },
    build: { required: [], optional: null, selected: null },
  };
  for (const [name, args] of [
    ["saveSkill", [save]],
    ["saveSkillChoice", [choice]],
    ["proposeSkillSharing", [share]],
    ["acceptSkillSharing", [sharingID]],
    ["previewSkillImport", [files]],
    ["previewRepositorySkill", [repository]],
    ["publishSkill", [{ revisionId: revisionID, expectedRevision: 0, content }]],
    ["setSkillPublication", [revisionID, false]],
    ["saveSystemSkills", [system]],
    ["saveProjectSkills", [project, inherited]],
    ["savePersonalSkills", [project, { version: 0, planning: null, build: null }]],
  ] as Array<[string, unknown[]]>)
    expect(await call(name, args)).toMatchObject({ ok: false, status: 503 });
  expect(effects).toEqual([]);
  maintenance = false;
  for (const [name, args] of [
    ["saveSkill", [{ ...save, actorID: "forged" }]],
    ["saveSkillChoice", [{ ...choice, state: "not-a-choice" }]],
    ["getSkillInvocations", [project, "review"]],
    ["getSkillRevision", ["bad-id", project]],
    ["proposeSkillSharing", [{ ...share, userID: actor }]],
    ["previewRepositorySkill", [{ ...repository, commit: "main" }]],
  ] as Array<[string, unknown[]]>)
    expect(await call(name, args)).toMatchObject({ ok: false, status: 400 });
  expect(effects).toEqual([]);
  const cancel = new AbortController();
  const pending = endpoint(
    await factoryFunctionRequest(origin, "saveSkill", [save], {}, cancel.signal),
  );
  void pending.catch(() => {});
  await admitted.promise;
  cancel.abort();
  release.resolve();
  await pending.catch(() => undefined);
  expect(effects).toEqual([{ method: "save", args: [actor, save] }]);
  await call("saveSkillChoice", [choice]);
  await call("proposeSkillSharing", [share]);
  await call("acceptSkillSharing", [sharingID]);
  await call("getSkillInvocations", [project, "build", sharingID]);
  await call("getSkillRevision", [revisionID, project]);
  await call("checkSkillSourceUpdate", [revisionID, project]);
  expect(effects.slice(1)).toEqual([
    { method: "choose", args: [actor, choice] },
    { method: "propose", args: [actor, share] },
    { method: "accept", args: [actor, sharingID] },
    { method: "invocations", args: [actor, project, "build", sharingID] },
    { method: "revision", args: [actor, revisionID, project] },
    { method: "source-update", args: [actor, revisionID, project] },
  ]);
  signedIn = false;
  expect(
    (await endpoint(await factoryFunctionRequest(origin, "getSkillLibrary", [project]))).status,
  ).toBe(401);
});
