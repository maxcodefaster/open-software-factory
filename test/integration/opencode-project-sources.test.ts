import { expect, test } from "bun:test";
import { createMCPConnections } from "../../apps/factory/src/mcp/connections";
import { createMCPSourceEndpoint } from "../../apps/factory/src/mcp/sources";
import { createChangeAdmission } from "../../apps/factory/src/agent/change-admission";
import { createAgentTurnStore } from "../../apps/factory/src/agent/turn-store";
import { connectOpenCodeSources } from "../../apps/factory/src/agent/opencode-browser";
import { candidateReviewPermissions } from "../../packages/conversation-domain/src/candidate-review";
import { buildModelID, fixture } from "../fixtures/change-agent-turns";
import { observe, pinnedOpenCode } from "../fixtures/pinned-opencode";

test("native OpenCode searches and reads actual Factory Project sources without a second agent", async () => {
  const f = await fixture();
  const pageID = crypto.randomUUID();
  const capability = crypto.randomUUID();
  let native: Awaited<ReturnType<typeof pinnedOpenCode>> | undefined;
  let endpoint: ReturnType<typeof Bun.serve> | undefined;
  let provider: ReturnType<typeof Bun.serve> | undefined;
  const calls: string[] = [];
  const catalogues: string[][] = [];
  let readReachedModel = false;
  try {
    await f.database.client`INSERT INTO factory.knowledge_page(
      id,project_id,slug,title,current_body,generated_body,source_commit_sha,created_by)
      VALUES(${pageID},${f.projectID},'native-reference','Native Project reference',
        'The retained Project reference marker is forest-42.',
        'The retained Project reference marker is forest-42.',${"b".repeat(40)},${f.userID})`;
    const admission = createChangeAdmission(f.database, buildModelID);
    const admitted = await admission.admit(f.changeID, f.userID, {
      kind: "change-prompt",
      commandId: crypto.randomUUID(),
      text: "Search and read the Native Project reference without changing files.",
    });
    const turns = createAgentTurnStore(f.database);
    const owner = await turns.claimPending(admitted.turn.id, 60_000);
    if (!owner?.ownerToken) throw new Error("Owned Project source lease missing");
    await f.writers.prepareAgent(f.changeID, owner.id);
    await turns.beginDispatch(owner.id, owner.ownerToken);
    const token = owner.ownerToken;
    const connections = createMCPConnections(
      f.database,
      {
        configured: false,
        read: async () => undefined,
        create: async () => {
          throw new Error("Project tools require no provider secret");
        },
      },
      "owned-project-sources",
      "https://factory.example",
    );
    const facade = createMCPSourceEndpoint(f.database, connections, {
      authorizeRuntime: async (attemptID, turnID, authorization) => {
        if (
          attemptID !== f.attemptID ||
          turnID !== owner.id ||
          authorization !== `Bearer ${capability}` ||
          !(await turns.validateExecution(owner.id, token))
        )
          return null;
        return {
          session: {
            id: crypto.randomUUID(),
            ordinal: 1,
            turnID: owner.id,
            changeID: f.changeID,
            attemptID: f.attemptID,
            generation: 1,
            agentSessionID: f.sessionID,
            ownerID: f.userID,
            state: "intended" as const,
          },
          ownerToken: token,
        };
      },
    });
    endpoint = Bun.serve({
      hostname: "0.0.0.0",
      port: 0,
      async fetch(request) {
        const body = await request
          .clone()
          .json()
          .catch(() => null);
        if (body?.method === "tools/call") calls.push(body.params.name);
        return facade(request, f.attemptID, owner.id);
      },
    });
    provider = Bun.serve({
      hostname: "0.0.0.0",
      port: 0,
      async fetch(request) {
        const body = await request.json();
        expect(JSON.stringify(body)).not.toContain(capability);
        const names: string[] = (body.tools ?? []).map(
          (tool: { function: { name: string } }) => tool.function.name,
        );
        catalogues.push(names);
        const tools = body.messages.filter((message: { role: string }) => message.role === "tool");
        const canSearch = names.includes("factory_sources_search_project");
        readReachedModel ||= tools.some((message: { content: unknown }) =>
          JSON.stringify(message.content).includes("forest-42"),
        );
        const call = canSearch && tools.length < 2;
        const name = tools.length === 0 ? "search_project" : "read_project";
        const args =
          tools.length === 0
            ? { query: "Native Project reference", source: "knowledge" }
            : { source: "knowledge", id: pageID };
        const delta = call
          ? {
              tool_calls: [
                {
                  index: 0,
                  id: `owned_project_${tools.length}`,
                  type: "function",
                  function: { name: `factory_sources_${name}`, arguments: JSON.stringify(args) },
                },
              ],
            }
          : { content: "The actual authorized Project source was inspected." };
        const chunk = (value: unknown, finish_reason: string | null = null) => ({
          id: `owned-project-${catalogues.length}`,
          object: "chat.completion.chunk",
          model: buildModelID,
          choices: [{ index: 0, delta: value, finish_reason }],
        });
        return new Response(
          [
            `data: ${JSON.stringify(chunk(delta))}\n\n`,
            `data: ${JSON.stringify(chunk({}, call ? "tool_calls" : "stop"))}\n\n`,
            "data: [DONE]\n\n",
          ].join(""),
          { headers: { "content-type": "text/event-stream" } },
        );
      },
    });
    native = await pinnedOpenCode(
      undefined,
      undefined,
      undefined,
      `http://host.orb.internal:${provider.port}/v1`,
    );
    await connectOpenCodeSources(
      native.client,
      `http://host.orb.internal:${endpoint.port}/internal/build-browser/${f.attemptID}/${owner.id}`,
      capability,
    );
    const sessionID = `ses_project_${crypto.randomUUID().replaceAll("-", "")}`;
    await native.client.session.create({
      id: sessionID,
      title: "Owned Project source proof",
      location: { directory: "/workspace/project" },
      model: { providerID: "factory", id: buildModelID },
      permissions: [{ action: "*", resource: "*", effect: "allow" }],
    });
    await native.client.session.prompt({
      sessionID,
      id: `msg_${crypto.randomUUID().replaceAll("-", "")}`,
      text: "Read the Native Project reference.",
      delivery: "queue",
      resume: true,
    });
    await observe(
      () => native!.client.message.list({ sessionID, limit: 50 }),
      (page) =>
        calls.length === 2 &&
        catalogues.length >= 3 &&
        readReachedModel &&
        page.data.some(
          (message) => message.type === "assistant" && Boolean(message.time.completed),
        ),
      "Native Project reads did not reach the model",
      30_000,
    );
    expect(calls).toEqual(["search_project", "read_project"]);
    expect(catalogues[0]).toContain("factory_sources_search_project");
    const reviewerID = `ses_project_review_${crypto.randomUUID().replaceAll("-", "")}`;
    const beforeReview = catalogues.length;
    await native.client.session.create({
      id: reviewerID,
      title: "Owned restricted review",
      location: { directory: "/workspace/project" },
      model: { providerID: "factory", id: buildModelID },
      permissions: candidateReviewPermissions,
    });
    await native.client.session.prompt({
      sessionID: reviewerID,
      id: `msg_${crypto.randomUUID().replaceAll("-", "")}`,
      text: "Finish the restricted review.",
      delivery: "queue",
      resume: true,
    });
    await observe(
      () => native!.client.message.list({ sessionID: reviewerID, limit: 50 }),
      (page) =>
        catalogues.length > beforeReview &&
        page.data.some(
          (message) => message.type === "assistant" && Boolean(message.time.completed),
        ),
      "Restricted native review did not settle",
      30_000,
    );
    expect(catalogues[beforeReview]).not.toContain("factory_sources_search_project");
    expect(calls).toEqual(["search_project", "read_project"]);
    await turns.settle(owner.id, token, "completed", "Native Project source reads verified");
    const response = await fetch(`http://127.0.0.1:${endpoint.port}/internal/mcp`, {
      method: "POST",
      headers: { authorization: `Bearer ${capability}`, "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(response.status).toBe(403);
  } finally {
    await native?.dispose();
    await endpoint?.stop(true);
    await provider?.stop(true);
    await f.database
      .client`DELETE FROM factory.knowledge_page WHERE id=${pageID} AND project_id=${f.projectID}`;
    await f.dispose();
  }
}, 120_000);
