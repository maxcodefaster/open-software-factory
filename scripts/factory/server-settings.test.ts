import { expect, test } from "bun:test";
import { localServerSettings } from "./server-settings";

const defaults = { email: "admin@factory.local", password: "factory-local-password" };

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
  });
  expect(localServerSettings({}, defaults)).toEqual({ host: "0.0.0.0", ...defaults });
});

test("owned installation defaults retain their own identity, and invalid settings do not disclose values", () => {
  expect(
    localServerSettings({}, { email: "owned@factory.local", password: "owned-password" }),
  ).toEqual({
    host: "0.0.0.0",
    email: "owned@factory.local",
    password: "owned-password",
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
