import { describe, expect, test } from "bun:test";
import { fixtureValue } from "../../../test/fixtures/value";
import { createForgejoAccess, forgeUsername } from "./access";

test("alternative-grant reconciliation inventories every page before removals shift offsets", async () => {
  const id = crypto.randomUUID();
  const username = forgeUsername(id);
  const repositories = Array.from({ length: 75 }, (_, index) => ({
    name: `repo-${index}`,
    private: true,
    owner: { login: "owned" },
  }));
  const removed: string[] = [];
  const adapter = createForgejoAccess({
    apiURL: "https://forge.invalid/api/v1/",
    token: "owned-test-token",
    fetch: async (input, init) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith(`/users/${username}`))
        return Response.json({
          id: 2,
          login: username,
          login_name: id,
          source_id: 1,
          active: true,
          prohibit_login: false,
          is_admin: false,
          restricted: true,
        });
      if (url.pathname.endsWith("/orgs")) return Response.json([]);
      if (url.pathname.endsWith("/repos/search")) {
        const offset = (Number(url.searchParams.get("page")) - 1) * 50;
        return Response.json({ data: repositories.slice(offset, offset + 50) });
      }
      if (init?.method === "DELETE") {
        const name = fixtureValue(url.pathname.split("/")[4], 'url.pathname.split("/")[4]');
        removed.push(name);
        const index = repositories.findIndex((repo) => repo.name === name);
        repositories.splice(index, 1);
        return new Response(null, { status: 204 });
      }
      return new Response(null, { status: 404 });
    },
  });
  await adapter.removeAlternativeGrants(id);
  expect(removed).toHaveLength(75);
  expect(repositories).toEqual([]);
});

describe("branch access protection confirmation", () => {
  const workflow = ".forgejo/workflows/factory-verification.yml";
  const protection = {
    rule_name: "main",
    enable_push: false,
    enable_push_whitelist: false,
    push_whitelist_usernames: [],
    push_whitelist_teams: [],
    push_whitelist_deploy_keys: false,
    enable_merge_whitelist: true,
    merge_whitelist_usernames: ["factory"],
    merge_whitelist_teams: [],
    apply_to_admins: true,
  };

  for (const path of ["created", "updated", "recovered"]) {
    test.each(["omitted", "empty", "different", "partial"])(
      `${path} protection rejects %s requested file protection`,
      async (boundary) => {
        let written = false;
        const requested = boundary === "partial" ? `${workflow};secrets/**` : workflow;
        const adapter = createForgejoAccess({
          apiURL: "https://forge.invalid/api/v1/",
          token: "owned-administration",
          fetch: async (_input, init) => {
            if (init?.method !== "GET") {
              expect(JSON.parse(String(init?.body)).protected_file_patterns).toBe(requested);
              written = true;
              if (path === "recovered") throw new TypeError("fetch failed after protection");
              return Response.json({});
            }
            if (!written && path === "created") return new Response(null, { status: 404 });
            return Response.json({
              ...protection,
              ...(boundary === "omitted"
                ? {}
                : {
                    protected_file_patterns:
                      boundary === "empty" ? "" : boundary === "partial" ? workflow : "secrets/**",
                  }),
            });
          },
        });
        await expect(
          adapter.protectBranch({
            owner: "factory",
            repository: "fixture",
            branch: "main",
            writers: [],
            merger: "factory",
            protectedFiles: requested,
          }),
        ).rejects.toThrow("protection was not confirmed");
        expect(written).toBe(true);
      },
    );

    test.each(["omitted", "empty", "workflow"])(
      `${path} healthy protection preserves %s file request and administration authority`,
      async (files) => {
        const protectedFiles = files === "omitted" ? undefined : files === "empty" ? "" : workflow;
        let written = false;
        const observed = {
          ...protection,
          protected_file_patterns: protectedFiles ?? "secrets/**",
        };
        const adapter = createForgejoAccess({
          apiURL: "https://forge.invalid/api/v1/",
          token: "owned-administration",
          fetch: async (_input, init) => {
            expect(new Headers(init?.headers).get("authorization")).toBe(
              "Bearer owned-administration",
            );
            if (init?.method !== "GET") {
              const body = JSON.parse(String(init?.body));
              expect(body.protected_file_patterns).toBe(protectedFiles);
              if (protectedFiles === undefined)
                expect(body).not.toHaveProperty("protected_file_patterns");
              written = true;
              if (path === "recovered") throw new TypeError("fetch failed after protection");
              return Response.json(observed);
            }
            if (!written && path === "created") return new Response(null, { status: 404 });
            return Response.json(observed);
          },
        });
        await adapter.protectBranch({
          owner: "factory",
          repository: "fixture",
          branch: "main",
          writers: [],
          merger: "factory",
          ...(protectedFiles === undefined ? {} : { protectedFiles }),
        });
        expect(written).toBe(true);
      },
    );
  }
});
