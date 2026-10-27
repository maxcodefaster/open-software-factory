import { expect, test } from "bun:test";
import { zeroDrizzle } from "@rocicorp/zero/server/adapters/drizzle";
import { z } from "zod";
import {
  searchProjectKnowledge,
  searchProjectTickets,
} from "../../apps/factory/src/project-agent/controller";
import { serverCall } from "../../apps/factory/src/server-functions/result";
import { zeroQueries, zeroSchema } from "../../packages/zero-schema/src";
import { zeroServerMutators } from "../../packages/zero-schema/src/server";
import { fixture } from "../fixtures/change-agent-turns";
import { factoryProcess } from "../fixtures/factory-process";
import { authenticatedBootstrap, callFactoryFunction } from "../fixtures/server-functions";

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
    const userBody = await serverCall(
      callFactoryFunction(
        process.base,
        "createAccount",
        [{ name: "Managed developer", email, password }],
        headers,
      ),
    );
    const user = z.object({ id: z.uuid() }).parse(userBody);
    expect(JSON.stringify(userBody)).not.toContain(password);
    const membership = await callFactoryFunction(
      process.base,
      "saveProjectMember",
      [projectID, { email, role: "developer" }],
      headers,
    );
    expect(membership.ok).toBe(true);
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
      .parse(await authenticatedBootstrap(process.base, memberHeaders));
    expect(session.session?.user.id).toBe(user.id);
    expect(session.session?.systemManager).toBe(false);
    const list = z
      .object({ projects: z.array(z.object({ id: z.uuid() })) })
      .parse(await serverCall(callFactoryFunction(process.base, "getProjects", [], memberHeaders)));
    expect(list.projects.map((project) => project.id)).toEqual([projectID]);
    expect(await callFactoryFunction(process.base, "getAccounts", [], memberHeaders)).toMatchObject(
      { ok: false, status: 403 },
    );
    expect(
      await callFactoryFunction(process.base, "getModelSettings", [], memberHeaders),
    ).toMatchObject({ ok: false, status: 403 });
    expect(
      await callFactoryFunction(
        process.base,
        "registerProject",
        [
          {
            name: "Denied Project",
            slug: "denied-project",
            repositoryUrl: "https://example.invalid/denied.git",
            defaultBranch: "main",
            devcontainerPath: ".devcontainer/devcontainer.json",
          },
        ],
        memberHeaders,
      ),
    ).toMatchObject({ ok: false, status: 403 });
    expect(
      await callFactoryFunction(
        process.base,
        "saveProjectMember",
        [projectID, { email, role: "developer", manageProject: true }],
        memberHeaders,
      ),
    ).toMatchObject({ ok: false, status: 403 });
    expect(
      await callFactoryFunction(
        process.base,
        "saveProjectMember",
        [projectID, { email, role: "developer", manageProject: true }],
        headers,
      ),
    ).toMatchObject({ ok: true });
    expect(
      await callFactoryFunction(process.base, "getProjectMembers", [projectID], memberHeaders),
    ).toMatchObject({ ok: true });
    expect(
      await callFactoryFunction(
        process.base,
        "saveProjectMember",
        [projectID, { email, role: "developer", manageProject: false }],
        memberHeaders,
      ),
    ).toMatchObject({ ok: false, status: 409 });
    expect(
      await callFactoryFunction(process.base, "getProjectMembers", [projectID], memberHeaders),
    ).toMatchObject({ ok: true });
    expect(
      await callFactoryFunction(
        process.base,
        "getRepositoryDocuments",
        [otherProjectID],
        memberHeaders,
      ),
    ).toMatchObject({ ok: false, status: 404 });
    expect(
      await callFactoryFunction(process.base, "getConversation", [otherProjectID], memberHeaders),
    ).toMatchObject({ ok: false, status: 404 });
    expect(
      await callFactoryFunction(process.base, "getChanges", [otherProjectID], memberHeaders),
    ).toMatchObject({ ok: false, status: 404 });
    expect(
      await callFactoryFunction(
        process.base,
        "getRuntimeAttempts",
        [otherProjectID],
        memberHeaders,
      ),
    ).toMatchObject({ ok: false, status: 404 });
    await database.client`INSERT INTO factory.project_membership(project_id,user_id,role,manage_project,updated_by)
      VALUES(${projectID},${administrator},'developer',true,${administrator})`;
    const revoked = await callFactoryFunction(
      process.base,
      "removeProjectMember",
      [projectID, user.id],
      headers,
    );
    expect(revoked.ok).toBe(true);
    expect(await callFactoryFunction(process.base, "getProjects", [], memberHeaders)).toMatchObject(
      { ok: true, value: { projects: [] } },
    );
    expect(
      await callFactoryFunction(process.base, "getConversation", [projectID], memberHeaders),
    ).toMatchObject({ ok: false, status: 404 });
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
      await serverCall(
        callFactoryFunction(
          process.base,
          "createAccount",
          [
            {
              name: "Project manager",
              email,
              password,
            },
          ],
          { cookie: adminCookie },
        ),
      ),
    );
    expect(
      await callFactoryFunction(
        process.base,
        "saveProjectMember",
        [
          first.projectID,
          {
            email,
            role: "developer",
            manageProject: true,
          },
        ],
        { cookie: adminCookie },
      ),
    ).toMatchObject({ ok: true });
    const login = await command("/api/auth/sign-in/email", "", "POST", { email, password });
    expect(login.status).toBe(200);
    const cookie = login.headers
      .getSetCookie()
      .map((item) => item.split(";")[0])
      .join("; ");
    expect(
      await callFactoryFunction(process.base, "getProjectMembers", [first.projectID], { cookie }),
    ).toMatchObject({ ok: true });
    expect(
      await callFactoryFunction(process.base, "getProjectMembers", [second.projectID], { cookie }),
    ).toMatchObject({ ok: false, status: 404 });
    expect(
      await callFactoryFunction(process.base, "getTicketDetail", [second.ticketID], { cookie }),
    ).toMatchObject({ ok: false, status: 404 });
    expect(
      await callFactoryFunction(
        process.base,
        "getTicketDetail",
        [second.ticketID.replaceAll("-", "")],
        { cookie },
      ),
    ).toMatchObject({ ok: false, status: 400 });
    expect(
      await callFactoryFunction(process.base, "getDelivery", [second.changeID], { cookie }),
    ).toMatchObject({ ok: false, status: 404 });
    expect(
      await callFactoryFunction(process.base, "approveDelivery", [second.changeID], { cookie }),
    ).toMatchObject({ ok: false, status: 404 });
    expect(
      await callFactoryFunction(process.base, "getAgentView", [second.changeID], { cookie }),
    ).toMatchObject({ ok: false, status: 404 });
    expect(
      await callFactoryFunction(
        process.base,
        "createRequirementRevision",
        [
          second.ticketID,
          {
            summary: "Denied requirements",
            acceptanceCriteria: ["Keep Project isolation"],
          },
        ],
        { cookie },
      ),
    ).toMatchObject({ ok: false, status: 404 });
    expect(
      await callFactoryFunction(
        process.base,
        "approveRequirementRevision",
        [second.ticketID, second.revisionID],
        { cookie },
      ),
    ).toMatchObject({ ok: false, status: 404 });
    expect(
      await callFactoryFunction(process.base, "startTicketChange", [second.ticketID], { cookie }),
    ).toMatchObject({ ok: false, status: 404 });
    expect(
      await callFactoryFunction(process.base, "cancelChange", [second.changeID], { cookie }),
    ).toMatchObject({ ok: false, status: 404 });
    expect(
      await callFactoryFunction(
        process.base,
        "startCoding",
        [second.changeID, { commandId: crypto.randomUUID() }],
        { cookie },
      ),
    ).toMatchObject({ ok: false, status: 404 });
    expect(
      await callFactoryFunction(process.base, "stopRuntimeAttempt", [second.attemptID], { cookie }),
    ).toMatchObject({ ok: false, status: 404 });
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
        zeroQueries.tickets.active.fn({
          args: { projectId: second.projectID, limit: 201 },
          ctx: context,
        }),
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
          name: "tickets.active",
          args: [{ projectId: second.projectID, limit: 201, systemManager: true }],
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
    const _suffix = personalWorkspaceID.replaceAll("-", "").slice(0, 12);
    await database.client`INSERT INTO factory.development_workspace(id, project_id, kind, owner_user_id,
      source_branch, source_revision, created_by)
      VALUES (${personalWorkspaceID}, ${first.projectID}, 'personal', ${administrator}, 'main', ${"a".repeat(40)}, ${administrator})`;
    await database.client`INSERT INTO factory.runtime_attempt(id, project_id, workspace_id, generation,
      revision, state, parent_connector_token_hash,
      child_connector_token_hash, create_intended_at, created_by)
      VALUES (${personalAttemptID}, ${first.projectID}, ${personalWorkspaceID}, 1, ${"a".repeat(40)}, 'ready', ${"b".repeat(64)}, ${"c".repeat(64)}, now(), ${administrator})`;
    expect(
      (await command(`/api/runtime-access?path=/runtime/${personalAttemptID}/ide/`, cookie)).status,
    ).toBe(404);
    const attempts = z
      .object({ attempts: z.array(z.object({ id: z.string() })) })
      .parse(
        await serverCall(
          callFactoryFunction(process.base, "getRuntimeAttempts", [first.projectID], { cookie }),
        ),
      );
    expect(attempts.attempts.map((attempt) => attempt.id)).toContain(first.attemptID);
    expect(attempts.attempts.map((attempt) => attempt.id)).not.toContain(personalAttemptID);
    await database.client`INSERT INTO factory.project_membership(project_id,user_id,role,manage_project,updated_by)
      VALUES(${first.projectID},${administrator},'developer',true,${administrator})`;
    expect(
      await callFactoryFunction(process.base, "removeProjectMember", [first.projectID, user.id], {
        cookie: adminCookie,
      }),
    ).toMatchObject({ ok: true });
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
