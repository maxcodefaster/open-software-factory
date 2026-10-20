import { expect, test } from "bun:test";
import { eventually, factoryProcess } from "../fixtures/factory-process";

test("the running Factory observes an ambiguous repository create without a manual check or another create", async () => {
  let repository: unknown;
  let creates = 0;
  const forge = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const path = new URL(request.url).pathname;
      if (request.method === "POST" && path === "/api/v1/repos/migrate") {
        const input = await request.json();
        creates++;
        repository = {
          name: input.repo_name,
          owner: { login: input.repo_owner },
          default_branch: "main",
          private: true,
          mirror: false,
          empty: false,
          description: input.description,
        };
        return new Response(null, { status: 503 });
      }
      if (request.method === "GET" && path.endsWith("/branches/main"))
        return Response.json({ name: "main", commit: { id: "a".repeat(40) } });
      if (request.method === "GET" && /^\/api\/v1\/repos\/factory\/[^/]+$/.test(path))
        return repository ? Response.json(repository) : new Response(null, { status: 404 });
      return new Response(null, { status: 404 });
    },
  });
  const host = await factoryProcess(undefined, {
    FACTORY_FORGEJO_API_URL: `http://127.0.0.1:${forge.port}/api/v1/`,
    FACTORY_FORGEJO_OWNER: "factory",
    FACTORY_GIT_IMPORT_ORIGINS: "https://github.com",
  });
  try {
    await host.start();
    const cookie = await host.signIn();
    const api = async (path: string, method = "GET", body?: unknown) => {
      const response = await fetch(host.base + path, {
        method,
        headers: { cookie, origin: host.base, "content-type": "application/json" },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      expect(response.ok).toBe(true);
      return response.json();
    };
    const draft = await api("/api/project-setup", "POST");
    const saved = await api("/api/project-setup", "PUT", {
      id: draft.id,
      version: draft.version,
      name: "Observed repository",
      slug: `observe-${host.id.slice(0, 8)}`,
      kind: "import",
      sourceURL: "https://github.com/owned/fixture.git",
    });
    const submitted = await api("/api/project-setup/create", "POST", {
      id: saved.id,
      version: saved.version,
      commandID: crypto.randomUUID(),
    });
    expect(submitted.state).toBe("checking");
    const finished = await eventually(
      () => api("/api/project-setup"),
      (value) => value.state === "created",
      "Repository setup required a manual status check",
      20_000,
    );
    expect(finished.id).toBe(saved.id);
    expect(finished.projectID).toBeString();
    expect(creates).toBe(1);
  } finally {
    await host.dispose();
    await forge.stop(true);
  }
}, 40_000);
