import { createHash } from "node:crypto";
import { expect, test } from "bun:test";
import { createChangeController } from "../../apps/factory/src/change/controller";
import { createChangeAdmission } from "../../apps/factory/src/agent/change-admission";
import { createTicketDocumentController } from "../../apps/factory/src/change/document";
import { canonicalRequirementContent } from "../../packages/requirement-domain/src/requirement";
import { factoryProcess, eventually } from "../fixtures/factory-process";

test("Implement atomically freezes requirements and Build before branch create; duplicates and lost outcome never re-admit", async () => {
  const process = await factoryProcess();
  const database = process.connect();
  const savedEnvironment = {
    FACTORY_FORGEJO_API_URL: globalThis.process.env["FACTORY_FORGEJO_API_URL"],
    FACTORY_FORGEJO_TOKEN: globalThis.process.env["FACTORY_FORGEJO_TOKEN"],
    FACTORY_FORGEJO_OWNER: globalThis.process.env["FACTORY_FORGEJO_OWNER"],
  };
  const branches = new Set<string>();
  const reachedCreate = Promise.withResolvers<void>();
  const releaseCreate = Promise.withResolvers<void>();
  let branchCreates = 0;
  let runtimeCreates = 0;
  let protectionAttempts = 0;
  let protectionConfirmed = false;
  const ready: string[] = [];
  const sha = "a".repeat(40);
  const forge = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const path = new URL(request.url).pathname;
      if (path === "/api/v1/repos/owned/starter")
        return Response.json({
          owner: { login: "owned" },
          name: "starter",
          default_branch: "main",
        });
      if (path.endsWith("/branches") && request.method === "POST") {
        expect(protectionConfirmed).toBe(true);
        const input = (await request.json()) as { new_branch_name: string };
        const recorded = await database.client<Array<{ revisionID: string; turnState: string }>>`
        SELECT approval.requirement_revision_id AS "revisionID", turn.state AS "turnState"
        FROM factory.change change JOIN factory.requirement_approval approval ON approval.id = change.requirement_approval_id
        JOIN factory.agent_turn turn ON turn.change_id = change.id
        JOIN factory.change_agent_turn_intent intent ON intent.turn_id = turn.id
        WHERE change.branch_name = ${input.new_branch_name} AND intent.bootstrap`;
        expect(recorded).toHaveLength(1);
        expect(recorded[0]?.turnState).toBe("pending");
        branchCreates += 1;
        branches.add(input.new_branch_name);
        reachedCreate.resolve();
        await releaseCreate.promise;
        // The create succeeded but its acknowledgement was lost. Only observation is allowed.
        return new Response(null, { status: 502 });
      }
      const branch = decodeURIComponent(path.split("/branches/")[1] ?? "");
      if (branch === "main" || branches.has(branch))
        return Response.json({ name: branch, commit: { id: sha } });
      return new Response(null, { status: 404 });
    },
  });
  try {
    await process.start();
    const userID = crypto.randomUUID();
    await database.client`INSERT INTO auth."user"(id, name, email, email_verified)
      VALUES (${userID}, 'Owned Contributor', ${`commission-${userID}@factory.local`}, true)`;
    const projectID = crypto.randomUUID();
    const ticketID = crypto.randomUUID();
    const revisionID = crypto.randomUUID();
    const canonical = canonicalRequirementContent({
      summary: "Commissioned work",
      acceptanceCriteria: ["Use the exact scope"],
      nonGoals: [],
    });
    await database.client`INSERT INTO factory.project(id, slug, name, repository_url, default_branch, devcontainer_path, created_by)
      VALUES (${projectID}, ${`commission-${projectID}`}, 'Commission', ${`http://127.0.0.1:${forge.port}/owned/starter.git`}, 'main', '.devcontainer/devcontainer.json', ${userID})`;
    await database.client`INSERT INTO factory.ticket(id, project_id, title, state, created_by)
      VALUES (${ticketID}, ${projectID}, 'Commission', 'ready', ${userID})`;
    await database.client`INSERT INTO factory.project_membership(project_id, user_id, role, updated_by)
      VALUES (${projectID}, ${userID}, 'product-contributor', ${userID})`;
    await database.client`INSERT INTO factory.requirement_revision(id, ticket_id, ordinal, canonical_content, content_digest, created_by)
      VALUES (${revisionID}, ${ticketID}, 1, ${canonical}, ${createHash("sha256").update(canonical).digest("hex")}, ${userID})`;
    Object.assign(globalThis.process.env, {
      FACTORY_FORGEJO_API_URL: `http://127.0.0.1:${forge.port}/api/v1/`,
      FACTORY_FORGEJO_TOKEN: "owned-test-token",
      FACTORY_FORGEJO_OWNER: "owned",
    });
    const admission = createChangeAdmission(database, "factory-coding-model");
    const changes = createChangeController(
      database,
      {
        startPersisted: async () => {
          runtimeCreates += 1;
          return null;
        },
        stop: async () => null,
      },
      async (id) => {
        ready.push(id);
      },
      async (id) => {
        protectionAttempts++;
        const [change] = await database.client<{ branch: string }[]>`
          SELECT branch_name AS branch FROM factory.change WHERE id=${id}`;
        expect(branches.has(change!.branch)).toBe(false);
        if (protectionAttempts === 1) throw new Error("Owned lost protection confirmation");
        protectionConfirmed = true;
      },
    );
    const commandID = crypto.randomUUID();
    const commission = {
      commandID,
      revisionID,
      admitBuild: (sql: Parameters<typeof admission.admitIn>[0], changeID: string) =>
        admission.admitIn(sql, changeID, userID, { kind: "change-start", commandId: commandID }),
    };
    const documents = createTicketDocumentController(database);
    const partialDocumentID = crypto.randomUUID();
    await documents.save(ticketID, userID, {
      commandId: partialDocumentID,
      expectedVersion: 1,
      expectedDocumentId: null,
      requirementRevisionId: revisionID,
      title: "Commission",
      description: "Human refinement in progress",
      requirement: { summary: "", acceptanceCriteria: [], nonGoals: [] },
    });
    await expect(changes.start(ticketID, userID, commission)).rejects.toThrow(
      "Finish the current specification",
    );
    expect(branchCreates).toBe(0);
    expect(
      await database.client`SELECT id FROM factory.requirement_approval WHERE ticket_id=${ticketID}`,
    ).toHaveLength(0);
    expect(
      await database.client`SELECT id FROM factory.change WHERE ticket_id=${ticketID}`,
    ).toHaveLength(0);
    await documents.save(ticketID, userID, {
      commandId: crypto.randomUUID(),
      expectedVersion: 2,
      expectedDocumentId: partialDocumentID,
      requirementRevisionId: revisionID,
      title: "Commission",
      description: "Human refinement complete",
      requirement: JSON.parse(canonical),
    });
    await expect(
      changes.start(ticketID, userID, {
        ...commission,
        admitBuild: async () => {
          throw new Error("Injected admission failure");
        },
      }),
    ).rejects.toThrow("Injected admission failure");
    expect(
      await database.client`SELECT id FROM factory.requirement_approval WHERE ticket_id = ${ticketID}`,
    ).toHaveLength(0);
    expect(
      await database.client`SELECT id FROM factory.change WHERE ticket_id = ${ticketID}`,
    ).toHaveLength(0);
    expect(branchCreates).toBe(0);
    const first = await changes.start(ticketID, userID, commission);
    if (!first) throw new Error("Owned Change missing");
    await eventually(
      () =>
        database.client`SELECT state FROM factory.branch_create_operation WHERE change_id=${first.id}`,
      (rows) => rows[0]?.["state"] === "ambiguous",
      "Protection failure must retain recoverable branch intent",
      30_000,
    );
    expect((await changes.get(first.id))?.state).toBe("branch-pending");
    expect(branchCreates).toBe(0);
    expect(ready).toHaveLength(0);
    await changes.recover();
    await reachedCreate.promise;
    const replay = await changes.start(ticketID, userID, commission);
    expect(replay?.id).toBe(first.id);
    // A stale second viewer must reuse admitted work rather than initiate a new Build.
    const secondCommand = crypto.randomUUID();
    await changes.start(ticketID, userID, {
      ...commission,
      commandID: secondCommand,
      admitBuild: (sql) =>
        admission.admitIn(sql, first.id, userID, {
          kind: "change-start",
          commandId: secondCommand,
        }),
    });
    expect(
      await database.client`SELECT id FROM factory.agent_turn WHERE change_id = ${first.id}`,
    ).toHaveLength(1);
    releaseCreate.resolve();
    await eventually(
      () => changes.get(first.id),
      (change) => change?.state === "active" && ready.includes(first.id),
      "Owned branch outcome not recovered",
      30_000,
    );
    expect(branchCreates).toBe(1);
    expect(protectionAttempts).toBe(2);
    expect(runtimeCreates).toBe(0);
    expect(ready).toContain(first.id);
    const [intent] = await database.client<
      Array<{ scope: string; commandID: string; state: string; prompt: string }>
    >`
      SELECT turn.authority->>'requirementRevisionId' AS scope, turn.command_id AS "commandID", turn.state, intent.prompt_text AS prompt
      FROM factory.agent_turn turn JOIN factory.change_agent_turn_intent intent ON intent.turn_id = turn.id WHERE turn.change_id = ${first.id}`;
    expect(intent?.scope).toBe(revisionID);
    expect(intent?.commandID).toBe(commandID);
    expect(intent?.state).toBe("pending");
    expect(intent?.prompt).toContain(canonical);
    await expect(
      changes.start(ticketID, userID, { ...commission, revisionID: crypto.randomUUID() }),
    ).rejects.toMatchObject({ code: "conflict" });
    // Manual recovery succeeded before the original two-second retry. Closing
    // this fixture must not leave that stale callback using a disposed client.
    await database.client.end();
    await Bun.sleep(2_200);
  } finally {
    releaseCreate.resolve();
    for (const [key, value] of Object.entries(savedEnvironment)) {
      if (value === undefined) delete globalThis.process.env[key];
      else globalThis.process.env[key] = value;
    }
    await forge.stop(true);
    await database.client.end();
    await process.dispose();
  }
}, 60_000);
