import { expect, test } from "bun:test";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { createExternalFactoryMCP } from "./external";

async function checkoutPages(content: Uint8Array) {
  const workspaceID = crypto.randomUUID();
  const userID = crypto.randomUUID();
  let version = "owned-version";
  let reads = 0;
  const handler = createExternalFactoryMCP({
    factoryOrigin: "http://127.0.0.1",
    factoryAuth: {
      async mcpSession(request: Request) {
        if (request.headers.get("x-owned-test-principal") !== userID)
          throw new Error("Unknown owned principal");
        return { userID, scopes: ["factory:read"] };
      },
    },
    workspaceSources: {
      async forward(id: string, actor: string, operation: string, request: Request) {
        expect([id, actor, operation]).toEqual([workspaceID, userID, "read"]);
        expect(await request.json()).toEqual({ path: "text.txt" });
        reads++;
        return Response.json({ content: Buffer.from(content).toString("base64"), version });
      },
    },
    runtimeController: {
      async start() {
        throw new Error("Checkout paging must not start compute");
      },
      async startPersisted() {
        throw new Error("Checkout paging must not start compute");
      },
    },
  } as unknown as Parameters<typeof createExternalFactoryMCP>[0]);
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: handler });
  const client = new Client({ name: "owned-checkout-pages", version: "1.0.0" });
  try {
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${server.port}/api/mcp`), {
        requestInit: { headers: { "x-owned-test-principal": userID } },
      }),
    );
  } catch (cause) {
    await client.close();
    await server.stop(true);
    throw cause;
  }
  return {
    get reads() {
      return reads;
    },
    changeVersion() {
      version = "changed-version";
    },
    async read(offset: number, limit: number, expectedVersion?: string) {
      const result = await client.callTool({
        name: "readFile",
        arguments: { workspaceID, path: "text.txt", offset, limit, expectedVersion },
      });
      if (!("content" in result)) throw new Error("Missing MCP content");
      const text = result.content.find((part) => part.type === "text");
      if (text?.type !== "text") throw new Error("Missing MCP text");
      return { result, page: JSON.parse(text.text) };
    },
    async dispose() {
      await client.close();
      await server.stop(true);
    },
  };
}

test("checkout MCP text pages reconstruct multibyte text using returned byte offsets", async () => {
  const f = await checkoutPages(Buffer.from("A€B"));
  try {
    const first = await f.read(0, 2);
    expect(first.result.isError).not.toBe(true);
    expect(first.page).toMatchObject({ content: "A", nextOffset: 1, bytes: 5 });
    const second = await f.read(first.page.nextOffset, 3, first.page.version);
    expect(second.page).toMatchObject({ content: "€", nextOffset: 4, bytes: 5 });
    const last = await f.read(second.page.nextOffset, 1, first.page.version);
    expect(last.page).toMatchObject({ content: "B", nextOffset: null, bytes: 5 });
    expect(first.page.content + second.page.content + last.page.content).toBe("A€B");
  } finally {
    await f.dispose();
  }
});

test("checkout MCP respects its maximum byte budget when the last character is split", async () => {
  const text = `A${"😀".repeat(4096)}B`;
  const f = await checkoutPages(Buffer.from(text));
  try {
    const first = await f.read(0, 16384);
    expect(first.result.isError).not.toBe(true);
    expect(Buffer.byteLength(first.page.content)).toBe(16381);
    expect(first.page.nextOffset).toBe(16381);
    const second = await f.read(first.page.nextOffset, 4, first.page.version);
    const last = await f.read(second.page.nextOffset, 1, first.page.version);
    expect(second.page.content).toBe("😀");
    expect(last.page.nextOffset).toBeNull();
    expect(first.page.content + second.page.content + last.page.content).toBe(text);
  } finally {
    await f.dispose();
  }
});

test("checkout paging retains changed-version rejection before decoding a page", async () => {
  const f = await checkoutPages(Buffer.from("A€B"));
  try {
    const first = await f.read(0, 1);
    f.changeVersion();
    const changed = await f.read(1, 3, first.page.version);
    expect(changed.result.isError).toBe(true);
    expect(changed.page.error).toEqual({
      code: "conflict",
      message: "File changed between pages",
    });
    expect(f.reads).toBe(2);
  } finally {
    await f.dispose();
  }
});

test("checkout MCP paging preserves two-, three- and four-byte characters and BOMs", async () => {
  const text = "\ufeffA¢€😀B\ufeff�\x00é界🦊";
  const bytes = Buffer.byteLength(text);
  const f = await checkoutPages(Buffer.from(text));
  try {
    for (const limit of [4, 5, 6, 7]) {
      let offset = 0;
      let content = "";
      let version: string | undefined;
      for (;;) {
        const { result, page } = await f.read(offset, limit, version);
        expect(result.isError).not.toBe(true);
        expect(page.bytes).toBe(bytes);
        version ??= page.version;
        expect(page.version).toBe(version);
        const length = Buffer.byteLength(page.content);
        expect(length).toBeLessThanOrEqual(limit);
        content += page.content;
        if (page.nextOffset === null) {
          expect(offset + length).toBe(bytes);
          break;
        }
        expect(page.nextOffset).toBe(offset + length);
        expect(page.nextOffset).toBeGreaterThan(offset);
        offset = page.nextOffset;
      }
      expect(content).toBe(text);
    }
    expect((await f.read(bytes, 1)).page).toMatchObject({ content: "", nextOffset: null });
    const pastEnd = await f.read(bytes + 1, 1);
    expect(pastEnd.result.isError).toBe(true);
    expect(pastEnd.page.error.code).toBe("invalid");
  } finally {
    await f.dispose();
  }
});

test("checkout MCP rejects continuation offsets and budgets too small for the next character", async () => {
  const f = await checkoutPages(Buffer.from("A¢€😀B"));
  try {
    for (const offset of [2, 4, 5, 7, 8, 9]) {
      const { result, page } = await f.read(offset, 4);
      expect(result.isError).toBe(true);
      expect(page.error.code).toBe("invalid");
      expect(page.error.message).toContain("character boundary");
    }
    for (const [offset, limit] of [
      [1, 1],
      [3, 2],
      [6, 3],
    ] as const) {
      const { result, page } = await f.read(offset, limit);
      expect(result.isError).toBe(true);
      expect(page.error.code).toBe("invalid");
      expect(page.error.message).toContain("increase limit");
    }
  } finally {
    await f.dispose();
  }
});

test("checkout MCP never replaces malformed UTF-8 or truncated EOF bytes with replacement characters", async () => {
  for (const content of [
    [0x80],
    [0xc0, 0xaf],
    [0xe0, 0x80, 0x80],
    [0xed, 0xa0, 0x80],
    [0xf0, 0x80, 0x80, 0x80],
    [0xf4, 0x90, 0x80, 0x80],
    [0xf5, 0x80, 0x80, 0x80],
    [0xff],
    [0x41, 0xe2, 0x82],
    [0x41, 0xe2, 0x28, 0xa1],
    [0x41, 0xe2, 0x82, 0x42],
  ]) {
    const f = await checkoutPages(Uint8Array.from(content));
    try {
      const { result, page } = await f.read(0, 2);
      expect(result.isError).toBe(true);
      expect(page.error.code).toBe("invalid");
      expect(page.error.message).toContain("invalid encoding");
      expect(page.error.message).toContain("binary file transfer");
    } finally {
      await f.dispose();
    }
  }
});
