import { expect, test } from "bun:test";
import { createOpenBaoEnvironmentSecrets } from "./openbao";

test("OpenBao adapter rejects plaintext transport and credential-bearing URLs", () => {
  expect(() =>
    createOpenBaoEnvironmentSecrets({ address: "http://localhost:8200", tokenFile: "/test" }),
  ).toThrow("HTTPS");
  expect(() =>
    createOpenBaoEnvironmentSecrets({ address: "https://token@store.test", tokenFile: "/test" }),
  ).toThrow("HTTPS");
  expect(() =>
    createOpenBaoEnvironmentSecrets({ address: "https://store.test/path", tokenFile: "/test" }),
  ).toThrow("HTTPS");
});

test("unconfigured secret store fails closed without making network requests", async () => {
  const adapter = createOpenBaoEnvironmentSecrets({
    fetch: async () => {
      throw new Error("network called");
    },
  });
  expect(adapter.configured).toBe(false);
  await expect(
    adapter.read(`projects/${crypto.randomUUID()}/development/${crypto.randomUUID()}`),
  ).rejects.toThrow("unavailable");
});
