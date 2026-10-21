import { test } from "node:test";
import assert from "node:assert/strict";
import { appProxyContext } from "../src/proxy.ts";

const id = "01994a7d-0000-7000-8000-000000000001";
const label = `${id.replaceAll("-", "")}-app.runtime`;
const prefix = `/runtime/${id}/preview/app`;
const headers = {
  "x-forwarded-host": `${label}.localhost:58000`,
  "x-forwarded-proto": "http",
  "x-forwarded-prefix": prefix,
};

test("Factory App context supports loopback and ordinary public wildcard TLS", () => {
  assert.deepEqual(appProxyContext(headers), {
    origin: `http://${label}.localhost:58000`,
    basePath: prefix,
  });
  assert.deepEqual(
    appProxyContext({
      ...headers,
      "x-forwarded-proto": "https",
      "x-forwarded-host": `${label}.factory.example.com`,
    }),
    { origin: `https://${label}.factory.example.com`, basePath: prefix },
  );
});

test("invalid forwarding cannot mix Runtime Attempts or add credentials, paths and non-TLS public origins", () => {
  for (const host of [
    `${"a".repeat(32)}-app.runtime.localhost:58000`,
    `${label}.localhost:58000/path`,
    `${label}.localhost:58000?redirect=other`,
    `${label}.localhost:58000#other`,
    `key@${label}.localhost:58000`,
    `${label}.factory.example.com`,
    `${label}.bad..example`,
    `${label}.localhost@other.example`,
    `${label}.localhost:99999`,
    `${id.replaceAll("-", "")}.app.runtime.localhost:58000`,
  ])
    assert.equal(appProxyContext({ ...headers, "x-forwarded-host": host }), undefined);
  assert.equal(appProxyContext({ ...headers, "x-forwarded-proto": "javascript" }), undefined);
  assert.equal(
    appProxyContext({ ...headers, "x-forwarded-prefix": "/runtime/other/app" }),
    undefined,
  );
  assert.equal(appProxyContext({ ...headers, "x-forwarded-prefix": `${prefix}/..` }), undefined);
});
