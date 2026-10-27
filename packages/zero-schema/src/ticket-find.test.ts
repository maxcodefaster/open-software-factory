import { expect, test } from "bun:test";
import { addContextToQuery, asQueryInternals } from "@rocicorp/zero/bindings";
import { zeroQueries } from "./index";

const projectId = "00000000-0000-4000-8000-000000000001";
const userId = "00000000-0000-4000-8000-000000000002";
function query(text: string) {
  return JSON.stringify(
    asQueryInternals(
      addContextToQuery(zeroQueries.tickets.find({ projectId, text }), {
        userId,
        systemManager: false,
      }),
    ).ast,
  );
}

test("quick-find admits a copied six-character reference with or without TCK-", () => {
  const prefixed = query("TCK-AbCdEf");
  const bare = query("ABCDEF");
  expect(bare).toBe(prefixed.replace("%TCK-AbCdEf%", "%ABCDEF%"));
  expect(bare).toContain("abcdef00-0000-0000-0000-000000000000");
  expect(bare).toContain("abcdf000-0000-0000-0000-000000000000");
  expect(bare).toContain("projectMembership");
  expect(bare).toContain(projectId);
  expect(bare).toContain(userId);
});

test("ordinary title words do not become partial hexadecimal references", () => {
  expect(query("cafe")).not.toContain('"name":"id"');
  expect(query("invoice")).toContain("%invoice%");
  expect(query("TCK-abc")).toContain("abc00000-0000-0000-0000-000000000000");
});
