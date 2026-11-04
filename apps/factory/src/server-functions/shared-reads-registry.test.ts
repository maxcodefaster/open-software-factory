import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

// Reads that must never share a request: streams, one-shot session facts and explicit checks.
const notShared = new Set([
  "getAgentActivity",
  "observeChangeWriter",
  "getSignOutDestination",
  "getAuthenticationState",
  "checkSkillSourceUpdate",
  "getBootstrap",
]);

function declared() {
  const found: { file: string; name: string; write: boolean; registered: boolean }[] = [];
  for (const file of readdirSync(import.meta.dir).filter(
    (name) => name.endsWith(".ts") && !name.endsWith(".test.ts"),
  )) {
    const source = readFileSync(join(import.meta.dir, file), "utf8");
    const registered = new Set(
      [...source.matchAll(/registerSharedReads\(([^)]*)\)/g)].flatMap((match) =>
        (match[1] ?? "").split(",").map((name) => name.trim()),
      ),
    );
    const parts = source.split(/\nexport const (\w+) = createServerFn/);
    for (let index = 1; index < parts.length; index += 2) {
      const name = parts[index] ?? "";
      const body = (parts[index + 1] ?? "").split("\nexport ")[0] ?? "";
      found.push({
        file,
        name,
        write: body.includes("beforeWrite"),
        registered: registered.has(name),
      });
    }
  }
  return found;
}

test("only declared reads are shared and every unguarded read is either shared or excluded", () => {
  const functions = declared();
  expect(functions.length).toBeGreaterThan(150);
  expect(functions.filter((item) => item.registered && item.write)).toEqual([]);
  expect(functions.filter((item) => item.registered && notShared.has(item.name))).toEqual([]);
  expect(
    functions.filter((item) => !item.write && !item.registered && !notShared.has(item.name)),
  ).toEqual([]);
});
