import { expect, test } from "bun:test";
import { serviceAccountConfiguration } from "./service-account";

test("in-cluster commands use rotating ServiceAccount files and verified API TLS, not local defaults", () => {
  const config = serviceAccountConfiguration({
    KUBERNETES_SERVICE_HOST: "10.43.0.1",
    KUBERNETES_SERVICE_PORT: "443",
    FACTORY_AUTH_SECRET: "must-not-be-copied",
  });
  expect(config.clusters[0]?.cluster).toEqual({
    server: "https://10.43.0.1:443",
    "certificate-authority": "/var/run/secrets/kubernetes.io/serviceaccount/ca.crt",
  });
  expect(config.users[0]?.user).toEqual({
    tokenFile: "/var/run/secrets/kubernetes.io/serviceaccount/token",
  });
  expect(JSON.stringify(config)).not.toContain("must-not-be-copied");
  expect(JSON.stringify(config)).not.toContain("insecure-skip-tls-verify");
  expect(config["current-context"]).toBe("factory");
  expect(
    serviceAccountConfiguration({
      KUBERNETES_SERVICE_HOST: "fd00::1",
      KUBERNETES_SERVICE_PORT: "6443",
    }).clusters[0]?.cluster.server,
  ).toBe("https://[fd00::1]:6443");
});

test("missing or malformed in-cluster coordinates never fall back to an unauthenticated local API", () => {
  for (const env of [
    {},
    { KUBERNETES_SERVICE_HOST: "attacker.example", KUBERNETES_SERVICE_PORT: "443" },
    { KUBERNETES_SERVICE_HOST: "10.43.0.1", KUBERNETES_SERVICE_PORT: "0" },
    { KUBERNETES_SERVICE_HOST: "10.43.0.1", KUBERNETES_SERVICE_PORT: "70000" },
    { KUBERNETES_SERVICE_HOST: "10.43.0.1", KUBERNETES_SERVICE_PORT: "443/other" },
  ])
    expect(() => serviceAccountConfiguration(env)).toThrow("in-cluster API");
});
