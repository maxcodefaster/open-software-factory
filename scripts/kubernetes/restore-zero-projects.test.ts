import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { projectRows, readRestoredProjects, type ZeroProjectRead } from "./restore-zero-projects";

const user = "00000000-0000-4000-8000-000000000001";
const project = {
  id: "00000000-0000-4000-8000-000000000002",
  name: "Owned restored Project",
  slug: "owned",
  repositoryUrl: "https://git.restore.test/owned/repo.git",
  defaultBranch: "main",
  devcontainerPath: ".devcontainer/devcontainer.json",
};
let directory: string, ca: string, cert: string, key: string, foreignCA: string;
async function openssl(...args: string[]) {
  const child = Bun.spawn(["openssl", ...args], { stdout: "ignore", stderr: "ignore" });
  if (await child.exited) throw Error("Local test certificate generation failed");
}
beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "restore-zero-tls-"));
  const root = join(directory, "root.pem"),
    rootKey = join(directory, "root.key");
  await openssl(
    "req",
    "-x509",
    "-newkey",
    "ec",
    "-pkeyopt",
    "ec_paramgen_curve:prime256v1",
    "-pkeyopt",
    "ec_param_enc:named_curve",
    "-nodes",
    "-days",
    "2",
    "-subj",
    "/CN=Owned restore root",
    "-addext",
    "basicConstraints=critical,CA:TRUE",
    "-keyout",
    rootKey,
    "-out",
    root,
  );
  await openssl(
    "req",
    "-newkey",
    "ec",
    "-pkeyopt",
    "ec_paramgen_curve:prime256v1",
    "-pkeyopt",
    "ec_param_enc:named_curve",
    "-nodes",
    "-subj",
    "/CN=factory.restore.test",
    "-keyout",
    join(directory, "leaf.key"),
    "-out",
    join(directory, "leaf.csr"),
  );
  await writeFile(
    join(directory, "leaf.cnf"),
    "subjectAltName=DNS:factory.restore.test\nbasicConstraints=critical,CA:FALSE\nextendedKeyUsage=serverAuth\n",
  );
  await openssl(
    "x509",
    "-req",
    "-in",
    join(directory, "leaf.csr"),
    "-CA",
    root,
    "-CAkey",
    rootKey,
    "-set_serial",
    "42",
    "-days",
    "2",
    "-extfile",
    join(directory, "leaf.cnf"),
    "-out",
    join(directory, "leaf.pem"),
  );
  await openssl(
    "req",
    "-x509",
    "-newkey",
    "ec",
    "-pkeyopt",
    "ec_paramgen_curve:prime256v1",
    "-pkeyopt",
    "ec_param_enc:named_curve",
    "-nodes",
    "-days",
    "2",
    "-subj",
    "/CN=Foreign test root",
    "-addext",
    "basicConstraints=critical,CA:TRUE",
    "-keyout",
    join(directory, "foreign.key"),
    "-out",
    join(directory, "foreign.pem"),
  );
  [ca, cert, key, foreignCA] = (await Promise.all(
    ["root.pem", "leaf.pem", "leaf.key", "foreign.pem"].map((p) =>
      readFile(join(directory, p), "utf8"),
    ),
  )) as [string, string, string, string];
});
afterAll(async () => {
  if (directory) await rm(directory, { recursive: true, force: true });
});

type Mode =
  | "complete"
  | "empty"
  | "unknown"
  | "query-error"
  | "ast-only"
  | "oversize"
  | "redirect"
  | "unauthorized"
  | "delayed";
