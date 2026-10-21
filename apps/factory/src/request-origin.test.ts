import { expect, test } from "bun:test";
import { factoryRequestURL } from "./request-origin";
import { appRuntimeOrigin } from "./runtime-origins";
import { developerIDEOrigin } from "./developer-ide-origin";

const factory = "https://factory.example.com";
const id = "01994a7d-0000-7000-8000-000000000001";

test("configured public identities survive TLS termination without trusting forwarded headers", () => {
  for (const publicOrigin of [
    factory,
    appRuntimeOrigin(factory, id, "app"),
    developerIDEOrigin(factory, id, 1),
  ]) {
    const incoming = new URL("/runtime/path?version=1", publicOrigin);
    incoming.protocol = "http:";
    const request = new Request(incoming, {
      headers: { "x-forwarded-proto": "http", "x-forwarded-host": "other.example" },
    });
    expect(factoryRequestURL(request, factory).href).toBe(`${publicOrigin}/runtime/path?version=1`);
  }
});

test("internal, foreign, nested and different-listener requests cannot claim a public identity", () => {
  for (const incoming of [
    "http://factory-internal.factory.svc:3000/path",
    "http://unrelated.example/path",
    "http://factory.example.com.unrelated.example/path",
    "http://one.two.runtime.factory.example.com/path",
    "http://factory.example.com:8443/path",
    "http://one.runtime.factory.example.com:8443/path",
  ]) {
    const request = new Request(incoming, {
      headers: {
        "x-forwarded-proto": "https",
        "x-forwarded-host": "factory.example.com",
        forwarded: "proto=https;host=factory.example.com",
      },
    });
    expect(factoryRequestURL(request, factory).href).toBe(incoming);
  }
  const local = new Request("http://127.0.0.1:58000/path", {
    headers: { "x-forwarded-proto": "https" },
  });
  expect(factoryRequestURL(local, "http://127.0.0.1:58000").href).toBe(local.url);
  expect(factoryRequestURL(local).href).toBe(local.url);
});

test("non-default public ports and loopback editor listeners stay distinct", () => {
  for (const publicFactory of ["https://factory.example.com:8443", "https://127.0.0.1:58000"]) {
    const publicEditor = developerIDEOrigin(publicFactory, id, 1);
    const incoming = new URL("/editor/route", publicEditor);
    incoming.protocol = "http:";
    expect(factoryRequestURL(new Request(incoming), publicFactory).href).toBe(
      `${publicEditor}/editor/route`,
    );
    incoming.port = "58001";
    expect(factoryRequestURL(new Request(incoming), publicFactory).href).toBe(incoming.href);
  }
});
