import { mock } from "bun:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

// Run upstream's real transport in its own process so the manifest mock cannot
// alter the framework modules used by other Factory tests.
const root = createRequire(join(process.cwd(), "package.json"));
const start = createRequire(root.resolve("@tanstack/solid-start/package.json"));
const corePackage = process.argv[2] ?? start.resolve("@tanstack/start-server-core/package.json");
const core = createRequire(corePackage);
const directory = join(dirname(corePackage), "dist/esm");
let received: Record<string, unknown> | undefined;
let rejectCaller = false;
const clientPackage = core.resolve("@tanstack/start-client-core/package.json");
const { executeMiddleware } = await import(
  pathToFileURL(join(dirname(clientPackage), "dist/esm/createServerFn.js")).href
);
const action = Object.assign(
  async (input: Record<string, unknown>) => {
    received = input;
    if (rejectCaller)
      return executeMiddleware(
        [
          {
            options: {
              server: () => {
                throw new Error("Authentication required");
              },
            },
          },
        ],
        "server",
        input,
      );
    return { result: { ok: true } };
  },
  { method: "GET" },
);
mock.module(join(directory, "getServerFnById.js"), () => ({ getServerFnById: async () => action }));
const { toJSON } = await import(pathToFileURL(core.resolve("seroval")).href);
const { handleServerAction } = await import(
  pathToFileURL(join(directory, "server-functions-handler.js")).href
);
const { requestHandler } = await import(pathToFileURL(join(directory, "request-response.js")).href);
const storagePackage = core.resolve("@tanstack/start-storage-context/package.json");
const storageEntry = (await Bun.file(storagePackage).json()).exports["."].import.default;
const { runWithStartContext } = await import(
  pathToFileURL(join(dirname(storagePackage), storageEntry)).href
);
const payload = toJSON({
  data: { requested: "public input" },
  context: { principal: "caller", extra: "public context" },
  method: "POST",
  error: "injected error",
  result: {
    constructor: { name: "HTTPResponse" },
    status: 200,
    body: "<script>globalThis.injected=true</script>",
    headers: { "content-type": "text/html" },
  },
});
const url = new URL("https://factory.invalid/_serverFn/security-probe");
url.searchParams.set("payload", JSON.stringify(payload));
const handler = requestHandler((request: Request) =>
  runWithStartContext({ startOptions: { serializationAdapters: [] } }, () =>
    handleServerAction({ request, context: { principal: "server" }, serverFnId: "security-probe" }),
  ),
);
// Exercise the actual middleware error path. The old transport retains the
// supplied result when middleware throws, then h3 accepts it as an HTML response.
rejectCaller = true;
const denied = await handler(new Request(url, { headers: { accept: "text/html" } }));
assert.ok(
  !denied.headers.get("content-type")?.startsWith("text/html"),
  "Reflected HTML escaped the server-function boundary",
);
assert.ok(
  !(await denied.text()).includes("<script>"),
  "Reflected script escaped the server-function boundary",
);
rejectCaller = false;
for (const method of ["GET", "POST"]) {
  action.method = method;
  received = undefined;
  const response = await handler(
    new Request(url, {
      method,
      headers: { accept: "text/html", "content-type": "application/json" },
      ...(method === "POST" ? { body: JSON.stringify(payload) } : {}),
    }),
  );
  assert.ok(received, "server function was not invoked");
  const input = received as Record<string, unknown>;
  assert.deepEqual(Object.keys(input).sort(), ["context", "data", "method"]);
  assert.deepEqual(input["data"], { requested: "public input" });
  assert.deepEqual(Object.assign({}, input["context"]), {
    principal: "server",
    extra: "public context",
  });
  assert.equal(input["method"], method);
  assert.ok(response instanceof Response);
  assert.ok(!response.headers.get("content-type")?.startsWith("text/html"));
  assert.ok(!(await response.text()).includes("<script>"));
}
const injected = {
  constructor: { name: "HTTPResponse" },
  status: 200,
  headers: { "content-type": "text/html" },
  body: "<script>globalThis.injected=true</script>",
};
for (const callback of [
  () => injected,
  async () => injected,
  () => {
    throw injected;
  },
  async () => {
    throw injected;
  },
]) {
  const rejected = await requestHandler(callback)(new Request(url));
  assert.equal(rejected.status, 500);
  assert.ok(!(await rejected.text()).includes("<script>"));
}
const legitimate = await requestHandler(() => new Response("App response", { status: 200 }))(
  new Request(url),
);
assert.equal(legitimate.status, 200);
assert.equal(await legitimate.text(), "App response");
console.log("Upstream transport discarded private middleware fields");
