import { expect, test } from "bun:test";
import { forgeBackchannelMetadata, forgeBackchannelOrigin } from "./backchannel";

test("cluster discovery retains the public issuer and browser authorization endpoints", () => {
  const publicMetadata = {
    issuer: "https://factory.example/api/auth",
    authorization_endpoint: "https://factory.example/api/auth/oauth2/authorize",
    token_endpoint: "https://factory.example/api/auth/oauth2/token",
    userinfo_endpoint: "https://factory.example/api/auth/oauth2/userinfo",
    jwks_uri: "https://factory.example/api/auth/jwks",
  };
  const internal = forgeBackchannelMetadata(
    publicMetadata,
    forgeBackchannelOrigin("http://factory.portable.svc:3000"),
  );
  expect(internal.issuer).toBe(publicMetadata.issuer);
  expect(internal.authorization_endpoint).toBe(publicMetadata.authorization_endpoint);
  expect(internal.token_endpoint).toBe("http://factory.portable.svc:3000/api/auth/oauth2/token");
  expect(internal.jwks_uri).toBe("http://factory.portable.svc:3000/api/auth/jwks");
  expect(forgeBackchannelMetadata(publicMetadata, undefined)).toBe(publicMetadata);
});

test("cleartext backchannels are confined to qualified cluster Services", () => {
  expect(forgeBackchannelOrigin("https://factory.example")?.origin).toBe("https://factory.example");
  for (const value of [
    "http://factory.example",
    "http://factory.portable.svc.attacker.example",
    "http://secret@factory.portable.svc",
    "http://factory.portable.svc/path",
    "http://factory.portable.svc?other=origin",
    "file:///etc/passwd",
  ])
    expect(() => forgeBackchannelOrigin(value)).toThrow();
});
