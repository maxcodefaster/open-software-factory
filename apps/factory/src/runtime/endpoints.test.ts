import { describe, expect, test } from "bun:test";
import { runtimeFactoryURL, runtimeForgeURL, runtimeRepositoryCloneURL } from "./endpoints";

describe("runtime Factory endpoints", () => {
  test("cluster callbacks and same-installation clones use internal Services, not the browser address", () => {
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
      expect(runtimeRepositoryCloneURL("https://forge.example/team/project.git")).toBe(
        "http://forgejo.portable.svc:3000/team/project.git",
      );
      expect(runtimeRepositoryCloneURL("https://unrelated.example/team/project.git")).toBe(
        "https://unrelated.example/team/project.git",
      );
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
  test("Linux callbacks and clone URLs use the installation's reachable host", () => {
    const prior = process.env["FACTORY_RUNTIME_HOST"];
    try {
      process.env["FACTORY_RUNTIME_HOST"] = "192.0.2.10";
      expect(runtimeFactoryURL("/internal/runtime-connect")).toContain("192.0.2.10");
    } finally {
      if (prior === undefined) delete process.env["FACTORY_RUNTIME_HOST"];
      else process.env["FACTORY_RUNTIME_HOST"] = prior;
    }
  });
  test("resolves the configured isolated Forge for clone and Verification without changing other origins", () => {
    const previous = process.env["FACTORY_FORGEJO_API_URL"];
    try {
      process.env["FACTORY_FORGEJO_API_URL"] = "http://127.0.0.1:63653/api/v1/";
      expect(runtimeRepositoryCloneURL("http://127.0.0.1:63653/team/project.git")).toBe(
        "http://host.orb.internal:63653/team/project.git",
      );
      expect(runtimeForgeURL()).toBe("http://host.orb.internal:63653/");
      expect(runtimeRepositoryCloneURL("https://example.com/team/project.git")).toBe(
        "https://example.com/team/project.git",
      );
      expect(runtimeRepositoryCloneURL("http://127.0.0.1:33030/team/project.git")).toBe(
        "http://127.0.0.1:33030/team/project.git",
      );
      process.env["FACTORY_FORGEJO_API_URL"] = "https://forge.example/api/v1/";
      expect(runtimeForgeURL()).toBe("https://forge.example/");
      delete process.env["FACTORY_FORGEJO_API_URL"];
      expect(runtimeRepositoryCloneURL("https://example.invalid/owned-build.git")).toBe(
        "https://example.invalid/owned-build.git",
      );
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
