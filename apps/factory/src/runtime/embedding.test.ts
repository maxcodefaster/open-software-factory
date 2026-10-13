import { expect, test } from "bun:test";
import { scopeRuntimeEmbedding } from "./embedding";

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
