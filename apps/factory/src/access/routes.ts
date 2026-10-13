import { z } from "zod";
import type { createFactoryAuth } from "../../../../packages/auth/src/server";
import type { createDatabase } from "../../../../packages/db/src/client";
import { CommandError } from "../command-error";
import { json } from "../http";
import { createAccountCommands } from "./accounts";
import { createAccessController } from "./controller";
import { createMembershipCommands } from "./membership";

const managedUserInput = z
  .object({
    name: z.string().trim().min(1).max(200),
    email: z.email().max(320),
    password: z.string().min(12).max(128),
  })
  .strict();
const memberInput = z
  .object({
    email: z.email().max(320),
    role: z.enum(["developer", "product-contributor"]),
    manageProject: z.boolean().default(false),
  })
  .strict();

export function createAccessRoutes(
  database: ReturnType<typeof createDatabase>,
  factoryAuth: Pick<
    ReturnType<typeof createFactoryAuth>,
    "createManagedUser" | "requireFresh" | "policy"
  >,
  revokeMember: (projectID: string, userID: string) => Promise<void>,
  revokeAccount: (userID: string, disabled: boolean) => Promise<void> = async () => {},
  forgeOrigin?: string,
) {
  const access = createAccessController(database);
  const memberships = createMembershipCommands(database);
  const accounts = createAccountCommands(database);
  async function fresh(request: Request) {
    try {
      await factoryAuth.requireFresh(request);
    } catch {
      throw new CommandError("forbidden", "Sign in again before changing security settings");
    }
  }
  return async function accessRoute(
    request: Request,
    userID: string,
  ): Promise<Response | undefined> {
    const url = new URL(request.url);
    if (url.pathname === "/api/security/session" && request.method === "GET") {
      return json({ ...factoryAuth.policy });
    }
    if (url.pathname === "/api/security/authentication" && request.method === "GET") {
      let fresh = false;
      try {
        await factoryAuth.requireFresh(request);
        fresh = true;
      } catch {}
      const [person] = await database.client<
        { email: string }[]
      >`SELECT email FROM auth."user" WHERE id=${userID}`;
      return json({
        fresh,
        email: person?.email ?? "",
        companySignIn:
          factoryAuth.policy.companySignIn && userID !== "01994a7d-0000-7000-8000-000000000001",
      });
    }
    if (url.pathname === "/api/security/sign-out" && request.method === "POST") {
      return json({
        forgeLogoutURL: forgeOrigin
          ? new URL("/assets/factory-sign-out.html", forgeOrigin).href
          : null,
      });
    }
    if (url.pathname === "/api/security/sessions/end" && request.method === "POST") {
      await fresh(request);
      await accounts.endSessions(userID, userID);
      await revokeAccount(userID, false);
      return new Response(null, { status: 204 });
    }
    const accountCommand = url.pathname.match(
      /^\/api\/admin\/users\/([0-9a-f-]{36})\/(access|sessions)$/,
    );
    if (accountCommand?.[1] && request.method === "POST") {
      await access.requireSystemManager(userID);
      await fresh(request);
      const target = accountCommand[1];
      if (accountCommand[2] === "access") {
        const input = z
          .object({ disabled: z.boolean() })
          .strict()
          .safeParse(await request.json().catch(() => null));
        if (!input.success) return json({ error: "Account access setting is invalid" }, 400);
        await accounts.disable(userID, target, input.data.disabled);
        await revokeAccount(target, input.data.disabled);
      } else {
        await accounts.endSessions(userID, target);
        await revokeAccount(target, false);
      }
      return new Response(null, { status: 204 });
    }
    if (url.pathname === "/api/admin/users") {
      await access.requireSystemManager(userID);
      if (request.method === "GET") {
        const users = await database.client`SELECT auth."user".id, name, email,
          (access.disabled_at IS NOT NULL) AS disabled,
          (access.directory_disabled_at IS NOT NULL) AS "directoryDisabled",
          EXISTS(SELECT 1 FROM factory.administrator WHERE user_id = auth."user".id) AS "systemManager"
          FROM auth."user" JOIN factory.account_access access ON access.user_id=auth."user".id ORDER BY name, auth."user".id`;
        return json({ users });
      }
      if (request.method !== "POST") return new Response(null, { status: 405 });
      await fresh(request);
      if (factoryAuth.policy.companySignIn)
        return json({ error: "Accounts are provisioned through company sign-in" }, 403);
      const input = managedUserInput.safeParse(await request.json().catch(() => null));
      if (!input.success) return json({ error: "Account details are invalid" }, 400);
      try {
        return json(await factoryAuth.createManagedUser(input.data), 201);
      } catch (cause) {
        if (cause && typeof cause === "object" && "code" in cause && cause.code === "23505") {
          return json({ error: "An account with that email already exists" }, 409);
        }
        throw cause;
      }
    }
    const members = url.pathname.match(
      /^\/api\/projects\/([0-9a-f-]{36})\/members(?:\/([0-9a-f-]{36}))?$/,
    );
    if (!members?.[1]) return undefined;
    const projectID = members[1];
    await access.requireProject(userID, projectID, true);
    if (members[2] && request.method === "DELETE") {
      await fresh(request);
      await memberships.change({ projectID, actorID: userID, target: { userID: members[2] } });
      await revokeMember(projectID, members[2]);
      return new Response(null, { status: 204 });
    }
    if (members[2]) return new Response(null, { status: 405 });
    if (request.method === "GET") {
      const rows =
        await database.client`SELECT member.user_id AS "userId", member.role, member.manage_project AS "manageProject", user_row.name, user_row.email
        FROM factory.project_membership member JOIN auth."user" user_row ON user_row.id = member.user_id
        WHERE member.project_id = ${projectID} ORDER BY user_row.name, user_row.id`;
      return json({ members: rows });
    }
    if (request.method !== "POST") return new Response(null, { status: 405 });
    await fresh(request);
    const input = memberInput.safeParse(await request.json().catch(() => null));
    if (!input.success) return json({ error: "Membership details are invalid" }, 400);
    const saved = await memberships.change({ projectID, actorID: userID, target: input.data });
    if (saved) await revokeMember(projectID, saved.userId);
    return json(saved);
  };
}
