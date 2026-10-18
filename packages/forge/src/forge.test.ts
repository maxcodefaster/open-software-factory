import { describe, expect, test } from "bun:test";
import { createForgejoClient, ForgeAmbiguousWriteError, ForgeConflictError } from "./forge";

const repository = { owner: "factory", name: "fixture" };
const sha = "a".repeat(40);
const response = (value: unknown, status = 200) => Response.json(value, { status });
const branch = (name: string, headSha = sha) => ({ name, commit: { id: headSha } });

describe("complete repository file discovery", () => {
  const file = (path: string) => ({ path, type: "blob", sha, size: 12 });
  test("reads every page, including a short first page with a reported total", async () => {
    const requested: number[] = [];
    const client = createForgejoClient({
      apiURL: "http://forge/api/v1/",
      token: "secret",
      fetch: async (input) => {
        const page = Number(new URL(String(input)).searchParams.get("page"));
        requested.push(page);
        return response({
          tree: page === 1 ? [file("README.md")] : [file("docs/nested/guide.md")],
          total_count: 2,
          truncated: false,
        });
      },
    });
    expect((await client.listFiles(repository, sha)).map((entry) => entry.path)).toEqual([
      "README.md",
      "docs/nested/guide.md",
    ]);
    expect(requested).toEqual([1, 2]);
  });
  test("recovers a truncated recursive tree through complete subtree traversal", async () => {
    const subtree = "b".repeat(40);
    const client = createForgejoClient({
      apiURL: "http://forge/api/v1/",
      token: "secret",
      fetch: async (input) => {
        const url = new URL(String(input));
        if (url.searchParams.get("recursive") === "true")
          return response({ tree: [file("README.md")], truncated: true });
        if (url.pathname.endsWith(subtree))
          return response({ tree: [file("guide.md")], truncated: false });
        return response({
          tree: [file("README.md"), { path: "docs", type: "tree", sha: subtree }],
          truncated: false,
        });
      },
    });
    expect((await client.listFiles(repository, sha)).map((entry) => entry.path)).toEqual([
      "README.md",
      "docs/guide.md",
    ]);
  });
  test("rejects repeated pages rather than silently returning an incomplete inventory", async () => {
    const client = createForgejoClient({
      apiURL: "http://forge/api/v1/",
      token: "secret",
      fetch: async () => response({ tree: [file("README.md")], total_count: 2, truncated: false }),
    });
    await expect(client.listFiles(repository, sha)).rejects.toThrow("incomplete");
  });
});

test("finds synchronized pull-request runs without trusting Forgejo's event filter", async () => {
  const client = createForgejoClient({
    apiURL: "http://forge/api/v1/",
    token: "secret",
    fetch: async (input) => {
      const url = new URL(String(input));
      expect(url.searchParams.get("head_sha")).toBe(sha);
      expect(url.searchParams.get("limit")).toBe("20");
      const run = (id: number, event: string, commitSha = sha) => ({
        id,
        html_url: `http://forge/factory/fixture/actions/runs/${id}`,
        commit_sha: commitSha,
        workflow_id: "factory-verification.yml",
        event,
        status: "waiting",
      });
      return response({
        workflow_runs: url.searchParams.has("event")
          ? []
          : [run(2, "pull_request"), run(3, "push"), run(4, "pull_request", "b".repeat(40))],
      });
    },
  });
  expect(await client.listActionRuns(repository, sha)).toEqual([
    {
      id: 2,
      url: "http://forge/factory/fixture/actions/runs/2",
      commitSha: sha,
      workflowID: "factory-verification.yml",
      event: "pull_request",
      status: "waiting",
    },
  ]);
});

describe("Forgejo branch creation", () => {
  test("returns an existing exact branch and rejects a conflicting head", async () => {
    const exact = createForgejoClient({
      apiURL: "http://forge/api/v1/",
      token: "secret",
      fetch: async () => response(branch("factory/change-a")),
    });
    expect(await exact.ensureBranch(repository, "factory/change-a", sha)).toEqual({
      name: "factory/change-a",
      headSha: sha,
    });
    const conflict = createForgejoClient({
      apiURL: "http://forge/api/v1/",
      token: "secret",
      fetch: async () => response(branch("factory/change-a", "b".repeat(40))),
    });
    await expect(conflict.ensureBranch(repository, "factory/change-a", sha)).rejects.toBeInstanceOf(
      ForgeConflictError,
    );
  });

  test("recovers a conflict response by observing the exact branch", async () => {
    let call = 0;
    const client = createForgejoClient({
      apiURL: "http://forge/api/v1/",
      token: "secret",
      fetch: async (_input, init) => {
        call += 1;
        if (call === 1) return new Response(null, { status: 404 });
        if (init?.method === "POST") return new Response(null, { status: 409 });
        return response(branch("factory/change-a"));
      },
    });
    expect(await client.ensureBranch(repository, "factory/change-a", sha)).toEqual({
      name: "factory/change-a",
      headSha: sha,
    });
  });

  test("keeps an unresolved timeout ambiguous", async () => {
    let call = 0;
    const client = createForgejoClient({
      apiURL: "http://forge/api/v1/",
      token: "secret",
      fetch: async () => {
        call += 1;
        if (call === 2) throw new DOMException("timeout", "TimeoutError");
        return new Response(null, { status: 404 });
      },
    });
    await expect(client.ensureBranch(repository, "factory/change-a", sha)).rejects.toBeInstanceOf(
      ForgeAmbiguousWriteError,
    );
  });
});

test("concurrent main protection creation observes the exact result after Forgejo's duplicate 403", async () => {
  let reads = 0;
  const client = createForgejoClient({
    apiURL: "http://forge/api/v1/",
    token: "owned-fixture",
    fetch: async (_input, init) => {
      if (init?.method === "POST") return response({ message: "protection already exists" }, 403);
      if (++reads === 1) return response({}, 404);
      return response({
        rule_name: "main",
        enable_push: false,
        protected_file_patterns: ".forgejo/workflows/factory-verification.yml",
      });
    },
  });
  expect(await client.ensureDefaultBranchProtection(repository, "main")).toMatchObject({
    rule_name: "main",
    enable_push: false,
  });
  expect(reads).toBe(2);
});

test.each(["absent", "writable", "wrong-branch", "unprotected-workflow"])(
  "a denied protection create does not claim success for %s observed state",
  async (boundary) => {
    let reads = 0;
    const client = createForgejoClient({
      apiURL: "http://forge/api/v1/",
      token: "owned-fixture",
      fetch: async (_input, init) => {
        if (init?.method === "POST") return response({}, 403);
        if (++reads === 1 || boundary === "absent") return response({}, 404);
        return response({
          rule_name: boundary === "wrong-branch" ? "other" : "main",
          enable_push: boundary === "writable",
          protected_file_patterns:
            boundary === "unprotected-workflow"
              ? ""
              : ".forgejo/workflows/factory-verification.yml",
        });
      },
    });
    await expect(client.ensureDefaultBranchProtection(repository, "main")).rejects.toThrow("403");
  },
);
