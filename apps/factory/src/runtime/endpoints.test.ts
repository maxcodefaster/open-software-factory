import { describe, expect, test } from "bun:test";
import { runtimeForgeURL, substrateFactoryURL, substrateRepositoryCloneURL } from "./endpoints";

describe("runtime Factory endpoints", () => {
  test("native Git uses the admitted Forge TLS origin, never legacy internal host rewriting", () => {
    const previous = { ...process.env };
    try {
      Object.assign(process.env, {
        FACTORY_FORGEJO_API_URL: "http://forgejo.cluster.svc:3000/api/v1/",
        FACTORY_FORGEJO_PUBLIC_URL: "https://git.example",
        FACTORY_INTERNAL_URL: "http://factory.cluster.svc:3000",
        FACTORY_RUNTIME_HOST: "host.orb.internal",
      });
      const binding = {
        connectorURL: "wss://factory.example/internal/runtime-connect",
        egressHosts: ["git.example"],
      };
      expect(
        substrateRepositoryCloneURL("http://forgejo.cluster.svc:3000/team/project.git", binding),
      ).toBe("https://git.example/team/project.git");
      expect(substrateRepositoryCloneURL("https://git.example/team/project.git", binding)).toBe(
        "https://git.example/team/project.git",
      );
      for (const repository of [
        "https://unrelated.example/team/project.git",
        "https://user:secret@git.example/team/project.git",
        "https://git.example/team/project.git?token=secret",
        "https://git.example/team/project.git#fragment",
        "https://git.example//other/project.git",
        "https://git.example/team/project.git/",
        "https://git.example/team%2Fother/project.git",
        "file:///team/project.git",
      ])
        expect(() => substrateRepositoryCloneURL(repository, binding)).toThrow(
          "Native Git repository",
        );
      for (const origin of [
        "http://git.example",
        "https://git.example:8443",
        "https://git.example/path",
        "https://user:secret@git.example",
        "https://git.example?token=secret",
        "https://not-admitted.example",
      ]) {
        process.env["FACTORY_FORGEJO_PUBLIC_URL"] = origin;
        expect(() =>
          substrateRepositoryCloneURL("http://forgejo.cluster.svc:3000/team/project.git", binding),
        ).toThrow("admitted Forge TLS origin");
      }
      process.env["FACTORY_FORGEJO_PUBLIC_URL"] = "https://git.example";
      expect(() =>
        substrateRepositoryCloneURL("https://git.example/team/project.git", {
          ...binding,
          egressHosts: [],
        }),
      ).toThrow("admitted Forge TLS origin");
      expect(() =>
        substrateRepositoryCloneURL("https://git.example/team/project.git", null),
      ).toThrow();
      delete process.env["FACTORY_FORGEJO_PUBLIC_URL"];
      expect(() =>
        substrateRepositoryCloneURL("http://forgejo.cluster.svc:3000/team/project.git", binding),
      ).toThrow("configured Forge HTTPS origin");
    } finally {
      for (const key of [
        "FACTORY_FORGEJO_API_URL",
        "FACTORY_FORGEJO_PUBLIC_URL",
        "FACTORY_INTERNAL_URL",
        "FACTORY_RUNTIME_HOST",
      ]) {
        if (previous[key] === undefined) delete process.env[key];
        else process.env[key] = previous[key];
      }
    }
  });
  test("Actor callbacks retain their native TLS binding despite private or changed browser origins", () => {
    const keys = ["FACTORY_INTERNAL_URL", "FACTORY_BASE_URL", "FACTORY_RUNTIME_HOST"] as const;
    const previous = keys.map((key) => [key, process.env[key]] as const);
    try {
      process.env["FACTORY_INTERNAL_URL"] = "http://factory-internal.release.svc:3000";
      process.env["FACTORY_BASE_URL"] = "http://localhost:58000";
      process.env["FACTORY_RUNTIME_HOST"] = "host.orb.internal";
      for (const path of [
        "/internal/model/attempt/v1",
        "/internal/build-browser/attempt/turn",
        "/internal/mcp/attempt/turn",
        "/internal/personal-git/command/capability",
      ]) {
        expect(
          substrateFactoryURL(path, {
            connectorURL: "wss://frozen-factory.example/internal/runtime-connect",
          }),
        ).toBe(`https://frozen-factory.example${path}`);
      }
      expect(
        substrateFactoryURL("/internal/model/attempt/v1", {
          connectorURL: "wss://frozen-factory.example:8443/internal/runtime-connect",
        }),
      ).toBe("https://frozen-factory.example:8443/internal/model/attempt/v1");
    } finally {
      for (const [key, value] of previous) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });
  test("Actor callbacks fail closed on missing bindings or a different origin or path", () => {
    for (const connectorURL of [
      "http://factory.example/internal/runtime-connect",
      "https://factory.example/internal/runtime-connect",
      "ws://factory.example/internal/runtime-connect",
      "wss://user:secret@factory.example/internal/runtime-connect",
      "wss://factory.example/internal/runtime-connect?key=secret",
      "wss://factory.example/internal/runtime-connect#fragment",
      "wss://factory.example/other",
    ])
      expect(() => substrateFactoryURL("/internal/model/attempt/v1", { connectorURL })).toThrow();
    for (const binding of [null, {}, { connectorURL: "" }])
      expect(() => substrateFactoryURL("/internal/model/attempt/v1", binding)).toThrow();
    for (const path of [
      "https://other.example/internal/model/attempt/v1",
      "//other.example/internal/model/attempt/v1",
      "/internal/../../outside",
      "/internal/../outside",
      "/outside",
      "/internal/model?token=secret",
      "/internal/model#fragment",
    ])
      expect(() =>
        substrateFactoryURL(path, {
          connectorURL: "wss://factory.example/internal/runtime-connect",
        }),
      ).toThrow();
  });
  test("resolves the configured control-plane Forge helper", () => {
    const previous = process.env["FACTORY_FORGEJO_API_URL"];
    try {
      process.env["FACTORY_FORGEJO_API_URL"] = "http://127.0.0.1:63653/api/v1/";
      expect(runtimeForgeURL()).toBe("http://host.orb.internal:63653/");
      process.env["FACTORY_FORGEJO_API_URL"] = "https://forge.example/api/v1/";
      expect(runtimeForgeURL()).toBe("https://forge.example/");
    } finally {
      if (previous === undefined) delete process.env["FACTORY_FORGEJO_API_URL"];
      else process.env["FACTORY_FORGEJO_API_URL"] = previous;
    }
  });
});
