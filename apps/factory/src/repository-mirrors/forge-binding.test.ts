import { expect, test } from "bun:test";
import {
  forgeBinding,
  forgeBindingDatabase,
  forgeRepositoryBindingMatrix,
} from "../../../../test/support/forge-repository-binding";
import { createRepositoryMirrorController } from "./controller";

test("mirrors reject the shared malformed binding before native observation, writes or command intent", async () => {
  const actor = crypto.randomUUID();
  const projectID = crypto.randomUUID();
  const { accepted, malformed } = forgeRepositoryBindingMatrix();
  let repositoryURL = "";
  let expectedRepository = { owner: forgeBinding.owner, name: "repo" };
  let manager = true;
  let reads = 0;
  let writes = 0;
  const fixture = forgeBindingDatabase(
    (text) => {
      if (text.includes("SELECT repository_url AS url")) return [{ url: repositoryURL }];
      if (text.includes("FROM factory.repository_mirror_command")) return [];
      throw new Error(`Unexpected mirror query: ${text}`);
    },
    (text) => {
      if (text.includes('"auth"."user"')) return [[actor]];
      if (text.includes('"factory"."account_access"')) return [[null, null]];
      if (text.includes('"factory"."administrator"')) return manager ? [[actor]] : [];
      throw new Error(`Unexpected mirror authority query: ${text}`);
    },
  );
  const controller = createRepositoryMirrorController({
    ...forgeBinding,
    database: fixture.database,
    signingKey: "owned-binding-fingerprint",
    allowedOrigins: ["https://github.com"],
    forge: {
      pushMirrors: {
        async list(repository) {
          expect(repository).toEqual(expectedRepository);
          reads++;
          return [];
        },
        async create() {
          writes++;
          throw new Error("Malformed binding cannot create mirrors");
        },
        async remove() {
          writes++;
        },
        async sync() {
          writes++;
        },
      },
    },
  });
  for (const value of accepted) {
    repositoryURL = value.url;
    expectedRepository = value.repository;
    expect(await controller.get(actor, projectID)).toEqual({
      projectID,
      mirrors: [],
      pending: null,
    });
  }
  const before = reads;
  for (repositoryURL of malformed) {
    for (const call of [
      () => controller.get(actor, projectID),
      () =>
        controller.create(actor, projectID, {
          commandID: crypto.randomUUID(),
          targetURL: "https://github.com/owned/backup.git",
          username: "owned",
          token: "owned-test-mirror-token",
          confirmOverwrite: true,
        }),
      () =>
        controller.remove(actor, projectID, {
          commandID: crypto.randomUUID(),
          remoteName: "remote_mirror_owned",
          targetURL: "https://github.com/owned/backup.git",
        }),
      () => controller.sync(actor, projectID, crypto.randomUUID()),
    ])
      await expect(call()).rejects.toMatchObject({
        code: "conflict",
        message: "Project does not identify this Factory's repository",
      });
    expect(reads).toBe(before);
    expect(writes).toBe(0);
  }
  repositoryURL = accepted[0]?.url ?? "";
  manager = false;
  await expect(controller.get(actor, projectID)).rejects.toMatchObject({ code: "forbidden" });
  expect(reads).toBe(before);
  expect(fixture.statements.some(({ text }) => /\b(?:INSERT|UPDATE|DELETE)\b/i.test(text))).toBe(
    false,
  );
});
