import { describe, expect, test } from "bun:test";
import { runtimeFactoryURL, runtimeForgeURL, substrateRepositoryCloneURL } from "./endpoints";

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
  test("control-plane callbacks use their configured internal Service", () => {
    const keys = [
      "FACTORY_INTERNAL_URL",
      "FACTORY_BASE_URL",
      "FACTORY_FORGEJO_API_URL",
      "FACTORY_FORGEJO_PUBLIC_URL",
    ] as const;
    const previous = keys.map((key) => [key, process.env[key]] as const);
    try {
      process.env["FACTORY_INTERNAL_URL"] = "http://factory.portable.svc:3000";
      process.env["FACTORY_BASE_URL"] = "https://factory.example";
      process.env["FACTORY_FORGEJO_API_URL"] = "http://forgejo.portable.svc:3000/api/v1/";
      process.env["FACTORY_FORGEJO_PUBLIC_URL"] = "https://forge.example";
      expect(runtimeFactoryURL("/internal/runtime-connect")).toBe(
        "http://factory.portable.svc:3000/internal/runtime-connect",
      );
      expect(runtimeFactoryURL("/internal/model/attempt/v1")).toBe(
        "http://factory.portable.svc:3000/internal/model/attempt/v1",
      );
      expect(runtimeForgeURL()).toBe("http://forgejo.portable.svc:3000/");
      for (const invalid of [
        "file:///tmp/factory",
        "http://user:secret@factory.portable.svc",
        "http://factory.portable.svc/path",
        "http://factory.portable.svc?key=value",
      ]) {
        process.env["FACTORY_INTERNAL_URL"] = invalid;
        expect(() => runtimeFactoryURL("/internal/runtime-connect")).toThrow(
          "FACTORY_INTERNAL_URL",
        );
      }
    } finally {
      for (const [key, value] of previous) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });
  test("control-plane callbacks use the installation's reachable host", () => {
    const prior = process.env["FACTORY_RUNTIME_HOST"];
    try {
      process.env["FACTORY_RUNTIME_HOST"] = "192.0.2.10";
      expect(runtimeFactoryURL("/internal/runtime-connect")).toContain("192.0.2.10");
    } finally {
      if (prior === undefined) delete process.env["FACTORY_RUNTIME_HOST"];
      else process.env["FACTORY_RUNTIME_HOST"] = prior;
    }
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

  test("keeps the configured scheme and port when resolving the OrbStack host", () => {
    const previous = process.env["FACTORY_BASE_URL"];
    try {
      for (const hostname of ["127.0.0.1", "localhost", "[::1]"]) {
        process.env["FACTORY_BASE_URL"] = `http://${hostname}:51321`;
        expect(runtimeFactoryURL("/internal/runtime-connect")).toBe(
          "http://host.orb.internal:51321/internal/runtime-connect",
        );
        expect(runtimeFactoryURL("/internal/model/attempt/v1")).toBe(
          "http://host.orb.internal:51321/internal/model/attempt/v1",
        );
        expect(runtimeFactoryURL("/internal/runtime-source/attempt/capability")).toBe(
          "http://host.orb.internal:51321/internal/runtime-source/attempt/capability",
        );
      }
      delete process.env["FACTORY_BASE_URL"];
      expect(runtimeFactoryURL("/internal/runtime-connect")).toBe(
        "http://host.orb.internal:3000/internal/runtime-connect",
      );
      process.env["FACTORY_BASE_URL"] = "https://factory.example:8443";
      expect(runtimeFactoryURL("/internal/runtime-connect")).toBe(
        "https://factory.example:8443/internal/runtime-connect",
      );
    } finally {
      if (previous === undefined) delete process.env["FACTORY_BASE_URL"];
      else process.env["FACTORY_BASE_URL"] = previous;
    }
  });
});
