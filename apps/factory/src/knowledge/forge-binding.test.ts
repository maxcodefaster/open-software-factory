import { expect, test } from "bun:test";
import {
  forgeBinding,
  forgeBindingDatabase,
  forgeRepositoryBindingMatrix,
  useForgeBindingEnvironment,
} from "../../../../test/support/forge-repository-binding";
import { createKnowledgeController } from "./controller";

test("Source rejects the shared malformed matrix before any branch/tree/file read or inference", async () => {
  const restore = useForgeBindingEnvironment();
  const { accepted, malformed } = forgeRepositoryBindingMatrix();
  let repositoryURL = "";
  let reads = 0;
  const revision = "a".repeat(40);
  const fixture = forgeBindingDatabase((text) => {
    expect(text).toContain('repository_url AS "repositoryURL"');
    return [{ id: "owned-project", name: "Owned", repositoryURL, defaultBranch: "main" }];
  });
  let expectedRepository = { owner: forgeBinding.owner, name: "repo" };
  const controller = createKnowledgeController(
    fixture.database,
    {
      async getDefaultBranch(repository) {
        expect(repository).toEqual(expectedRepository);
        reads++;
        return { name: "main", headSha: revision };
      },
      async listFiles(repository, ref) {
        expect(repository).toEqual(expectedRepository);
        expect(ref).toBe(revision);
        reads++;
        return [{ path: "README.md", size: 10, sha: "b".repeat(40) }];
      },
      async getFileInfo(repository, path, ref) {
        expect(repository).toEqual(expectedRepository);
        expect([path, ref]).toEqual(["README.md", revision]);
        reads++;
        return { content: "Owned source", sha: "b".repeat(40) };
      },
    },
    async () => {
      throw new Error("Source reads cannot start inference");
    },
  );
  try {
    for (const value of accepted) {
      repositoryURL = value.url;
      expectedRepository = value.repository;
      expect(await controller.documents("owned-project")).toMatchObject({ commitSha: revision });
      expect(await controller.document("owned-project", "README.md")).toMatchObject({
        body: "Owned source",
        commitSha: revision,
      });
    }
    const before = reads;
    for (repositoryURL of malformed) {
      await expect(controller.documents("owned-project")).rejects.toMatchObject({
        code: "forbidden",
      });
      await expect(controller.document("owned-project", "README.md")).rejects.toMatchObject({
        code: "forbidden",
      });
      expect(reads).toBe(before);
    }
  } finally {
    await controller.close();
    restore();
  }
});
