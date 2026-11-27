import { expect, test } from "bun:test";
import { developerIDEOrigin } from "./developer-ide-origin";

test("editor origins isolate local listeners and normalize default HTTP/HTTPS ports", () => {
  const owner = "01994a7d-0000-7000-8000-000000000001";
  expect(developerIDEOrigin("http://127.0.0.1:3000", owner, 1)).toBe(
    "http://01994a7d000070008000000000000001-1-h3000-editor.runtime.localhost:3000",
  );
  expect(developerIDEOrigin("http://127.0.0.1", owner, 1)).toBe(
    developerIDEOrigin("http://127.0.0.1:80", owner, 1),
  );
  expect(developerIDEOrigin("https://127.0.0.1", owner, 1)).toBe(
    developerIDEOrigin("https://127.0.0.1:443", owner, 1),
  );
  expect(new URL(developerIDEOrigin("http://127.0.0.1:443", owner, 1)).hostname).not.toBe(
    new URL(developerIDEOrigin("https://127.0.0.1:443", owner, 1)).hostname,
  );
});
