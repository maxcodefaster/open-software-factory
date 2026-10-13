import { expect, test } from "bun:test";
import { z } from "zod";
import { zeroDrizzle } from "@rocicorp/zero/server/adapters/drizzle";
import { zeroQueries, zeroSchema } from "../../packages/zero-schema/src";
import { zeroServerMutators } from "../../packages/zero-schema/src/server";
import { fixture } from "../fixtures/change-agent-turns";
import {
  searchProjectKnowledge,
  searchProjectTickets,
} from "../../apps/factory/src/project-agent/controller";
import { factoryProcess } from "../fixtures/factory-process";

const administrator = "01994a7d-0000-7000-8000-000000000001";

test("managed developers sign in, see only member Projects and cannot manage global settings", async () => {
  const process = await factoryProcess();
  const database = process.connect();
  try {
    await process.start();
    const cookie = await process.signIn();
    const headers = { cookie, origin: process.base, "content-type": "application/json" };
    const projectID = crypto.randomUUID();
    const otherProjectID = crypto.randomUUID();
    for (const id of [projectID, otherProjectID]) {
      await database.client`INSERT INTO factory.project
        (id, slug, name, repository_url, default_branch, devcontainer_path, created_by)
        VALUES (${id}, ${`access-${id}`}, 'Access Project', 'https://example.invalid/repo.git',
          'main', '.devcontainer/devcontainer.json', ${administrator})`;
    }
    const email = `developer-${crypto.randomUUID()}@factory.local`;
    const password = "owned-developer-password-not-a-secret";
    const created = await fetch(`${process.base}/api/admin/users`, {
      method: "POST",
      headers,
      body: JSON.stringify({ name: "Managed developer", email, password }),
    });
    expect(created.status).toBe(201);
    const userBody = await created.json();
    const user = z.object({ id: z.uuid() }).parse(userBody);
    expect(JSON.stringify(userBody)).not.toContain(password);
    const membership = await fetch(`${process.base}/api/projects/${projectID}/members`, {
      method: "POST",
      headers,
      body: JSON.stringify({ email, role: "developer" }),
    });
    expect(membership.status).toBe(200);
    const login = await fetch(`${process.base}/api/auth/sign-in/email`, {
      method: "POST",
      headers: { origin: process.base, "content-type": "application/json" },
      body: JSON.stringify({ email, password }),
    });
    expect(login.status).toBe(200);
    const memberHeaders = {
      ...headers,
      cookie: login.headers
        .getSetCookie()
        .map((item) => item.split(";")[0])
        .join("; "),
    };
    const session = z
      .object({
        session: z
          .object({ user: z.object({ id: z.uuid() }), systemManager: z.boolean() })
          .nullable(),
      })
      .parse(await (await fetch(`${process.base}/api/session`, { headers: memberHeaders })).json());
    expect(session.session?.user.id).toBe(user.id);
    expect(session.session?.systemManager).toBe(false);
    const list = z
      .object({ projects: z.array(z.object({ id: z.uuid() })) })
      .parse(
        await (await fetch(`${process.base}/api/projects`, { headers: memberHeaders })).json(),
      );
    expect(list.projects.map((project) => project.id)).toEqual([projectID]);
    for (const path of ["/api/admin/users", "/api/model-settings"]) {
      expect((await fetch(`${process.base}${path}`, { headers: memberHeaders })).status).toBe(403);
    }
    expect(
      (
        await fetch(`${process.base}/api/projects`, {
          method: "POST",
          headers: memberHeaders,
          body: JSON.stringify({}),
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await fetch(`${process.base}/api/projects/${projectID}/members`, {
          method: "POST",
          headers: memberHeaders,
          body: JSON.stringify({ email, role: "developer", manageProject: true }),
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await fetch(`${process.base}/api/projects/${projectID}/members`, {
          method: "POST",
          headers,
          body: JSON.stringify({ email, role: "developer", manageProject: true }),
        })
      ).status,
    ).toBe(200);
    expect(
      (await fetch(`${process.base}/api/projects/${projectID}/members`, { headers: memberHeaders }))
        .status,
    ).toBe(200);
    expect(
      (
        await fetch(`${process.base}/api/projects/${projectID}/members`, {
          method: "POST",
          headers: memberHeaders,
          body: JSON.stringify({ email, role: "developer", manageProject: false }),
        })
      ).status,
    ).toBe(409);
    expect(
      (await fetch(`${process.base}/api/projects/${projectID}/members`, { headers: memberHeaders }))
        .status,
    ).toBe(200);
    for (const path of [
      `/api/projects/${otherProjectID}/conversation`,
      `/api/projects/${otherProjectID}/knowledge/documents`,
      `/api/changes?projectId=${otherProjectID}`,
      `/api/runtime-attempts?projectId=${otherProjectID}`,
    ]) {
      expect((await fetch(`${process.base}${path}`, { headers: memberHeaders })).status).toBe(404);
    }
    await database.client`INSERT INTO factory.project_membership(project_id,user_id,role,manage_project,updated_by)
      VALUES(${projectID},${administrator},'developer',true,${administrator})`;
    const revoked = await fetch(`${process.base}/api/projects/${projectID}/members/${user.id}`, {
      method: "DELETE",
      headers,
    });
    expect(revoked.status).toBe(204);
    expect(
      await (await fetch(`${process.base}/api/projects`, { headers: memberHeaders })).json(),
    ).toEqual({ projects: [] });
    expect(
      (
        await fetch(`${process.base}/api/projects/${projectID}/conversation`, {
          headers: memberHeaders,
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await fetch(`${process.base}/api/auth/sign-up/email`, {
          method: "POST",
          headers,
          body: JSON.stringify({ name: "Public", email: "public@example.invalid", password }),
        })
      ).status,
    ).not.toBe(200);
  } finally {
    await database.client.end();
    await process.dispose();
  }
}, 60_000);

test("membership scopes Zero, entity commands and runtime grants including revocation and personal ownership", async () => {
  const process = await factoryProcess();
  const database = process.connect();
  const fixtureDatabases: Array<ReturnType<typeof process.connect>> = [];
  try {
    await process.start();
    const adminCookie = await process.signIn();
    async function command(path: string, cookie: string, method = "GET", body?: unknown) {
      return fetch(`${process.base}${path}`, {
        method,
        redirect: "manual",
        headers: { cookie, origin: process.base, "content-type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    }
    const firstDatabase = process.connect();
    const secondDatabase = process.connect();
    fixtureDatabases.push(firstDatabase, secondDatabase);
    const first = await fixture(undefined, undefined, firstDatabase);
    const second = await fixture(undefined, undefined, secondDatabase);
    const email = `manager-${crypto.randomUUID()}@factory.local`;
    const password = "owned-manager-password-not-a-secret";
    const user = z.object({ id: z.uuid() }).parse(
      await (
        await command("/api/admin/users", adminCookie, "POST", {
          name: "Project manager",
          email,
          password,
        })
      ).json(),
    );
    expect(
      (
        await command(`/api/projects/${first.projectID}/members`, adminCookie, "POST", {
          email,
          role: "developer",
          manageProject: true,
        })
      ).status,
    ).toBe(200);
    const login = await command("/api/auth/sign-in/email", "", "POST", { email, password });
    expect(login.status).toBe(200);
    const cookie = login.headers
      .getSetCookie()
      .map((item) => item.split(";")[0])
      .join("; ");
    expect((await command(`/api/projects/${first.projectID}/members`, cookie)).status).toBe(200);
    expect((await command(`/api/projects/${second.projectID}/members`, cookie)).status).toBe(404);
    for (const path of [
      `/api/tickets/${second.ticketID}`,
      `/api/tickets/${second.ticketID.replaceAll("-", "")}`,
      `/api/changes/${second.changeID}/agent`,
      `/api/changes/${second.changeID}/delivery`,
    ])
      expect((await command(path, cookie)).status).toBe(404);
    for (const path of [
      `/api/tickets/${second.ticketID}/requirements`,
      `/api/tickets/${second.ticketID}/change`,
      `/api/changes/${second.changeID}/cancel`,
      `/api/changes/${second.changeID}/agent/start`,
      `/api/changes/${second.changeID}/delivery/approve`,
      `/api/runtime-attempts/${second.attemptID}/stop`,
    ])
      expect((await command(path, cookie, "POST", {})).status).toBe(404);
    expect(
      (await command(`/api/runtime-access?path=/runtime/${second.attemptID}/ide/`, cookie)).status,
    ).toBe(404);
    expect((await command(`/runtime/${first.attemptID}/ide/`, "")).status).toBe(401);
    expect((await command(`/runtime/${crypto.randomUUID()}/ide/`, "")).status).toBe(401);
    const context = { userId: user.id, systemManager: false };
    const zero = zeroDrizzle(zeroSchema, database.db);
    const projectsQuery = zeroQueries.projects.list.fn({ args: undefined, ctx: context });
    expect((await zero.run(projectsQuery)).map((project) => project.id)).toEqual([first.projectID]);
    expect(
      await zero.run(
        zeroQueries.tickets.list.fn({ args: { projectId: second.projectID }, ctx: context }),
      ),
    ).toEqual([]);
    expect(
      await searchProjectTickets(database, first.projectID, "regression", user.id),
    ).not.toEqual([]);
    await expect(
      searchProjectTickets(database, second.projectID, "regression", user.id),
    ).rejects.toThrow("Project not found");
    await expect(
      searchProjectKnowledge(database, second.projectID, "regression", user.id),
    ).rejects.toThrow("Project not found");
    const transformed = await command("/api/zero/query", cookie, "POST", [
      "transform",
      [
        { id: "project-list", name: "projects.list", args: [] },
        {
          id: "other-tickets",
          name: "tickets.list",
          args: [{ projectId: second.projectID, systemManager: true }],
        },
      ],
    ]);
    expect(transformed.status).toBe(200);
    const transformation = z
      .object({
        kind: z.literal("QueryResponse"),
        queries: z.array(z.object({ ast: z.unknown() })),
      })
      .parse(await transformed.json());
    for (const query of transformation.queries) {
      expect(JSON.stringify(query.ast)).toContain("factory.project_membership");
      expect(JSON.stringify(query.ast)).toContain(user.id);
    }
    const ticketID = crypto.randomUUID();
    await zero.transaction((tx) =>
      zeroServerMutators.tickets.create.fn({
        tx,
        ctx: context,
        args: {
          id: ticketID,
          projectId: first.projectID,
          title: "Member planning",
          description: "",
        },
      }),
    );
    await expect(
      zero.transaction((tx) =>
        zeroServerMutators.tickets.create.fn({
          tx,
          ctx: context,
          args: {
            id: crypto.randomUUID(),
            projectId: second.projectID,
            title: "Denied",
            description: "",
          },
        }),
      ),
    ).rejects.toThrow("Project not found");
    for (const projectID of [first.projectID, second.projectID]) {
      const deniedTicket = projectID === first.projectID ? ticketID : second.ticketID;
      if (projectID === first.projectID) continue;
      await expect(
        zero.transaction((tx) =>
          zeroServerMutators.tickets.update.fn({
            tx,
            ctx: context,
            args: {
              projectId: projectID,
              ticketId: deniedTicket,
              expectedVersion: 1,
              title: "Denied",
            },
          }),
        ),
      ).rejects.toThrow("Project not found");
      await expect(
        zero.transaction((tx) =>
          zeroServerMutators.tickets.move.fn({
            tx,
            ctx: context,
            args: {
              projectId: projectID,
              ticketId: deniedTicket,
              expectedVersion: 1,
              state: "backlog",
            },
          }),
        ),
      ).rejects.toThrow("Project not found");
    }
    const granted = await command(
      `/api/runtime-access?path=/runtime/${first.attemptID}/ide/`,
      cookie,
    );
    expect(granted.status).toBe(302);
    const destination = granted.headers.get("location");
    if (!destination) throw new Error("Runtime grant missing");
    const grantURL = new URL(destination);
    const redeemed = await command(`${grantURL.pathname}${grantURL.search}`, "");
    expect(redeemed.status).toBe(302);
    const runtimeCookie = redeemed.headers
      .getSetCookie()
      .map((item) => item.split(";")[0])
      .join("; ");
    expect((await command(`/runtime/${first.attemptID}/ide/`, runtimeCookie)).status).toBe(503);
    const personalWorkspaceID = crypto.randomUUID();
    const personalAttemptID = crypto.randomUUID();
    const suffix = personalWorkspaceID.replaceAll("-", "").slice(0, 12);
    await database.client`INSERT INTO factory.development_workspace(id, project_id, kind, owner_user_id,
      source_branch, source_revision, kubernetes_namespace, volume_name, created_by)
      VALUES (${personalWorkspaceID}, ${first.projectID}, 'personal', ${administrator}, 'main', ${"a".repeat(40)},
        ${`factory-workspace-${suffix}`}, 'never-created', ${administrator})`;
    await database.client`INSERT INTO factory.runtime_attempt(id, project_id, workspace_id, generation,
      revision, state, kubernetes_namespace, kubernetes_pod_name, parent_connector_token_hash,
      child_connector_token_hash, create_intended_at, created_by)
      VALUES (${personalAttemptID}, ${first.projectID}, ${personalWorkspaceID}, 1, ${"a".repeat(40)}, 'ready',
        ${`owned-access-${suffix}`}, 'never-created', ${"b".repeat(64)}, ${"c".repeat(64)}, now(), ${administrator})`;
    expect(
      (await command(`/api/runtime-access?path=/runtime/${personalAttemptID}/ide/`, cookie)).status,
    ).toBe(404);
    const attempts = z
      .object({ attempts: z.array(z.object({ id: z.string() })) })
      .parse(
        await (await command(`/api/runtime-attempts?projectId=${first.projectID}`, cookie)).json(),
      );
    expect(attempts.attempts.map((attempt) => attempt.id)).toContain(first.attemptID);
    expect(attempts.attempts.map((attempt) => attempt.id)).not.toContain(personalAttemptID);
    await database.client`INSERT INTO factory.project_membership(project_id,user_id,role,manage_project,updated_by)
      VALUES(${first.projectID},${administrator},'developer',true,${administrator})`;
    expect(
      (await command(`/api/projects/${first.projectID}/members/${user.id}`, adminCookie, "DELETE"))
        .status,
    ).toBe(204);
    expect((await command(`/runtime/${first.attemptID}/ide/`, runtimeCookie)).status).toBe(401);
    for (const path of [
      `/runtime/${first.attemptID}/ide/socket`,
      `/runtime/${first.attemptID}/ide/__factory/terminal/owned-terminal`,
      `/runtime/${first.attemptID}/preview/app/socket`,
    ]) {
      const deniedSocket = await fetch(`${process.base}${path}`, {
        headers: {
          cookie: runtimeCookie,
          connection: "upgrade",
          upgrade: "websocket",
          "sec-websocket-version": "13",
          "sec-websocket-key": Buffer.from("owned-socket-key").toString("base64"),
        },
      });
      expect(deniedSocket.status).toBe(401);
    }
    expect(await zero.run(projectsQuery)).toEqual([]);
    await expect(
      searchProjectTickets(database, first.projectID, "regression", user.id),
    ).rejects.toThrow("Project not found");
    await expect(
      zero.transaction((tx) =>
        zeroServerMutators.tickets.update.fn({
          tx,
          ctx: context,
          args: {
            projectId: first.projectID,
            ticketId: ticketID,
            expectedVersion: 1,
            title: "Revoked",
          },
        }),
      ),
    ).rejects.toThrow("Project not found");
  } finally {
    for (const fixtureDatabase of fixtureDatabases) await fixtureDatabase.client.end();
    await database.client.end();
    await process.dispose();
  }
}, 60_000);
