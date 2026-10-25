import { expect, test } from "bun:test";
import { inheritedModelSettingsView } from "../../packages/conversation-domain/src/model-inheritance";
import { createModelSettingsController } from "../../apps/factory/src/models/controller";
import { createChangeAdmission } from "../../apps/factory/src/agent/change-admission";
import { createAgentTurnStore } from "../../apps/factory/src/agent/turn-store";
import { createProjectAgentController } from "../../apps/factory/src/project-agent/controller";
import { fixture } from "../fixtures/change-agent-turns";
import { factoryProcess } from "../fixtures/factory-process";
import { callFactoryFunction, factoryFunctionRequest } from "../fixtures/server-functions";
import { serverCall, type ServerResult } from "../../apps/factory/src/server-functions/result";
import { decodeResponse } from "@solidjs/web/server-functions/client";

const administrator = "01994a7d-0000-7000-8000-000000000001";
const systemModel = "system-model";
const models = [systemModel, "project-model", "personal-model"];
const environment = {
  planningModelId: systemModel,
  buildModelId: systemModel,
  models,
  baseURL: undefined,
  apiKey: undefined,
};

test("scoped model commands enforce hierarchy, roles, Reset and CAS across restart", async () => {
  const process = await factoryProcess(undefined, {
    FACTORY_PROJECT_AGENT_MODEL: systemModel,
    FACTORY_AGENT_MODEL_ID: systemModel,
    FACTORY_MODEL_IDS: models.join(","),
  });
  const database = process.connect();
  let owned: Awaited<ReturnType<typeof fixture>> | undefined;
  try {
    const firstProcess = await process.start();
    owned = await fixture(undefined, undefined, database);
    const settings = createModelSettingsController(database, environment);
    const adminCookie = await process.signIn();
    const email = `model-manager-${crypto.randomUUID()}@factory.local`;
    await database.client`UPDATE auth."user" SET email = ${email} WHERE id = ${owned.userID}`;
    await database.client`INSERT INTO auth.account(id, account_id, provider_id, user_id, password)
      SELECT ${crypto.randomUUID()}, ${owned.userID}, 'credential', ${owned.userID}, password
      FROM auth.account WHERE user_id = ${administrator} AND provider_id = 'credential'`;
    const login = await fetch(`${process.base}/api/auth/sign-in/email`, {
      method: "POST",
      headers: { origin: process.base, "content-type": "application/json" },
      body: JSON.stringify({ email, password: "owned-process-password-not-a-secret" }),
    });
    expect(login.status).toBe(200);
    const cookie = login.headers
      .getSetCookie()
      .map((item) => item.split(";")[0])
      .join("; ");
    const headers = { cookie, origin: process.base, "content-type": "application/json" };
    const projectID = owned.projectID;
    const read = async () =>
      inheritedModelSettingsView.parse(
        await serverCall(
          callFactoryFunction(process.base, "getProjectModels", [projectID], headers),
        ),
      );
    const write = async (scope: "project" | "personal", body: unknown) => {
      const result = await decodeResponse<ServerResult<unknown>>(
        await fetch(
          await factoryFunctionRequest(
            process.base,
            scope === "personal" ? "savePersonalModels" : "saveProjectModels",
            [projectID, body],
            headers,
          ),
        ),
      );
      if (!result) throw new Error("Scoped model command returned no result");
      return { status: result.ok ? 200 : result.status };
    };
    const initial = await read();
    expect(initial.canManageProject).toBe(false);
    expect(initial.effective.build.source).toBe("system");
    expect((await write("project", initial.project)).status).toBe(403);
    expect(await callFactoryFunction(process.base, "getModelSettings", [], headers)).toMatchObject({
      ok: false,
      status: 403,
    });
    expect(
      await callFactoryFunction(process.base, "getProjectModels", [crypto.randomUUID()], headers),
    ).toMatchObject({ ok: false, status: 404 });
    await database.client`UPDATE factory.project_membership SET manage_project = true WHERE project_id = ${owned.projectID} AND user_id = ${owned.userID}`;
    const project = {
      ...initial.project,
      planning: {
        modelId: "project-model",
        models: ["project-model", "personal-model"],
        allowOverride: true,
      },
      build: {
        modelId: "project-model",
        models: ["project-model", "personal-model"],
        allowOverride: true,
      },
    };
    expect((await write("project", project)).status).toBe(200);
    expect((await write("project", project)).status).toBe(409);
    expect((await read()).effective.build.source).toBe("project");
    const personal = {
      version: 0,
      planningModelId: "personal-model",
      buildModelId: "personal-model",
    };
    expect((await write("personal", { ...personal, userId: administrator })).status).toBe(400);
    expect((await write("personal", { ...personal, buildModelId: "system-model" })).status).toBe(
      409,
    );
    const concurrent = await Promise.all([
      write("personal", personal),
      write("personal", personal),
    ]);
    expect(concurrent.map((response) => response.status).sort()).toEqual([200, 409]);
    const selected = await read();
    expect(selected.effective.build.modelId).toBe("personal-model");
    expect(selected.effective.build.source).toBe("personal");
    const otherViewer = await settings.getInherited(owned.projectID, administrator);
    expect(otherViewer.personal.version).toBe(0);
    expect(otherViewer.effective.build.modelId).toBe("project-model");
    await process.kill(firstProcess);
    await process.start();
    expect(await read()).toEqual(selected);
    expect(
      (
        await write("personal", {
          ...selected.personal,
          planningModelId: null,
          buildModelId: null,
        })
      ).status,
    ).toBe(200);
    expect((await read()).effective.build.source).toBe("project");
    const projectLocked = {
      ...(await read()).project,
      build: { ...project.build, allowOverride: false },
    };
    expect((await write("project", projectLocked)).status).toBe(200);
    expect(
      (await write("personal", { ...(await read()).personal, buildModelId: "personal-model" }))
        .status,
    ).toBe(409);
    expect((await read()).effective.build.lockedReason).toBe("Locked by Project Manager");
    // Tightening parent rules safely ignores obsolete lower-scope settings.
    const systemResponse = await callFactoryFunction(
      process.base,
      "saveModelSettings",
      [
        {
          version: 0,
          planningModelId: "system-model",
          buildModelId: "system-model",
          rules: {
            planning: { models, allowOverride: true },
            build: { models: ["system-model"], allowOverride: false },
          },
        },
      ],
      { ...headers, cookie: adminCookie },
    );
    expect(systemResponse.ok).toBe(true);
    const locked = await read();
    expect(locked.effective.build.allowOverride).toBe(false);
    expect(locked.effective.build.lockedReason).toBe("Locked by System Manager");
    expect(locked.effective.build.available).toBe(false);
    expect(
      (
        await write("project", {
          ...locked.project,
          build: { modelId: "personal-model", models, allowOverride: true },
        })
      ).status,
    ).toBe(409);
    expect(
      (
        await write("project", {
          ...locked.project,
          build: { modelId: null, models: null, allowOverride: null },
        })
      ).status,
    ).toBe(200);
    const reset = await read();
    expect(reset.effective.build.modelId).toBe("system-model");
    expect(reset.effective.build.available).toBe(true);
    await database.client`DELETE FROM factory.project_membership WHERE project_id = ${owned.projectID} AND user_id = ${owned.userID}`;
    expect(
      await callFactoryFunction(process.base, "getProjectModels", [projectID], headers),
    ).toMatchObject({ ok: false, status: 404 });
    expect(
      (await write("personal", { ...reset.personal, planningModelId: null, buildModelId: null }))
        .status,
    ).toBe(404);
  } finally {
    try {
      if (owned) {
        const fixtureEmail = `build-turn-${owned.projectID.replaceAll("-", "").slice(0, 12)}@factory.local`;
        await database.client`UPDATE auth."user" SET email = ${fixtureEmail} WHERE id = ${owned.userID}`;
        await owned.dispose();
      } else await database.client.end();
    } finally {
      await process.dispose();
    }
  }
}, 60_000);

