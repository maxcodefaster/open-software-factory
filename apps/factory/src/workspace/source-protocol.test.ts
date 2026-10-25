import { expect, test } from "bun:test";
import { createWorkspaceSourceProtocol } from "./source-protocol";

test("Theia retains only the scoped file/watch protocol, never product lifecycle HTTP", async () => {
  const workspace = crypto.randomUUID(),
    actor = crypto.randomUUID();
  const calls: unknown[][] = [];
  const response = new Response(new Uint8Array([1, 2, 3]));
  const protocol = createWorkspaceSourceProtocol({
    async forward(...args) {
      calls.push(args);
      return response;
    },
  });
  for (const operation of ["", "/ensure", "/stop", "/unknown"]) {
    expect(
      await protocol(
        new Request(`https://factory.test/api/workspaces/${workspace}/source${operation}`),
        actor,
      ),
    ).toBeUndefined();
  }
  for (const path of [
    `/api/projects/${crypto.randomUUID()}/source-workspace/ensure`,
    `/api/changes/${crypto.randomUUID()}/source-workspace/ensure`,
    "/api/developer-ide",
    "/api/developer-ide/stop",
  ])
    expect(
      await protocol(new Request(`https://factory.test${path}`, { method: "POST" }), actor),
    ).toBeUndefined();
  expect(calls).toEqual([]);
  for (const operation of [
    "stat",
    "list",
    "read",
    "write",
    "mkdir",
    "rename",
    "delete",
    "search",
    "events",
  ]) {
    const request = new Request(
      `https://factory.test/api/workspaces/${workspace}/source/${operation}`,
      {
        method: operation === "events" ? "GET" : "POST",
        ...(operation === "events" ? {} : { body: new Uint8Array([4, 5, 6]) }),
      },
    );
    expect(await protocol(request, actor)).toBe(response);
    expect(calls.at(-1)).toEqual([workspace, actor, operation, request]);
  }
});
