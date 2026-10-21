import { expect, test } from "bun:test";
import { localForgeIdentityEndpoints, localServerSettings } from "./server-settings";

const defaults = { email: "admin@factory.local", password: "factory-local-password" };

test("local Forge identity is retained when only the runtime callback address changes", () => {
  const before = localForgeIdentityEndpoints("host.orb.internal", 3000);
  expect(localForgeIdentityEndpoints("192.168.139.2", 3000, before.discovery)).toEqual(before);
  expect(localForgeIdentityEndpoints("192.168.139.2", 3000).host).toBe("192.168.139.2");
});

test("retained Forge identity must still match the exact local listener", () => {
  for (const value of [
    "http://host.orb.internal:3001/api/auth/.well-known/openid-configuration",
    "https://host.orb.internal:3000/api/auth/.well-known/openid-configuration",
    "http://host.orb.internal:3000/other/.well-known/openid-configuration",
    "http://user:secret@host.orb.internal:3000/api/auth/.well-known/openid-configuration",
  ])
    expect(() => localForgeIdentityEndpoints("192.168.139.2", 3000, value)).toThrow(
      "local Factory listener",
    );
});

test("a fresh local launch keeps spare compute off unless explicitly requested", () => {
  expect(localServerSettings({}, defaults).executionReserveTarget).toBe("0");
  for (const value of ["0", "1", "4"]) {
    expect(
      localServerSettings({ FACTORY_EXECUTION_RESERVE_TARGET: value }, defaults)
        .executionReserveTarget,
    ).toBe(value);
  }
});

test("local startup preserves explicit listener and bootstrap credentials", () => {
  expect(
    localServerSettings(
      {
        FACTORY_HOST: "127.0.0.1",
        FACTORY_ADMIN_EMAIL: "chosen@factory.local",
        FACTORY_ADMIN_PASSWORD: "chosen-local-test-password",
      },
      defaults,
    ),
  ).toEqual({
    host: "127.0.0.1",
    email: "chosen@factory.local",
    password: "chosen-local-test-password",
    executionReserveTarget: "0",
  });
  expect(localServerSettings({}, defaults)).toEqual({
    host: "0.0.0.0",
    ...defaults,
    executionReserveTarget: "0",
  });
});

test("owned installation defaults retain their own identity, and invalid settings do not disclose values", () => {
  expect(
    localServerSettings({}, { email: "owned@factory.local", password: "owned-password" }),
  ).toEqual({
    host: "0.0.0.0",
    email: "owned@factory.local",
    password: "owned-password",
    executionReserveTarget: "0",
  });
  for (const environment of [
    { FACTORY_HOST: "" },
    { FACTORY_ADMIN_PASSWORD: "" },
    { FACTORY_HOST: "invalid-secret-sentinel" },
  ]) {
    expect(() => localServerSettings(environment, defaults)).toThrow("bootstrap configuration");
    try {
      localServerSettings(environment, defaults);
    } catch (cause) {
      expect(String(cause)).not.toContain("secret-sentinel");
    }
  }
});
