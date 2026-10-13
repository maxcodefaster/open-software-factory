import { expect, test } from "bun:test";
import type { SourceTransport } from "../../deploy/theia-ide/factory-ide-extension/lib/browser/factory-source-client";
import { FactoryWorkspaceSearch } from "../../deploy/theia-ide/factory-ide-extension/lib/browser/factory-workspace-search";
import type { SearchInWorkspaceResult } from "../../deploy/theia-ide/node_modules/@theia/search-in-workspace/lib/common/search-in-workspace-interface";
import composition from "../../deploy/theia-ide/browser-app/package.json";

test("composition disables upstream symlink-following default and the adapter rejects overrides", async () => {
  expect(composition.theia.frontend.config.preferences["search.followSymlinks"]).toBe(false);
  const search = new FactoryWorkspaceSearch(
    {
      async request() {
        throw new Error("Unsupported search must never dispatch");
      },
      watch() {
        throw new Error("Search must not watch");
      },
    },
    undefined,
  );
  await expect(
    search.search("TODO", ["factory-workspace://workspace-a/"], { followSymlinks: true }),
  ).rejects.toThrow("symlink search");
  search.dispose();
});

test("pinned Theia search routes to canonical source and preserves result Workspace identity", async () => {
  const requests: string[] = [];
  const results: SearchInWorkspaceResult[] = [];
  const complete = Promise.withResolvers<string | undefined>();
  const transport: SourceTransport = {
    async request(workspaceID, operation, body) {
      requests.push(`${workspaceID}:${operation}:${JSON.stringify(body)}`);
      return {
        results: [
          {
            path: "src/app.ts",
            matches: [{ line: 2, character: 8, length: 4, lineText: "😀 café TODO" }],
          },
        ],
        truncated: false,
      };
    },
    watch() {
      throw new Error("Search must not start a watch");
    },
  };
  const search = new FactoryWorkspaceSearch(transport, {
    onResult(_id, result) {
      results.push(result);
    },
    onDone(_id, error) {
      complete.resolve(error);
    },
  });
  const id = await search.search("TODO", ["factory-workspace://workspace-a/"], {
    matchWholeWord: true,
  });
  expect(id).toBeGreaterThan(0);
  expect(await complete.promise).toBeUndefined();
  expect(requests[0]).toContain("workspace-a:search:");
  expect(requests[0]).toContain('"wholeWord":true');
  expect(results[0]?.fileUri).toBe("factory-workspace://workspace-a/src/app.ts");
  expect(results[0]?.root).toBe("factory-workspace://workspace-a/");
  search.dispose();
});

test("cancel before dispatch never searches or publishes another Workspace", async () => {
  let requests = 0;
  let callbacks = 0;
  const search = new FactoryWorkspaceSearch(
    {
      async request() {
        requests++;
        throw new Error("must not dispatch");
      },
      watch() {
        throw new Error("must not watch");
      },
    },
    {
      onResult() {
        callbacks++;
      },
      onDone() {
        callbacks++;
      },
    },
  );
  const id = await search.search("TODO", ["factory-workspace://workspace-a/"]);
  await search.cancel(id);
  await new Promise((resolve) => setTimeout(resolve, 5));
  expect(requests).toBe(0);
  expect(callbacks).toBe(0);
  await expect(search.search("TODO", ["file:///workspace/project"])).rejects.toThrow();
  search.dispose();
});

test("truncated source search is visibly incomplete rather than an exhaustive result", async () => {
  const complete = Promise.withResolvers<string | undefined>();
  const search = new FactoryWorkspaceSearch(
    {
      async request() {
        return { results: [], truncated: true };
      },
      watch() {
        throw new Error("must not watch");
      },
    },
    {
      onResult() {},
      onDone(_id, error) {
        complete.resolve(error);
      },
    },
  );
  await search.search("TODO", ["factory-workspace://workspace-a/"]);
  expect(await complete.promise).toContain("Narrow the query");
  search.dispose();
});
