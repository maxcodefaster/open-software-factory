// Controlled Forgejo branch-protection protocol for process/Connector tests.
// This is not evidence of a physical Forgejo, Git push or execution Sandbox.
export function controlledForgeProtection() {
  const token = crypto.randomUUID();
  const rules = new Map<string, unknown>();
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      if (request.headers.get("authorization") !== `Bearer ${token}`)
        return new Response(null, { status: 401 });
      const path = new URL(request.url).pathname;
      if (!path.includes("/branch_protections")) return new Response(null, { status: 404 });
      if (request.method === "POST" || request.method === "PATCH") {
        const rule = (await request.json()) as { rule_name: string };
        const key = `${path.split("/branch_protections")[0]}/branch_protections/${encodeURIComponent(rule.rule_name)}`;
        rules.set(key, rule);
        return Response.json(rule);
      }
      return rules.has(path) ? Response.json(rules.get(path)) : new Response(null, { status: 404 });
    },
  });
  return {
    FACTORY_FORGEJO_ADMIN_TOKEN: token,
    FACTORY_FORGEJO_API_URL: `${server.url.origin}/api/v1/`,
    dispose: () => server.stop(true),
  };
}
