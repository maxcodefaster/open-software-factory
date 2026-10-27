import { expect, test } from "bun:test";
import { createForgejoAccess, forgeUsername } from "./access";
import { fixtureValue } from "../../../test/fixtures/value";

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