async function server(mode: Mode) {
  // Only the local fake service encodes protocol frames. The reader uses the
  // real installed SDK, including its binary-poke decoder and completion logic.
  const { PokeChunkEncoder } = await import(
    new URL("../../zero-cache/src/types/poke-chunk.js", import.meta.resolve("@rocicorp/zero")).href
  );
  let requests = 0,
    active = 0,
    messages = 0,
    sent = false;
  const closed = new Set<() => void>();
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const observations: { host: string | null; origin: string | null; cookie: string | null }[] = [];
  type Data = { clientID: string; initial: unknown };
  const host = Bun.serve<Data>({
    hostname: "127.0.0.1",
    port: 0,
    tls: { cert, key },
    fetch(request, service) {
      requests++;
      const url = new URL(request.url);
      observations.push({
        host: request.headers.get("host"),
        origin: request.headers.get("origin"),
        cookie: request.headers.get("cookie"),
      });
      if (mode === "redirect")
        return new Response(null, { status: 302, headers: { location: `${url.origin}/foreign` } });
      if (mode === "unauthorized" || request.headers.get("cookie") !== "owned-test-session=fixture")
        return new Response("denied", { status: 401 });
      if (url.pathname !== "/zero/sync/v52/connect" || url.searchParams.get("userID") !== user)
        return new Response("wrong route", { status: 400 });
      const protocol = request.headers.get("sec-websocket-protocol") ?? "";
      const initial = JSON.parse(
        Buffer.from(decodeURIComponent(protocol), "base64").toString(),
      ).initConnectionMessage;
      if (
        !service.upgrade(request, {
          headers: { "sec-websocket-protocol": protocol },
          data: { clientID: url.searchParams.get("clientID") ?? "", initial },
        })
      )
        return new Response("upgrade failed", { status: 400 });
    },
    websocket: {
      open(socket) {
        active++;
        socket.send(JSON.stringify(["connected", { wsid: "owned-test" }]));
        if (socket.data.initial) void respond(socket, socket.data.initial);
      },
      message(socket, message) {
        messages++;
        const parsed = JSON.parse(String(message));
        if (parsed[0] === "ping") socket.send('["pong",{}]');
        else void respond(socket, parsed);
      },
      close() {
        active--;
        if (active === 0) for (const done of closed) done();
      },
    },
  });
  async function respond(socket: Bun.ServerWebSocket<Data>, message: unknown) {
    const [tag, body] = message as [
      string,
      { desiredQueriesPatch?: { op: string; hash: string; name: string; args: unknown[] }[] },
    ];
    if (!["initConnection", "changeDesiredQueries"].includes(tag)) return;
    const put = body.desiredQueriesPatch?.find((p) => p.op === "put");
    if (!put || sent) return;
    expect(put.name).toBe("projects.list");
    expect(put.args).toEqual([]);
    sent = true;
    if (mode === "unknown") return;
    if (mode === "ast-only") {
      socket.send(JSON.stringify({ kind: "QueryResponse", userID: user, queries: [{ ast: {} }] }));
      return;
    }
    if (mode === "oversize") {
      socket.send("x".repeat(300_000));
      return;
    }
    if (mode === "query-error") {
      socket.send(
        JSON.stringify([
          "transformError",
          [{ id: put.hash, name: "projects.list", error: "app", message: "owned fixture refusal" }],
        ]),
      );
      return;
    }
    const publish = async () => {
      if (socket.readyState !== 1) return;
      socket.send(JSON.stringify(["pokeStart", { pokeID: "owned-poke", baseCookie: null }]));
      const encoder = new PokeChunkEncoder(37);
      const rows =
        mode === "empty"
          ? []
          : [
              {
                op: "put",
                tableName: "factory.project",
                value: {
                  id: project.id,
                  slug: project.slug,
                  name: project.name,
                  repository_url: project.repositoryUrl,
                  default_branch: project.defaultBranch,
                  devcontainer_path: project.devcontainerPath,
                  desktop_background_key: "river-landscape",
                  created_at: 1,
                  updated_at: 1,
                },
              },
            ];
      await encoder.addPatch(
        JSON.stringify({
          pokeID: "owned-poke",
          rowsPatch: rows,
          lastMutationIDChanges: { [socket.data.clientID]: 0 },
          gotQueriesPatch: [{ op: "put", hash: put.hash }],
        }),
        async (chunk: Uint8Array) => {
          socket.send(Buffer.from(chunk));
        },
      );
      await encoder.finish(async (chunk: Uint8Array) => {
        socket.send(Buffer.from(chunk));
      });
      socket.send(JSON.stringify(["pokeEnd", { pokeID: "owned-poke", cookie: "0001" }]));
    };
    if (mode === "delayed") {
      const timer = setTimeout(() => {
        timers.delete(timer);
        void publish();
      }, 180);
      timers.add(timer);
    } else await publish();
  }
  const origin = `https://factory.restore.test:${host.port}`;
  const input: ZeroProjectRead = {
    owner: "a".repeat(32),
    factoryOrigin: origin,
    address: "127.0.0.1",
    ca,
    cookie: "owned-test-session=fixture",
    accountID: user,
    systemManager: true,
    cacheScope: "b".repeat(64),
    seconds: 5,
    responseBytes: 256 * 1024,
  };
  return {
    input,
    observations,
    requests: () => requests,
    active: () => active,
    messages: () => messages,
    async settled() {
      if (active === 0) return;
      await new Promise<void>((accept, reject) => {
        const done = () => {
          clearTimeout(timer);
          closed.delete(done);
          accept();
        };
        const timer = setTimeout(() => {
          closed.delete(done);
          reject(Error("Owned fake service did not observe socket close"));
        }, 1000);
        closed.add(done);
      });
    },
    async close() {
      for (const timer of timers) clearTimeout(timer);
      await host.stop(true);
    },
  };
}
test("real SDK decodes chunked completed rows over pinned CA TLS without resolving the original DNS name", async () => {
  const fake = await server("complete");
  try {
    expect(await readRestoredProjects(fake.input, AbortSignal.timeout(7000))).toEqual([project]);
    await fake.settled();
    expect(fake.requests()).toBe(1);
    expect(fake.active()).toBe(0);
    expect(fake.observations).toEqual([
      {
        host: new URL(fake.input.factoryOrigin).host,
        origin: fake.input.factoryOrigin,
        cookie: fake.input.cookie,
      },
    ]);
  } finally {
    await fake.close();
  }
}, 10_000);
test("a completed empty list is distinct from initial unknown data", async () => {
  const fake = await server("empty");
  try {
    expect(await readRestoredProjects(fake.input, AbortSignal.timeout(7000))).toEqual([]);
  } finally {
    await fake.close();
  }
});
test("unknown local empty data does not resolve before real completed rows", async () => {
  const fake = await server("delayed");
  try {
    const started = Date.now();
    expect(await readRestoredProjects(fake.input, AbortSignal.timeout(7000))).toEqual([project]);
    expect(Date.now() - started).toBeGreaterThanOrEqual(180);
  } finally {
    await fake.close();
  }
});
test.each(["ast-only", "query-error", "oversize", "redirect", "unauthorized", "unknown"] as const)(
  "rejects %s and joins its child/socket",
  async (mode) => {
    const fake = await server(mode);
    try {
      await expect(
        readRestoredProjects({ ...fake.input, seconds: 1 }, AbortSignal.timeout(3000)),
      ).rejects.toThrow("refused");
      await fake.settled();
      expect(fake.active()).toBe(0);
      expect(fake.requests()).toBeLessThanOrEqual(1);
    } finally {
      await fake.close();
    }
  },
);
test.each(["foreign CA", "wrong expected hostname"] as const)(
  "strict TLS rejects %s before the authenticated upgrade",
  async (mode) => {
    const fake = await server("complete");
    try {
      const input = {
        ...fake.input,
        ...(mode === "foreign CA"
          ? { ca: foreignCA }
          : {
              factoryOrigin: fake.input.factoryOrigin.replace(
                "factory.restore.test",
                "wrong.restore.test",
              ),
            }),
      };
      await expect(readRestoredProjects(input, AbortSignal.timeout(5000))).rejects.toThrow(
        "refused",
      );
      await fake.settled();
      expect(fake.requests()).toBe(0);
      expect(fake.active()).toBe(0);
    } finally {
      await fake.close();
    }
  },
);
test("cancellation reaps the same owned child and leaves no open socket or global constructor substitution", async () => {
  const fake = await server("unknown"),
    original = globalThis.WebSocket;
  const cancel = new AbortController();
  const timer = setTimeout(() => cancel.abort(), 250);
  try {
    await expect(readRestoredProjects(fake.input, cancel.signal)).rejects.toThrow("refused");
    await fake.settled();
    expect(fake.active()).toBe(0);
    expect(globalThis.WebSocket).toBe(original);
  } finally {
    clearTimeout(timer);
    await fake.close();
  }
});
test("rejects AST-only and duplicate/malformed row payloads without a network fallback", () => {
  expect(() => projectRows({ kind: "QueryResponse", queries: [{ ast: {} }] })).toThrow();
  expect(() => projectRows([project, project])).toThrow();
  expect(() => projectRows([{ ...project, repositoryUrl: null }])).toThrow();
});
