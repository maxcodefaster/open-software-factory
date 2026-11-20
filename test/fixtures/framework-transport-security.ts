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
let resolvedContext: unknown;
let rejectCaller = false;
let outcome: () => unknown = () => ({ ok: true });
const clientPackage = core.resolve("@tanstack/start-client-core/package.json");
const { createServerFn } = await import(
  pathToFileURL(join(dirname(clientPackage), "dist/esm/createServerFn.js")).href
);
// Exercise the real generated wrapper, including its server-context merge.
const native = createServerFn({ method: "GET" })
  .middleware([
    {
      options: {
        server: (options: { next(): Promise<unknown> }) => {
          if (rejectCaller) throw new Error("Authentication required");
          return options.next();
        },
      },
    },
  ])
  .handler(
    Object.assign(async () => {}, { serverFnMeta: { id: "security-probe" } }),
    ({ context }: { context: unknown }) => {
      resolvedContext = context;
      return outcome();
    },
  );
const action = Object.assign(
  async (input: Record<string, unknown>) => {
    received = input;
    return native.__executeServer(input);
  },
  { method: "GET" },
);
mock.module(join(directory, "getServerFnById.js"), () => ({ getServerFnById: async () => action }));
const { toJSON } = await import(pathToFileURL(core.resolve("seroval")).href);
const { DeferredResponse, handleServerAction } = await import(
  pathToFileURL(join(directory, "server-functions-handler.js")).href
);
const { createServerEntry } = await import(pathToFileURL(join(directory, "index.js")).href);
const scopeEntry = (await Bun.file(corePackage).json()).exports["./request-scope"].import.default;
const { finalizeResponse, withStartRequest } = await import(
  pathToFileURL(join(dirname(corePackage), scopeEntry)).href
);
const isDeferredResponse = (
  value: unknown,
): value is { createResponse(event: unknown): Response } => value instanceof DeferredResponse;
const responseHandler = (callback: (request: Request) => unknown) =>
  createServerEntry({
    fetch: withStartRequest(async (request: Request, _options: unknown, event: unknown) => {
      const result = await callback(request);
      return finalizeResponse(
        isDeferredResponse(result) ? result.createResponse(event) : result,
        event,
      );
    }),
  }).fetch;
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
const handler = responseHandler((request: Request) =>
  runWithStartContext(
    {
      request,
      startOptions: { serializationAdapters: [] },
      contextAfterGlobalMiddlewares: { principal: "server" },
      executedRequestMiddlewares: new Set(),
    },
    () => handleServerAction({ request, serverFnId: "security-probe" }),
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
  assert.deepEqual(Object.assign({}, resolvedContext), {
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
// Response-shaped return values and thrown values are serialized data, never
// HTTP responses. The native pipeline, not a copied duck-type guard, handles them.
action.method = "GET";
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
  outcome = callback;
  const rejected = await handler(new Request(url));
  assert.ok(rejected instanceof Response);
  assert.ok(rejected.headers.get("content-type")?.startsWith("application/json"));
  assert.equal(rejected.headers.get("x-tss-raw"), null);
  await rejected.arrayBuffer();
}
const legitimate = await responseHandler(() => new Response("App response", { status: 200 }))(
  new Request(url),
);
assert.equal(legitimate.status, 200);
assert.equal(await legitimate.text(), "App response");
console.log("Upstream transport discarded private middleware fields");