test("Build resolves the initiating human's model once; other viewers and settings cannot replace it", async () => {
  const processFixture = await factoryProcess();
  const database = processFixture.connect();
  let owned: Awaited<ReturnType<typeof fixture>> | undefined;
  try {
    await processFixture.start();
    owned = await fixture(undefined, undefined, database);
    const settings = createModelSettingsController(database, environment);
    await settings.setProject(owned.projectID, administrator, {
      version: 0,
      planning: { modelId: "project-model", models: null, allowOverride: null },
      build: { modelId: "project-model", models: null, allowOverride: null },
    });
    await settings.setPersonal(owned.projectID, owned.userID, {
      version: 0,
      planningModelId: "personal-model",
      buildModelId: "personal-model",
    });
    const requestedModels: string[] = [];
    const provider = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        const body = (await request.json()) as { model: string; stream?: boolean };
        requestedModels.push(body.model);
        const content = JSON.stringify({
          output: { kind: "answer", message: "Controlled planning response", citations: [] },
        });
        const common = { id: "chatcmpl-inherited-planning", created: 1, model: body.model };
        if (!body.stream)
          return Response.json({
            ...common,
            object: "chat.completion",
            choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          });
        const chunks = [
          {
            ...common,
            object: "chat.completion.chunk",
            choices: [{ index: 0, delta: { role: "assistant", content }, finish_reason: null }],
          },
          {
            ...common,
            object: "chat.completion.chunk",
            choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          },
        ];
        return new Response(
          `${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("")}data: [DONE]\n\n`,
          { headers: { "content-type": "text/event-stream" } },
        );
      },
    });
    const controlled = {
      FACTORY_PROJECT_AGENT_MODEL: systemModel,
      FACTORY_AGENT_MODEL_ID: systemModel,
      FACTORY_MODEL_IDS: models.join(","),
      FACTORY_MODEL_BASE_URL: `http://127.0.0.1:${provider.port}/v1`,
      FACTORY_MODEL_API_KEY: "owned-inheritance-test-key",
      FACTORY_PLANNING_MODEL_BASE_URL: `http://127.0.0.1:${provider.port}/v1`,
      FACTORY_PLANNING_MODEL_API_KEY: "owned-inheritance-test-key",
    };
    const previous = Object.keys(controlled).map((key) => [key, process.env[key]] as const);
    try {
      for (const [key, value] of Object.entries(controlled)) process.env[key] = value;
      const projectAgent = createProjectAgentController(database, { start: async () => null });
      const commandId = crypto.randomUUID();
      await projectAgent.message(
        owned.projectID,
        undefined,
        "Investigate inherited models",
        owned.userID,
        commandId,
      );
      expect(requestedModels).toEqual(["personal-model"]);
      const planned = await createAgentTurnStore(database).getByCommand(commandId);
      expect(planned?.state).toBe("completed");
      expect(planned?.authority.modelId).toBe("personal-model");
    } finally {
      await provider.stop(true);
      for (const [key, value] of previous) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
    const admission = createChangeAdmission(database, (sql, context) =>
      settings.resolve("build", sql, context),
    );
    const first = await admission.admit(owned.changeID, owned.userID, {
      kind: "change-start",
      commandId: crypto.randomUUID(),
    });
    expect(first.turn.authority.modelId).toBe("personal-model");
    const turns = createAgentTurnStore(database);
    const owner = await turns.claimPending(first.turn.id);
    if (!owner?.ownerToken) throw new Error("Owned turn not claimed");
    await turns.failPending(owner.id, owner.ownerToken, "Owned model admission");
    await settings.setPersonal(owned.projectID, owned.userID, {
      version: 1,
      planningModelId: null,
      buildModelId: null,
    });
    await settings.set(
      {
        version: 0,
        planningModelId: "system-model",
        buildModelId: "system-model",
        rules: {
          planning: { models, allowOverride: false },
          build: { models, allowOverride: false },
        },
      },
      administrator,
    );
    const next = await admission.admit(owned.changeID, administrator, {
      kind: "change-prompt",
      commandId: crypto.randomUUID(),
      text: "Continue shared work",
    });
    expect(next.turn.authority.modelId).toBe("personal-model");
    const nextOwner = await turns.claimPending(next.turn.id);
    if (!nextOwner?.ownerToken) throw new Error("Owned next turn not claimed");
    await turns.failPending(nextOwner.id, nextOwner.ownerToken, "Owned shared admission");
    const context = { projectID: owned.projectID, userID: owned.userID };
    expect(await database.client.begin((sql) => settings.resolve("planning", sql, context))).toBe(
      "system-model",
    );
    await database.client`DELETE FROM factory.project_membership WHERE project_id = ${owned.projectID} AND user_id = ${owned.userID}`;
    await expect(
      admission.admit(owned.changeID, owned.userID, {
        kind: "change-start",
        commandId: first.turn.commandId,
      }),
    ).rejects.toMatchObject({ code: "not-found" });
    await expect(
      admission.admit(owned.changeID, owned.userID, {
        kind: "change-prompt",
        commandId: crypto.randomUUID(),
        text: "No revoked admission",
      }),
    ).rejects.toMatchObject({ code: "not-found" });
    await expect(
      createProjectAgentController(database, { start: async () => null }).message(
        owned.projectID,
        undefined,
        "No revoked planning",
        owned.userID,
        crypto.randomUUID(),
      ),
    ).rejects.toMatchObject({ code: "not-found" });
  } finally {
    try {
      if (owned) {
        await database.client`DELETE FROM factory.ticket_conversation WHERE project_id = ${owned.projectID} AND created_by = ${owned.userID}`;
        await owned.dispose();
      } else await database.client.end();
    } finally {
      await processFixture.dispose();
    }
  }
}, 60_000);
