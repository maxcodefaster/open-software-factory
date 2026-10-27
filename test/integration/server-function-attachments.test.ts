import { expect, test } from "bun:test";
import { decodeFactoryResponse as decodeResponse } from "../fixtures/server-functions";
import { CommandError } from "../../apps/factory/src/command-error";
import type { FactoryServices } from "../../apps/factory/src/server-functions/context";
import { compiledFactoryEndpoint, factoryFunctionRequest } from "../fixtures/server-functions";

test("compiled Attachment functions bind private intent, draft sequence and metadata to the authenticated actor without replay", async () => {
  const origin = "https://factory.test",
    actor = crypto.randomUUID(),
    project = crypto.randomUUID();
  const id = crypto.randomUUID(),
    draft = crypto.randomUUID();
  const input = {
    id,
    projectId: project,
    name: "reference.txt",
    mediaType: "text/plain",
    bytes: 3,
    sha256: "a".repeat(64),
    draftId: draft,
  };
  const summary = {
    id,
    name: input.name,
    mediaType: input.mediaType,
    bytes: input.bytes,
    sha256: input.sha256,
    state: "uploading" as const,
    pages: 0,
    failure: null,
  };
  const effects: unknown[][] = [];
  const admitted = Promise.withResolvers<void>(),
    release = Promise.withResolvers<void>();
  let maintenance = true,
    allowed = true,
    authenticated = true,
    held = false;
  const endpoint = await compiledFactoryEndpoint({
    origin,
    session: async () => (authenticated ? { user: { id: actor } } : null),
    maintenance: async () => maintenance,
    requireFresh: async () => {
      throw new Error("Attachment operations do not require Fresh Auth");
    },
    services: {
      attachments: {
        async usage(...args) {
          effects.push(["usage", ...args]);
          return { usedBytes: 3, configured: true, limits: { fileBytes: 10, messageBytes: 20 } };
        },
        async metadata(...args) {
          if (!allowed) throw new CommandError("not-found", "Attachment not found");
          effects.push(["metadata", ...args]);
          return summary;
        },
        async begin(...args) {
          effects.push(["begin", ...args]);
          if (held) {
            admitted.resolve();
            await release.promise;
          }
          return summary;
        },
        async retainDraft(...args) {
          effects.push(["retain", ...args]);
          return {};
        },
      },
    } as FactoryServices,
  });
  const call = async (name: string, args: unknown[]) =>
    decodeResponse(await endpoint(await factoryFunctionRequest(origin, name, args)));
  const retain = { sequence: 4, ids: [id] };
  expect(await call("beginAttachment", [input])).toMatchObject({ ok: false, status: 503 });
  expect(await call("retainAttachmentDraft", [project, draft, retain])).toMatchObject({
    ok: false,
    status: 503,
  });
  expect(effects).toEqual([]);
  expect(await call("getAttachmentUsage", [project])).toMatchObject({
    ok: true,
    value: { usedBytes: 3 },
  });
  maintenance = false;
  effects.length = 0;
  for (const [name, args] of [
    ["beginAttachment", [{ ...input, userID: actor }]],
    ["beginAttachment", [{ ...input, bytes: -1 }]],
    ["beginAttachment", [{ ...input, sha256: "invalid" }]],
    ["getAttachmentMetadata", ["not-an-attachment"]],
    ["retainAttachmentDraft", [project, draft, { ...retain, actorID: actor }]],
    ["retainAttachmentDraft", [project, draft, { ...retain, sequence: -1 }]],
    ["retainAttachmentDraft", [project, draft, { ...retain, ids: Array(513).fill(id) }]],
  ] as Array<[string, unknown[]]>)
    expect(await call(name, args)).toMatchObject({ ok: false, status: 400 });
  expect(effects).toEqual([]);
  await call("getAttachmentMetadata", [id]);
  await call("beginAttachment", [input]);
  await call("beginAttachment", [input]);
  await call("retainAttachmentDraft", [project, draft, retain]);
  expect(effects).toEqual([
    ["metadata", actor, id],
    ["begin", actor, input],
    ["begin", actor, input],
    ["retain", actor, project, draft, retain],
  ]);
  allowed = false;
  expect(await call("getAttachmentMetadata", [id])).toMatchObject({ ok: false, status: 404 });
  held = true;
  const controller = new AbortController();
  const pending = endpoint(
    await factoryFunctionRequest(origin, "beginAttachment", [input], {}, controller.signal),
  );
  void pending.catch(() => {});
  await admitted.promise;
  controller.abort();
  release.resolve();
  await pending.catch(() => undefined);
  expect(effects.filter((effect) => effect[0] === "begin")).toHaveLength(3);
  authenticated = false;
  expect(
    (await endpoint(await factoryFunctionRequest(origin, "getAttachmentMetadata", [id]))).status,
  ).toBe(401);
});
