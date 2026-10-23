import { expect, test } from "bun:test";
import { scopeRuntimeEmbedding } from "./embedding";
import { brotliCompressSync, gzipSync } from "node:zlib";

test("the Starter can be framed by Factory while retaining its other security directives", async () => {
  const response = scopeRuntimeEmbedding(
    new Response("starter", {
      headers: {
        "content-security-policy":
          "default-src 'self'; script-src 'self'; style-src 'self'; frame-ancestors 'self'",
        "x-content-type-options": "nosniff",
      },
    }),
    "http://127.0.0.1:3000",
  );
  expect(response.headers.get("content-security-policy")).toBe(
    "default-src 'self'; script-src 'self'; style-src 'self'; frame-ancestors 'self' http://127.0.0.1:3000",
  );
  expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  expect(await response.text()).toBe("starter");
});

test("the selection bridge uses a fixed protected runtime script without weakening App script CSP", async () => {
  const path = `/runtime/${crypto.randomUUID()}/app/__factory/review-bridge.js`;
  const response = scopeRuntimeEmbedding(
    new Response("<html><body><button>Keep App behavior</button></body></html>", {
      headers: {
        "content-type": "text/html",
        "content-security-policy": "default-src 'none'; script-src 'nonce-app'",
        "content-length": "20",
      },
    }),
    "https://factory.example",
    path,
  );
  expect(response.headers.get("content-security-policy")).toContain("script-src 'nonce-app'");
  expect(response.headers.get("content-security-policy")).not.toContain("unsafe-inline");
  expect(response.headers.get("content-length")).toBeNull();
  expect(await response.text()).toContain(`<script src="${path}"></script>`);
  expect(() =>
    scopeRuntimeEmbedding(
      new Response("<body>", { headers: { "content-type": "text/html" } }),
      "https://factory.example",
      "/arbitrary/script.js",
    ),
  ).toThrow();
});

test.each(["gzip", "br"])(
  "compressed %s HTML with an implicit body retains working App content and the bridge",
  async (encoding) => {
    const html = "<!doctype html><title>Implicit body</title><button>Working App</button>";
    const content = encoding === "gzip" ? gzipSync(html) : brotliCompressSync(html);
    const path = `/runtime/${crypto.randomUUID()}/app/__factory/review-bridge.js`;
    const response = scopeRuntimeEmbedding(
      new Response(content, {
        headers: { "content-type": "text/html", "content-encoding": encoding },
      }),
      "https://factory.example",
      path,
    );
    expect(response.headers.get("content-encoding")).toBeNull();
    const result = await response.text();
    expect(result).toContain("<button>Working App</button>");
    expect(result).toContain(`<script src="${path}"></script>`);
  },
);

test("only the configured shell and the App itself may frame a runtime response", () => {
  const response = scopeRuntimeEmbedding(
    new Response(null, {
      status: 304,
      headers: { "x-frame-options": "DENY", etag: "original" },
    }),
    "https://factory.example",
  );
  expect(response.status).toBe(304);
  expect(response.headers.get("etag")).toBe("original");
  expect(response.headers.get("x-frame-options")).toBeNull();
  expect(response.headers.get("content-security-policy")).toBe(
    "frame-ancestors 'self' https://factory.example",
  );
  expect(() => scopeRuntimeEmbedding(new Response(), "https://factory.example/other")).toThrow();
  expect(() => scopeRuntimeEmbedding(new Response(), "file:///tmp/factory")).toThrow();
});

test("coalesced policies keep their independent script restrictions", () => {
  const response = scopeRuntimeEmbedding(
    new Response(null, {
      headers: {
        "content-security-policy":
          "default-src 'none'; frame-ancestors 'none', script-src 'nonce-test'; FRAME-ANCESTORS https://other.example",
      },
    }),
    "https://factory.example",
  );
  expect(response.headers.get("content-security-policy")).toBe(
    "default-src 'none'; frame-ancestors 'self' https://factory.example, script-src 'nonce-test'; frame-ancestors 'self' https://factory.example",
  );
});
