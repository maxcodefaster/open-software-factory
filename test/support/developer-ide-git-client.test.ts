import { expect, test } from "bun:test";
import {
  FactoryGitClient,
  factoryGitStatus,
} from "../../deploy/theia-ide/factory-ide-extension/src/browser/factory-git-client";

const workspaceID = "11111111-1111-4111-8111-111111111111";
const base = "https://editor.invalid/editor/22222222-2222-4222-8222-222222222222/1/";

test("Git operations retain the exact Workspace path and never retry a lost mutation", async () => {
  const calls: Array<{ path: string; init?: RequestInit }> = [];
  const client = new FactoryGitClient(
    async (path, init) => {
      calls.push({ path: String(path), ...(init ? { init } : {}) });
      throw new Error("Result unconfirmed");
    },
    () => base,
  );
  const body = { commandID: crypto.randomUUID(), expectedHead: "a".repeat(40), message: "Work" };
  await expect(client.request(workspaceID, "commit", body)).rejects.toThrow("unconfirmed");
  expect(calls).toHaveLength(1);
  expect(calls[0]?.path).toBe(
    `/editor/22222222-2222-4222-8222-222222222222/1/__factory/workspaces/${workspaceID}/git/commit`,
  );
  expect(calls[0]?.init?.credentials).toBe("same-origin");
  expect(JSON.parse(calls[0]?.init?.body as string)).toEqual(body);
});

test("Git status validates exact commits and file identities rather than trusting remote JSON", () => {
  const status = {
    head: "a".repeat(40),
    branch: "main",
    files: [{ path: "app.ts", status: " M" }],
  };
  expect(factoryGitStatus(status)).toEqual(status);
  for (const value of [
    { ...status, head: "main" },
    { ...status, files: [{ path: "app.ts", status: "modified" }] },
    { ...status, files: [{ path: 1, status: " M" }] },
  ])
    expect(() => factoryGitStatus(value)).toThrow("invalid");
});
