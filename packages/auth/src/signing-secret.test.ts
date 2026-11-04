import { describe, expect, test } from "bun:test";
import { developmentSigningSecret, factorySigningSecret } from "./signing-secret";

const strong = "s".repeat(40);

describe("factory signing secret", () => {
  test("uses the development secret only on a loopback listener", () => {
    expect(factorySigningSecret({})).toBe(developmentSigningSecret);
    expect(factorySigningSecret({ FACTORY_HOST: "localhost" })).toBe(developmentSigningSecret);
  });

  test("refuses the fallback for any other listener or production", () => {
    for (const environment of [
      { FACTORY_HOST: "0.0.0.0" },
      { FACTORY_BASE_URL: "https://factory.example.com" },
      { NODE_ENV: "production" },
      { FACTORY_HOST: "0.0.0.0", FACTORY_AUTH_SECRET: developmentSigningSecret },
    ])
      expect(() => factorySigningSecret(environment)).toThrow("FACTORY_AUTH_SECRET");
  });

  test("requires length outside development but accepts any configured secret locally", () => {
    expect(factorySigningSecret({ FACTORY_HOST: "0.0.0.0", FACTORY_AUTH_SECRET: strong })).toBe(
      strong,
    );
    expect(() =>
      factorySigningSecret({ FACTORY_HOST: "0.0.0.0", FACTORY_AUTH_SECRET: "short" }),
    ).toThrow("32 characters");
    expect(factorySigningSecret({ FACTORY_AUTH_SECRET: "short" })).toBe("short");
  });
});
