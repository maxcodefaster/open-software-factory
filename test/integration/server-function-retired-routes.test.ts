import { expect, test } from "bun:test";
import { factoryProcess } from "../fixtures/factory-process";

test("the real Factory host no longer serves any replaced logical UI API", async () => {
  const owned = await factoryProcess();
  const id = crypto.randomUUID(),
    other = crypto.randomUUID();
  const paths = [
    "/api/session",
    "/api/bootstrap",
    "/api/model-availability",
    "/api/ui-preferences",
    "/api/projects",
    "/api/changes",
    "/api/runtime-attempts",
    "/api/admin/users",
    "/api/security/session",
    "/api/security/authentication",
    "/api/security/sessions/end",
    "/api/security/configuration",
    "/api/usage",
    "/api/usage/compute",
    "/api/usage/contract-prices",
    "/api/models",
    "/api/model-connections",
    "/api/skills",
    "/api/mcp",
    "/api/agent-configuration",
    "/api/project-setup/drafts",
    `/api/projects/${id}/members`,
    `/api/projects/${id}/models`,
    `/api/projects/${id}/environment/development`,
    `/api/projects/${id}/skills`,
    `/api/projects/${id}/monitoring`,
    `/api/projects/${id}/inputs`,
    `/api/projects/${id}/knowledge/documents`,
    `/api/projects/${id}/personal-workspace/ensure`,
    `/api/projects/${id}/runtime`,
    `/api/projects/${id}/staging/ensure`,
    `/api/projects/${id}/app-previews`,
    `/api/projects/${id}/conversation`,
    `/api/projects/${id}/conversation/new`,
    `/api/projects/${id}/conversation/message`,
    `/api/projects/${id}/conversation/mode`,
    `/api/projects/${id}/conversation/answer`,
    `/api/projects/${id}/epic-proposals/${other}/confirm`,
    `/api/tickets/${id}`,
    `/api/tickets/${id}/document`,
    `/api/tickets/${id}/follow-up`,
    `/api/tickets/${id}/requirements`,
    `/api/tickets/${id}/requirements/${other}/approve`,
    `/api/tickets/${id}/implement`,
    `/api/tickets/${id}/change`,
    `/api/tickets/${id}/trash`,
    `/api/tickets/${id}/restore`,
    `/api/changes/${id}/cancel`,
    `/api/changes/${id}/ticket-workspace/ensure`,
    `/api/changes/${id}/agent`,
    `/api/changes/${id}/agent/activity`,
    `/api/changes/${id}/agent/start`,
    `/api/changes/${id}/agent/resume`,
    `/api/changes/${id}/agent/stop`,
    `/api/changes/${id}/agent/check-stop`,
    `/api/changes/${id}/agent/prompt`,
    `/api/changes/${id}/agent/request-changes`,
    `/api/changes/${id}/agent/new-conversation`,
    `/api/changes/${id}/delivery`,
    `/api/changes/${id}/delivery/approve`,
    `/api/changes/${id}/delivery/retry-review`,
    `/api/changes/${id}/delivery/resume-checks`,
    `/api/changes/${id}/review`,
    `/api/changes/${id}/writer`,
    `/api/runtime-attempts/${id}/stop`,
    `/api/workspaces/${id}/source`,
    `/api/workspaces/${id}/editor`,
  ];
  try {
    await owned.start();
    const cookie = await owned.signIn();
    for (const path of paths) {
      for (const method of ["GET", "POST", "PUT", "DELETE"]) {
        const response = await fetch(`${owned.base}${path}`, {
          method,
          headers: { cookie, origin: owned.base, "content-type": "application/json" },
          ...(method === "GET" ? {} : { body: "{}" }),
          redirect: "manual",
        });
        await response.arrayBuffer();
        expect({ path, method, status: response.status }).toEqual({ path, method, status: 404 });
      }
    }
  } finally {
    await owned.dispose();
  }
}, 120_000);
