import { expect, test } from "bun:test";
import { z } from "zod";
import { createAccessController } from "../../apps/factory/src/access/controller";
import { createMembershipCommands } from "../../apps/factory/src/access/membership";
import { createProjectAppPreviews } from "../../apps/factory/src/access/previews";
import { createAgentTurnStore } from "../../apps/factory/src/agent/turn-store";
import { serverCall } from "../../apps/factory/src/server-functions/result";
import { factoryProcess } from "../fixtures/factory-process";
import { authenticatedBootstrap, callFactoryFunction } from "../fixtures/server-functions";

test("Product leads manage without code, cannot self-upgrade, and serialize last-manager removal", async () => {
  const process = await factoryProcess();
  const database = process.connect();
  try {
    await process.start();
    const cookie = await process.signIn();
    async function command(path: string, session = cookie, method = "GET", body?: unknown) {
      return fetch(`${process.base}${path}`, {
        method,
        headers: {
          cookie: session,
          origin: process.base,
          "content-type": "application/json",
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    }
    const account = async (name: string) => {
      const email = `${crypto.randomUUID()}@factory.local`;
      const password = "owned-access-password-not-a-secret";
      const result = await serverCall(
        callFactoryFunction(process.base, "createAccount", [{ name, email, password }], { cookie }),
      );
      const { id } = z.object({ id: z.uuid() }).parse(result);
      const login = await command("/api/auth/sign-in/email", "", "POST", { email, password });
      expect(login.status).toBe(200);
      return {
        id,
        email,
        cookie: login.headers
          .getSetCookie()
          .map((value) => value.split(";")[0])
          .join("; "),
      };
    };
    const lead = await account("Product lead");
    const developer = await account("Developer");
    const otherLead = await account("Other lead");
    const projectID = crypto.randomUUID();
    await database.client`INSERT INTO factory.project(id,slug,name,repository_url,default_branch,devcontainer_path,created_by)
      VALUES(${projectID},${`enterprise-${projectID}`},'Enterprise access','https://example.invalid/repo.git','main','.devcontainer/devcontainer.json',${lead.id})`;
    // These are negative checks of retired adapters, not compatibility calls.
    for (const [path, method, body] of [
      ["/api/admin/users", "GET", undefined],
      [
        "/api/admin/users",
        "POST",
        {
          name: "Must not be created",
          email: "retired@fixture.test",
          password: "retired-transport-must-not-create",
        },
      ],
      ["/api/security/session", "GET", undefined],
      ["/api/security/authentication", "GET", undefined],
      ["/api/security/sessions/end", "POST", undefined],
      ["/api/security/configuration", "GET", undefined],
      [`/api/projects/${projectID}/members`, "GET", undefined],
      [`/api/projects/${projectID}/members`, "POST", { email: lead.email, role: "developer" }],
    ] as const)
      expect((await command(path, cookie, method, body)).status).toBe(404);
    expect(
      await callFactoryFunction(
        process.base,
        "saveProjectMember",
        [
          projectID,
          {
            email: lead.email,
            role: "product-contributor",
            manageProject: true,
          },
        ],
        { cookie },
      ),
    ).toMatchObject({ ok: true });
    expect(
      await callFactoryFunction(process.base, "getProjectMembers", [projectID], {
        cookie: lead.cookie,
      }),
    ).toMatchObject({ ok: true });
    await database.client`UPDATE auth.session SET authenticated_at=now()-interval '6 minutes' WHERE user_id=${lead.id}`;
    expect(
      await callFactoryFunction(
        process.base,
        "saveProjectMember",
        [
          projectID,
          {
            email: developer.email,
            role: "developer",
          },
        ],
        { cookie: lead.cookie },
      ),
    ).toMatchObject({ ok: false, status: 403 });
    expect(
      await callFactoryFunction(process.base, "removeProjectMember", [projectID, developer.id], {
        cookie: lead.cookie,
      }),
    ).toMatchObject({ ok: false, status: 403 });
    await database.client`UPDATE auth.session SET authenticated_at=now() WHERE user_id=${lead.id}`;
    expect(
      await callFactoryFunction(
        process.base,
        "saveProjectMember",
        [
          projectID,
          {
            email: lead.email,
            role: "developer",
            manageProject: true,
          },
        ],
        { cookie: lead.cookie },
      ),
    ).toMatchObject({ ok: false, status: 403 });
    const access = createAccessController(database);
    expect(await access.canDevelop(lead.id, projectID)).toBe(false);
    await expect(access.requireDevelopment(lead.id, projectID)).rejects.toThrow(
      "Developer access required",
    );
    expect(
      await callFactoryFunction(process.base, "getRepositoryDocuments", [projectID], {
        cookie: lead.cookie,
      }),
    ).toMatchObject({ ok: false, status: 403 });
    expect(
      await callFactoryFunction(
        process.base,
        "saveProjectMember",
        [
          projectID,
          {
            email: developer.email,
            role: "developer",
          },
        ],
        { cookie: lead.cookie },
      ),
    ).toMatchObject({ ok: true });
    expect(await access.canDevelop(developer.id, projectID)).toBe(true);
    expect(
      await callFactoryFunction(process.base, "getProjectMembers", [projectID], {
        cookie: developer.cookie,
      }),
    ).toMatchObject({ ok: false, status: 403 });
    expect(
      await callFactoryFunction(process.base, "removeProjectMember", [projectID, lead.id], {
        cookie,
      }),
    ).toMatchObject({ ok: false, status: 409 });
    expect(
      await callFactoryFunction(
        process.base,
        "saveProjectMember",
        [
          projectID,
          {
            email: otherLead.email,
            role: "product-contributor",
            manageProject: true,
          },
        ],
        { cookie: lead.cookie },
      ),
    ).toMatchObject({ ok: true });
    const memberships = createMembershipCommands(database);
    const removed = await Promise.allSettled(
      [lead, otherLead].map((person) =>
        memberships.change({
          projectID,
          actorID: lead.id,
          target: { email: person.email, role: "product-contributor", manageProject: false },
        }),
      ),
    );
    expect(removed.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const remaining =
      await database.client`SELECT user_id FROM factory.project_membership WHERE project_id=${projectID} AND manage_project`;
    expect(remaining).toHaveLength(1);
    await database.client`UPDATE factory.account_access SET disabled_at=now() WHERE user_id=${developer.id}`;
    await expect(access.requireDevelopment(developer.id, projectID)).rejects.toThrow(
      "Account access is disabled",
    );
    expect(
      await serverCall(
        callFactoryFunction(process.base, "getBootstrap", [], { cookie: developer.cookie }),
      ),
    ).toMatchObject({ session: null });
  } finally {
    await database.client.end();
    await process.dispose();
  }
}, 60_000);

test("browser session termination leaves admitted work valid; account disablement fences work and new login", async () => {
  const fixture = await factoryProcess();
  const database = fixture.connect();
  try {
    await fixture.start();
    const adminCookie = await fixture.signIn();
    const session = (await authenticatedBootstrap(fixture.base, { cookie: adminCookie })) as {
      session: { user: { id: string } };
    };
    const admin = session.session.user.id;
    const email = `${crypto.randomUUID()}@factory.local`;
    const password = "owned-session-password-value";
    const { id: userID } = await serverCall(
      callFactoryFunction(
        fixture.base,
        "createAccount",
        [{ name: "Owned session", email, password }],
        { cookie: adminCookie },
      ),
    );
    async function signIn() {
      return fetch(`${fixture.base}/api/auth/sign-in/email`, {
        method: "POST",
        headers: { origin: fixture.base, "content-type": "application/json" },
        body: JSON.stringify({ email, password }),
      });
    }
    const login = await signIn();
    expect(login.status).toBe(200);
    const cookie = login.headers
      .getSetCookie()
      .map((value) => value.split(";")[0])
      .join("; ");
    const projectID = crypto.randomUUID();
    const conversationID = crypto.randomUUID();
    await database.client`INSERT INTO factory.project(id,slug,name,repository_url,default_branch,devcontainer_path,created_by)
      VALUES(${projectID},${`sessions-${projectID}`},'Sessions','https://example.invalid/session.git','main','.devcontainer/devcontainer.json',${userID})`;
    await database.client`INSERT INTO factory.project_membership(project_id,user_id,role,updated_by) VALUES(${projectID},${userID},'developer',${admin})`;
    await database.client`INSERT INTO factory.ticket_conversation(id,project_id,created_by) VALUES(${conversationID},${projectID},${userID})`;
    const store = createAgentTurnStore(database);
    const { turn } = await store.admit(
      {
        kind: "project-message",
        commandId: crypto.randomUUID(),
        projectId: projectID,
        createdBy: userID,
        conversationId: conversationID,
        ticketId: null,
        text: "Owned background work",
      },
      { mode: "investigate", conversationVersion: 1, modelId: "owned", skillRevisionIds: [] },
    );
    const owned = await store.claimPending(turn.id);
    if (!owned?.ownerToken) throw new Error("Turn not owned");
    expect(await store.beginDispatch(owned.id, owned.ownerToken)).not.toBeNull();
    await serverCall(
      callFactoryFunction(fixture.base, "endAccountSessions", [userID], { cookie: adminCookie }),
    );
    expect(await store.validateExecution(owned.id, owned.ownerToken)).toBe(true);
    expect(
      await (await fetch(`${fixture.base}/api/auth/get-session`, { headers: { cookie } })).json(),
    ).toBeNull();
    const another = await signIn();
    expect(another.status).toBe(200);
    const anotherCookie = another.headers
      .getSetCookie()
      .map((value) => value.split(";")[0])
      .join("; ");
    await serverCall(
      callFactoryFunction(fixture.base, "endOwnSessions", [], { cookie: anotherCookie }),
    );
    expect(await store.validateExecution(owned.id, owned.ownerToken)).toBe(true);
    await serverCall(
      callFactoryFunction(fixture.base, "setAccountAccess", [userID, true], {
        cookie: adminCookie,
      }),
    );
    expect(await store.validateExecution(owned.id, owned.ownerToken)).toBe(false);
    expect(await database.client`SELECT id FROM auth.session WHERE user_id=${userID}`).toHaveLength(
      0,
    );
    expect((await signIn()).status).toBe(403);
    await serverCall(
      callFactoryFunction(fixture.base, "setAccountAccess", [userID, false], {
        cookie: adminCookie,
      }),
    );
    expect((await signIn()).status).toBe(200);
    expect(
      await callFactoryFunction(fixture.base, "setAccountAccess", [admin, true], {
        cookie: adminCookie,
      }),
    ).toMatchObject({ ok: false, status: 409 });
    const [fresh] = await database.client<
      Array<{ id: string }>
    >`SELECT id FROM auth.session WHERE user_id=${admin}`;
    if (!fresh) throw new Error("Admin session missing");
    await database.client`UPDATE auth.session SET authenticated_at=now()-interval '10 minutes' WHERE id=${fresh.id}`;
    const stale = await callFactoryFunction(fixture.base, "setAccountAccess", [userID, true], {
      cookie: adminCookie,
    });
    expect(stale).toMatchObject({ ok: false, status: 403 });
  } finally {
    await database.client.end();
    await fixture.dispose();
  }
}, 60_000);

test("personal App previews are project-wide, files and runtime management remain private", async () => {
  const process = await factoryProcess();
  const database = process.connect();
  try {
    await process.start();
    const owner = crypto.randomUUID();
    const contributor = crypto.randomUUID();
    const stranger = crypto.randomUUID();
    for (const id of [owner, contributor, stranger])
      await database.client`INSERT INTO auth."user"(id,name,email) VALUES(${id},'Preview member',${`${id}@factory.local`})`;
    const project = crypto.randomUUID();
    const workspace = crypto.randomUUID();
    const attempt = crypto.randomUUID();
    await database.client`INSERT INTO factory.project(id,slug,name,repository_url,default_branch,devcontainer_path,created_by)
      VALUES(${project},${`preview-${project}`},'Preview','https://example.invalid/repo.git','main','.devcontainer/devcontainer.json',${owner})`;
    await database.client`INSERT INTO factory.project_membership(project_id,user_id,role,updated_by)
      VALUES(${project},${owner},'developer',${owner}),(${project},${contributor},'product-contributor',${owner})`;
    await database.client`INSERT INTO factory.development_workspace(id,project_id,kind,owner_user_id,source_branch,source_revision,created_by)
      VALUES(${workspace},${project},'personal',${owner},'main',${"a".repeat(40)},${owner})`;
    await database.client`INSERT INTO factory.runtime_attempt(id,project_id,workspace_id,generation,revision,state,parent_connector_token_hash,child_connector_token_hash,create_intended_at,created_by)
      VALUES(${attempt},${project},${workspace},1,${"a".repeat(40)},'ready',${"b".repeat(64)},${"c".repeat(64)},now(),${owner})`;
    const access = createAccessController(database);
    await access.requireRuntime(contributor, attempt, "app");
    const previews = createProjectAppPreviews(database, (id) =>
      id === attempt ? ["app", "app-api"] : [],
    );
    const visible = await previews(project, contributor);
    expect(visible).toHaveLength(2);
    expect(visible[0]).toMatchObject({ attemptID: attempt, projectID: project, channel: "app" });
    expect(Object.keys(visible[0] ?? {}).sort()).toEqual([
      "attemptID",
      "channel",
      "label",
      "projectID",
    ]);
    await expect(previews(project, stranger)).rejects.toThrow("Project not found");
    await expect(access.requireRuntime(contributor, attempt, "ide")).rejects.toThrow(
      "Runtime not found",
    );
    await expect(access.requireRuntime(contributor, attempt)).rejects.toThrow("Runtime not found");
    await expect(access.requireRuntime(stranger, attempt, "app")).rejects.toThrow(
      "Project not found",
    );
    await access.requireRuntime(owner, attempt, "ide");
    await database.client`DELETE FROM factory.project_membership WHERE user_id=${contributor} AND project_id=${project}`;
    await expect(access.requireRuntime(contributor, attempt, "app")).rejects.toThrow(
      "Project not found",
    );
    await expect(previews(project, contributor)).rejects.toThrow("Project not found");
  } finally {
    await database.client.end();
    await process.dispose();
  }
}, 60_000);
