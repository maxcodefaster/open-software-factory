import { createHash } from "node:crypto";
import { expect, test } from "bun:test";
import { canonicalRequirementContent } from "../../packages/requirement-domain/src/requirement";
import { factoryProcess } from "../fixtures/factory-process";
import { callFactoryFunction } from "../fixtures/server-functions";

test("Implement freezes developer reasoning atomically, rejects changed replays and keeps contributor defaults", async () => {
  let modelCalls = 0;
  const provider = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch() {
      modelCalls++;
      return new Response(null, { status: 500 });
    },
  });
  const forge = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const path = new URL(request.url).pathname;
      if (request.method === "GET" && path === "/api/v1/repos/owned/starter")
        return Response.json({
          owner: { login: "owned" },
          name: "starter",
          default_branch: "main",
        });
      if (request.method === "GET" && path.endsWith("/branches/main"))
        return Response.json({ name: "main", commit: { id: "a".repeat(40) } });
      // Reading the base is real; branch admission cannot reach model execution.
      return new Response(null, { status: 503 });
    },
  });
  const process = await factoryProcess(undefined, {
    FACTORY_FORGEJO_API_URL: `${forge.url.origin}/api/v1/`,
    FACTORY_FORGEJO_OWNER: "owned",
    FACTORY_MODEL_BASE_URL: `${provider.url.origin}/v1`,
  });
  const database = process.connect();
  try {
    await process.start();
    async function ownedTicket(role: "developer" | "product-contributor") {
      const userID = crypto.randomUUID();
      const email = `implementation-reasoning-${userID}@factory.local`;
      await database.client`INSERT INTO auth."user"(id,name,email,email_verified)
        VALUES(${userID},'Owned reasoning user',${email},true)`;
      await database.client`INSERT INTO auth.account(id,account_id,provider_id,user_id,password)
        SELECT ${crypto.randomUUID()},${userID},'credential',${userID},password
        FROM auth.account WHERE user_id='01994a7d-0000-7000-8000-000000000001' AND provider_id='credential'`;
      const login = await fetch(`${process.base}/api/auth/sign-in/email`, {
        method: "POST",
        headers: { origin: process.base, "content-type": "application/json" },
        body: JSON.stringify({ email, password: "owned-process-password-not-a-secret" }),
      });
      expect(login.status).toBe(200);
      const cookie = login.headers
        .getSetCookie()
        .map((value) => value.split(";")[0])
        .join("; ");
      const projectID = crypto.randomUUID();
      const ticketID = crypto.randomUUID();
      const revisionID = crypto.randomUUID();
      const canonical = canonicalRequirementContent({
        summary: "Choose reasoning before implementation",
        acceptanceCriteria: ["Freeze the selected effort with the first Build"],
        nonGoals: [],
      });
      await database.client`INSERT INTO factory.project(id,slug,name,repository_url,default_branch,devcontainer_path,created_by)
        VALUES(${projectID},${`reasoning-${projectID}`},'Reasoning',${`${forge.url.origin}/owned/starter.git`},'main','.devcontainer/devcontainer.json',${userID})`;
      await database.client`INSERT INTO factory.project_membership(project_id,user_id,role,updated_by)
        VALUES(${projectID},${userID},${role},${userID})`;
      await database.client`INSERT INTO factory.ticket(id,project_id,title,state,created_by)
        VALUES(${ticketID},${projectID},'Choose reasoning','ready',${userID})`;
      await database.client`INSERT INTO factory.requirement_revision(id,ticket_id,ordinal,canonical_content,content_digest,created_by)
        VALUES(${revisionID},${ticketID},1,${canonical},${createHash("sha256").update(canonical).digest("hex")},${userID})`;
      return {
        userID,
        projectID,
        ticketID,
        revisionID,
        headers: { cookie, origin: process.base, "content-type": "application/json" },
      };
    }
    const developer = await ownedTicket("developer");
    const command = {
      commandId: crypto.randomUUID(),
      revisionId: developer.revisionID,
      codingReasoning: "high" as const,
    };
    const send = (
      ticket: typeof developer,
      body: Parameters<
        typeof import("../../apps/factory/src/server-functions/tickets").implementTicket
      >[1],
    ) =>
      callFactoryFunction(process.base, "implementTicket", [ticket.ticketID, body], ticket.headers);
    expect(await send(developer, command)).toMatchObject({ ok: true });
    expect(await send(developer, command)).toMatchObject({ ok: true });
    expect(await send(developer, { ...command, codingReasoning: "medium" })).toMatchObject({
      ok: false,
      status: 409,
    });
    expect(
      await send(developer, {
        ...command,
        commandId: crypto.randomUUID(),
        codingReasoning: "medium",
      }),
    ).toMatchObject({ ok: false, status: 409 });
    const turns =
      await database.client`SELECT state,authority,input FROM factory.agent_turn WHERE ticket_id=${developer.ticketID}`;
    expect(turns).toHaveLength(1);
    expect(turns[0]?.["authority"]).toMatchObject({
      codingReasoning: "high",
      requirementRevisionId: developer.revisionID,
    });
    expect(turns[0]?.["input"]).toMatchObject({ codingReasoning: "high" });
    expect(
      await database.client`SELECT id FROM factory.requirement_approval WHERE ticket_id=${developer.ticketID}`,
    ).toHaveLength(1);
    await database.client`UPDATE factory.project_membership SET role='product-contributor'
      WHERE project_id=${developer.projectID} AND user_id=${developer.userID}`;
    expect(await send(developer, { ...command, commandId: crypto.randomUUID() })).toMatchObject({
      ok: false,
      status: 403,
    });
    const contributor = await ownedTicket("product-contributor");
    const contributorCommand = {
      commandId: crypto.randomUUID(),
      revisionId: contributor.revisionID,
    };
    expect(
      await send(contributor, { ...contributorCommand, codingReasoning: "high" }),
    ).toMatchObject({ ok: false, status: 403 });
    expect(
      await database.client`SELECT id FROM factory.requirement_approval WHERE ticket_id=${contributor.ticketID}`,
    ).toHaveLength(0);
    expect(
      await database.client`SELECT id FROM factory.change WHERE ticket_id=${contributor.ticketID}`,
    ).toHaveLength(0);
    expect(await send(contributor, contributorCommand)).toMatchObject({ ok: true });
    const defaults =
      await database.client`SELECT authority FROM factory.agent_turn WHERE ticket_id=${contributor.ticketID}`;
    expect(defaults).toHaveLength(1);
    expect(defaults[0]?.["authority"]).toMatchObject({ codingReasoning: "medium" });
    expect(modelCalls).toBe(0);
  } finally {
    await database.client.end();
    await process.dispose();
    await forge.stop(true);
    await provider.stop(true);
  }
}, 60_000);
