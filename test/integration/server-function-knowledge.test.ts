import { expect, test } from "bun:test";
import { decodeFactoryResponse as decodeResponse } from "../fixtures/server-functions";
import { createKnowledgeService } from "../../apps/factory/src/knowledge/service";
import type { FactoryServices } from "../../apps/factory/src/server-functions/context";
import { compiledFactoryEndpoint, factoryFunctionRequest } from "../fixtures/server-functions";
import { CommandError } from "../../apps/factory/src/command-error";

test("compiled Knowledge functions keep authority, exact versions, ISO history and admitted generation independent of browser cancellation", async () => {
  const origin = "https://owned-knowledge.test",
    actor = crypto.randomUUID();
  const project = crypto.randomUUID(),
    page = crypto.randomUUID(),
    revision = crypto.randomUUID(),
    generation = crypto.randomUUID();
  const commit = "a".repeat(40),
    date = new Date("2026-10-24T00:00:00.000Z");
  let maintenance = true,
    developer = true,
    allowed = true,
    authenticated = true;
  const effects: unknown[][] = [],
    admitted = Promise.withResolvers<void>(),
    release = Promise.withResolvers<void>();
  const save = {
    id: page,
    version: 2,
    title: "Guide",
    body: "Human text survives.",
    revisionId: revision,
  };
  const generated = {
    id: generation,
    state: "pending" as const,
    pageCount: 0,
    conflictCount: 0,
    failure: null,
  };
  const knowledge = createKnowledgeService({
    access: {
      async requireProject(...args) {
        expect(args).toEqual([actor, project]);
        if (!allowed) throw new CommandError("not-found", "Project not found");
      },
      async requireDevelopment(...args) {
        expect(args).toEqual([actor, project]);
        if (!developer) throw new CommandError("forbidden", "Developer access required");
      },
    },
    controller: {
      async generation(...args) {
        effects.push(["generation", ...args]);
        return generated;
      },
      async generate(...args) {
        effects.push(["generate", ...args]);
        admitted.resolve();
        await release.promise;
        return generated;
      },
      async edit(...args) {
        effects.push(["save", ...args]);
        return save;
      },
      async archive(...args) {
        effects.push(["archive", ...args]);
        return { id: page };
      },
      async restore(...args) {
        effects.push(["restore", ...args]);
        return save;
      },
      async sources(...args) {
        if (!developer) throw new CommandError("forbidden", "Developer access required");
        effects.push(["sources", ...args]);
        return { citations: [{ path: "src/main.ts", commitSha: commit }] };
      },
      async history(...args) {
        effects.push(["history", ...args]);
        return [
          {
            id: revision,
            ordinal: 1,
            kind: "human",
            title: save.title,
            body: save.body,
            createdAt: date,
            author: "Owned author",
            ...(developer ? { sourceCommitSha: commit } : {}),
          },
        ];
      },
      async search(...args) {
        effects.push(["search", ...args]);
        return [
          {
            id: page,
            kind: "page",
            title: save.title,
            path: "guide",
            snippet: "Human text",
            rank: 1,
          },
        ];
      },
      async documents(...args) {
        effects.push(["documents", ...args]);
        return { commitSha: commit, documents: [] };
      },
      async document(...args) {
        effects.push(["document", ...args]);
        return {
          path: "docs/guide.md",
          title: "Guide",
          body: "# Source-owned",
          blobSha: "b".repeat(40),
          commitSha: commit,
        };
      },
    },
    async observeRetry(...args) {
      effects.push(["observe-retry", ...args]);
    },
  });
  const endpoint = await compiledFactoryEndpoint({
    origin,
    services: { knowledge } as unknown as FactoryServices,
    session: async () => (authenticated ? { user: { id: actor } } : null),
    maintenance: async () => maintenance,
    requireFresh: async () => {},
  });
  const call = async (name: string, args: unknown[]) =>
    decodeResponse(await endpoint(await factoryFunctionRequest(origin, name, args)));
  const input = { expectedVersion: 1, title: save.title, body: save.body };
  for (const [name, args] of [
    ["generateKnowledge", [project]],
    ["saveKnowledgePage", [page, input]],
    ["archiveKnowledgePage", [page, 2]],
    ["restoreKnowledgePage", [page, revision, 2]],
  ] as Array<[string, unknown[]]>)
    expect(await call(name, args)).toMatchObject({ ok: false, status: 503 });
  expect(effects).toEqual([]);
  maintenance = false;
  for (const [name, args] of [
    ["getKnowledgeGeneration", ["invalid"]],
    ["saveKnowledgePage", [page, { ...input, expectedVersion: 0 }]],
    ["archiveKnowledgePage", [page, -1]],
    ["restoreKnowledgePage", [page, "invalid", 2]],
    ["searchKnowledge", [project, null]],
    ["getRepositoryDocument", [project, ""]],
  ] as Array<[string, unknown[]]>)
    expect(await call(name, args)).toMatchObject({ ok: false, status: 400 });
  expect(effects).toEqual([]);
  allowed = false;
  expect(await call("getKnowledgeGeneration", [project])).toMatchObject({ ok: false, status: 404 });
  allowed = true;
  developer = false;
  expect(await call("getRepositoryDocuments", [project])).toMatchObject({ ok: false, status: 403 });
  expect(await call("getRepositoryDocument", [project, "docs/guide.md"])).toMatchObject({
    ok: false,
    status: 403,
  });
  expect(await call("getKnowledgeSources", [page])).toMatchObject({ ok: false, status: 403 });
  const history = await call("getKnowledgeHistory", [page]);
  expect(history).toMatchObject({
    ok: true,
    value: { revisions: [{ createdAt: date.toISOString() }] },
  });
  expect(JSON.stringify(history)).not.toContain("sourceCommitSha");
  developer = true;
  effects.length = 0;
  await call("getKnowledgeGeneration", [project]);
  await call("saveKnowledgePage", [page, input]);
  await call("restoreKnowledgePage", [page, revision, 2]);
  await call("archiveKnowledgePage", [page, 2]);
  await call("getKnowledgeSources", [page]);
  await call("getRepositoryDocuments", [project]);
  await call("getRepositoryDocument", [project, "docs/guide.md"]);
  await call("searchKnowledge", [project, "human"]);
  expect(effects).toEqual([
    ["generation", project],
    ["save", page, input, actor],
    ["restore", page, revision, 2, actor],
    ["archive", page, 2, actor],
    ["sources", page, actor],
    ["documents", project],
    ["document", project, "docs/guide.md"],
    ["search", project, "human", actor],
  ]);
  const cancellation = new AbortController();
  const work = endpoint(
    await factoryFunctionRequest(origin, "generateKnowledge", [project], {}, cancellation.signal),
  );
  void work.catch(() => {});
  await admitted.promise;
  cancellation.abort();
  release.resolve();
  await work.catch(() => undefined);
  expect(effects.slice(-2)).toEqual([
    ["generate", project, actor],
    ["observe-retry", project, actor, generation],
  ]);
  authenticated = false;
  expect(
    (await endpoint(await factoryFunctionRequest(origin, "getKnowledgeHistory", [page]))).status,
  ).toBe(401);
});
