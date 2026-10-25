import { expect, test } from "bun:test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { zeroDrizzle } from "@rocicorp/zero/server/adapters/drizzle";
import { z } from "zod";
import { createExecutionReserve } from "../../apps/factory/src/runtime/reserve-controller";
import { requirementsInterviewSkill } from "../../apps/factory/src/skills/reviewed";
import { inheritedModelSettingsView } from "../../packages/conversation-domain/src/model-inheritance";
import {
  inheritedSkillSettingsView,
  systemSkillSettingsView,
} from "../../packages/conversation-domain/src/skill-inheritance";
import {
  type SkillContent,
  skillRevisionInput,
} from "../../packages/conversation-domain/src/skills";
import { createForgejoClient } from "../../packages/forge/src/forge";
import {
  defaultReservePolicy,
  type ExecutionSlot,
} from "../../packages/runtime-domain/src/reserve";
import { createReserveClient } from "../../packages/runtime-kubernetes/src/reserve";
import { zeroQueries, zeroSchema } from "../../packages/zero-schema/src";
import { zeroServerMutators } from "../../packages/zero-schema/src/server";
import { removeOwnedProjectSources } from "../fixtures/editor-source-resources";
import { eventually, factoryProcess } from "../fixtures/factory-process";
import { callFactoryFunction, conversationCommand } from "../fixtures/server-functions";
import { serverCall } from "../../apps/factory/src/server-functions/result";

const repository = { owner: "factory-mutation", name: "runtime-fixture" };
const administrator = "01994a7d-0000-7000-8000-000000000001";

test.skipIf(process.env["FACTORY_LIVE_TEAM_DELIVERY"] !== "1")(
  "managed developer delivers a real governed Change before its Epic-dependent Ticket can Build",
  async () => {
    const modelId = process.env["FACTORY_LIVE_MODEL_ID"] ?? process.env["FACTORY_AGENT_MODEL_ID"];
    if (!modelId || !process.env["FACTORY_MODEL_API_KEY"] || !process.env["FACTORY_MODEL_BASE_URL"])
      throw new Error("Team Delivery requires the configured deployed model");
    const runtimeHostImage = (await readFile(".factory/runtime-host-image", "utf8")).trim();
    const forgejoToken = (await readFile(".factory/forgejo-token", "utf8")).trim();
    const providerURL = process.env["FACTORY_MODEL_BASE_URL"];
    const providerKey = process.env["FACTORY_MODEL_API_KEY"];
    const buildSkill: SkillContent = {
      ...requirementsInterviewSkill,
      key: "exact-requirement-implementation",
      name: "Exact Requirement implementation",
      description: "Implement the approved observable behavior without widening its scope.",
      roles: ["build"],
      instructions:
        "Implement only the approved Requirement. Separate repository facts from assumptions. Use references/implementation-checklist.md before reporting completion.",
      references: [
        {
          path: "references/implementation-checklist.md",
          body: "Check the exact requested version, run the declared syntax check, and preserve unrelated application behavior. Do not edit runtime configuration or dependencies.",
        },
      ],
      review: {
        trigger: "Load automatically when assigned as a required Build baseline.",
        adaptations:
          "This test adapts the reviewed decision and observable-acceptance principles to one implementation checklist. The instructions and reference are Factory-authored, contain no executable imports and grant no additional tools or approval authority.",
      },
    };
    let planningSkillID = "";
    let buildSkillID = "";
    const observations: Array<{
      model: string;
      planning: boolean;
      build: boolean;
      replacement: boolean;
    }> = [];
    const provider = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        const suffix = new URL(request.url).pathname.replace(/^\/v1\//, "");
        if (!["chat/completions", "responses"].includes(suffix))
          return new Response(null, { status: 404 });
        const body = z
          .object({ model: z.string() })
          .passthrough()
          .parse(await request.json());
        const text = JSON.stringify(body);
        const contains = (content: string) => text.includes(JSON.stringify(content).slice(1, -1));
        observations.push({
          model: body.model,
          planning:
            Boolean(planningSkillID) &&
            text.includes(planningSkillID) &&
            contains(requirementsInterviewSkill.instructions) &&
            requirementsInterviewSkill.references.every((ref) => contains(ref.body)),
          build:
            Boolean(buildSkillID) &&
            text.includes(buildSkillID) &&
            contains(buildSkill.instructions) &&
            buildSkill.references.every((ref) => contains(ref.body)),
          replacement: text.includes("Replacement content must not reach this admitted Build"),
        });
        // Forward unchanged to the real provider; retain only bounded content-presence observations.
        if (observations.length > 100) observations.shift();
        return fetch(`${providerURL?.replace(/\/$/, "")}/${suffix}`, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${providerKey}` },
          body: JSON.stringify(body),
          redirect: "error",
          signal: request.signal,
        });
      },
    });
    let fixture: Awaited<ReturnType<typeof factoryProcess>>;
    try {
      fixture = await factoryProcess(
        { runtimeHostImage, forgejoToken },
        { FACTORY_MODEL_BASE_URL: `http://127.0.0.1:${provider.port}/v1` },
      );
    } catch (cause) {
      await provider.stop(true);
      throw cause;
    }
    const database = fixture.connect();
    // Own preparation separately so cleanup can join every create before removing its database.
    const reserve = createExecutionReserve(
      database,
      {
        staging: runtimeHostImage,
        verification: (await readFile(".factory/verification-runtime-host-image", "utf8")).trim(),
      },
      defaultReservePolicy,
    );
    const reserveClient = createReserveClient();
    const reserveSlots = () =>
      database.client.unsafe<ExecutionSlot[]>(
        'SELECT id,role,state,runtime_host_image AS "runtimeHostImage",kubernetes_namespace AS namespace,namespace_uid AS "namespaceUID",pod_uid AS "podUID",claim_uid AS "claimUID",expires_at AS "expiresAt",assigned_attempt_id AS "assignedAttemptID" FROM factory.execution_slot ORDER BY created_at,id',
      );
    const forge = createForgejoClient({
      apiURL: "http://127.0.0.1:33030/api/v1/",
      token: forgejoToken,
    });
    const projectID = crypto.randomUUID();
    const slug = `team-delivery-${projectID.slice(0, 8)}`;
    const directory = `.factory/test-results/team-delivery/${slug}`;
    await mkdir(directory, { recursive: true });
    let adminCookie = "";
    let changeID: string | undefined;
    let branch: string | undefined;
    let verifiedSHA: string | undefined;
    let baseSHA: string | undefined;
    let dependencyProof:
      | {
          ticketID: string;
          rootEpicID: string;
          childEpicID: string;
          blockedStatus: number;
          nextChange?: { id: string; baseSha: string; branchName: string };
          nextBuild?: {
            id: string;
            state: string;
            model: string;
            skills: string[];
            commitSHA: string;
          };
        }
      | undefined;
    let safeToDispose = false;
    async function request(path: string, cookie: string, method = "GET", body?: unknown) {
      return fetch(`${fixture.base}${path}`, {
        method,
        headers: { cookie, origin: fixture.base, "content-type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        redirect: "manual",
        signal: AbortSignal.timeout(path.endsWith("/ticket-workspace/ensure") ? 180_000 : 90_000),
      });
    }
    async function command(path: string, cookie: string, body: unknown = {}, method = "POST") {
      const response = await request(path, cookie, method, body);
      if (!response.ok) throw new Error(`Team command ${path} failed: ${response.status}`);
      return response;
    }
    async function account(role: string) {
      const email = `${role}-${projectID}@factory.local`;
      const password = "owned-team-delivery-password";
      const user = z.object({ id: z.uuid() }).parse(
        await serverCall(
          callFactoryFunction(
            fixture.base,
            "createAccount",
            [
              {
                name: `Team ${role}`,
                email,
                password,
              },
            ],
            { cookie: adminCookie },
          ),
        ),
      );
      const login = await command("/api/auth/sign-in/email", "", { email, password });
      const cookie = login.headers
        .getSetCookie()
        .map((item) => item.split(";")[0])
        .join("; ");
      return { id: user.id, email, cookie };
    }
    async function staging() {
      const [row] = await database.client<Array<{ id: string; revision: string; state: string }>>`
        SELECT attempt.id, preview.revision, attempt.state FROM factory.staging_preview preview
        JOIN factory.runtime_attempt attempt ON attempt.id = preview.runtime_attempt_id WHERE preview.project_id = ${projectID}
      `;
      return row;
    }
    try {
      console.info("Team Delivery: preparing clean Staging and Verification, one create at a time");
      await reserve.start();
      let observedReserveStates = "";
      await eventually(
        async () => {
          const slots = await reserveSlots();
          const states = slots.map((slot) => `${slot.role}:${slot.state}`).join(", ");
          if (states !== observedReserveStates) {
            console.info(`Team Delivery reserve: ${states}`);
            observedReserveStates = states;
          }
          if (slots.some((slot) => slot.state === "retiring" || slot.state === "deleted"))
            throw new Error("Owned clean slot exceeded its individual preparation bound");
          return slots;
        },
        (slots) => slots.filter((slot) => slot.state === "ready").length === 2,
        "Owned execution reserve did not prepare both roles",
        2 * defaultReservePolicy.preparationMS + 10_000,
      );
      await fixture.start();
      adminCookie = await fixture.signIn();
      await serverCall(
        callFactoryFunction(
          fixture.base,
          "saveModelSettings",
          [{ version: 0, planningModelId: modelId, buildModelId: modelId }],
          { cookie: adminCookie },
        ),
      );
      async function publishSkill(content: SkillContent, expectedRevision = 0) {
        return skillRevisionInput.parse(
          await serverCall(
            callFactoryFunction(
              fixture.base,
              "publishSkill",
              [
                {
                  revisionId: crypto.randomUUID(),
                  expectedRevision,
                  content,
                },
              ],
              { cookie: adminCookie },
            ),
          ),
        );
      }
      const planningSkill = await publishSkill(requirementsInterviewSkill);
      const approvedBuildSkill = await publishSkill(buildSkill);
      planningSkillID = planningSkill.id;
      buildSkillID = approvedBuildSkill.id;
      const systemSkills = systemSkillSettingsView.parse(
        await serverCall(
          callFactoryFunction(
            fixture.base,
            "saveSystemSkills",
            [
              {
                version: 0,
                planning: { required: [planningSkillID], optional: [], selected: [] },
                build: { required: [], optional: [buildSkillID], selected: [] },
              },
            ],
            { cookie: adminCookie },
          ),
        ),
      );
      baseSHA = (await forge.getDefaultBranch(repository)).headSha;
      await database.client`INSERT INTO factory.project(id, slug, name, repository_url, default_branch, devcontainer_path, created_by)
        VALUES (${projectID}, ${slug}, 'Owned team Delivery', 'http://127.0.0.1:33030/factory-mutation/runtime-fixture.git', 'main', '.devcontainer/devcontainer.json', ${administrator})`;
      const manager = await account("project-manager");
      const developer = await account("developer");
      const outsider = await account("non-member");
      await serverCall(
        callFactoryFunction(
          fixture.base,
          "saveProjectMember",
          [
            projectID,
            {
              email: manager.email,
              role: "developer",
              manageProject: true,
            },
          ],
          { cookie: adminCookie },
        ),
      );
      await serverCall(
        callFactoryFunction(
          fixture.base,
          "saveProjectMember",
          [
            projectID,
            {
              email: developer.email,
              role: "developer",
            },
          ],
          { cookie: manager.cookie },
        ),
      );
      const configured = inheritedModelSettingsView.parse(
        await serverCall(
          callFactoryFunction(
            fixture.base,
            "saveProjectModels",
            [
              projectID,
              {
                version: 0,
                planning: { modelId, models: [modelId], allowOverride: true },
                build: { modelId, models: [modelId], allowOverride: true },
              },
            ],
            { cookie: manager.cookie },
          ),
        ),
      );
      expect(configured.projectEffective.planning.source).toBe("project");
      const personal = inheritedModelSettingsView.parse(
        await serverCall(
          callFactoryFunction(
            fixture.base,
            "savePersonalModels",
            [
              projectID,
              {
                version: 0,
                planningModelId: null,
                buildModelId: modelId,
              },
            ],
            { cookie: developer.cookie },
          ),
        ),
      );
      expect(personal.effective.planning.source).toBe("project");
      expect(personal.effective.build.source).toBe("personal");
      const assignedSkills = inheritedSkillSettingsView.parse(
        await serverCall(
          callFactoryFunction(
            fixture.base,
            "saveProjectSkills",
            [
              projectID,
              {
                version: 0,
                planning: { required: [], optional: null, selected: null },
                build: { required: [buildSkillID], optional: [], selected: [] },
              },
            ],
            { cookie: manager.cookie },
          ),
        ),
      );
      expect(assignedSkills.projectEffective.planning.required).toEqual([
        { revisionId: planningSkillID, source: "system" },
      ]);
      expect(assignedSkills.projectEffective.build.required).toEqual([
        { revisionId: buildSkillID, source: "project" },
      ]);
      expect(
        await callFactoryFunction(fixture.base, "getInheritedSkills", [projectID], {
          cookie: outsider.cookie,
        }),
      ).toMatchObject({ ok: false, status: 404 });
      expect(
        await callFactoryFunction(fixture.base, "getProjectModels", [projectID], {
          cookie: outsider.cookie,
        }),
      ).toMatchObject({ ok: false, status: 404 });
      expect(
        await callFactoryFunction(fixture.base, "getModelSettings", [], {
          cookie: developer.cookie,
        }),
      ).toMatchObject({ ok: false, status: 403 });
      const list = z
        .object({ projects: z.array(z.object({ id: z.uuid() })) })
        .parse(
          await serverCall(
            callFactoryFunction(fixture.base, "getProjects", [], { cookie: outsider.cookie }),
          ),
        );
      expect(list.projects).toEqual([]);
      console.info(
        "Team Delivery: manager configured Project; developer and non-member access checked",
      );
      await serverCall(
        callFactoryFunction(
          fixture.base,
          "ensureStaging",
          [projectID],
          { cookie: developer.cookie, origin: fixture.base, "content-type": "application/json" },
          AbortSignal.timeout(90_000),
        ),
      );
      await serverCall(
        callFactoryFunction(
          fixture.base,
          "setConversationMode",
          [
            projectID,
            {
              mode: "plan",
            },
          ],
          { cookie: developer.cookie, origin: fixture.base, "content-type": "application/json" },
          AbortSignal.timeout(90_000),
        ),
      );
      const planCommandID = crypto.randomUUID();
      const source = await forge.getFile(repository, "src/server.mjs", baseSHA);
      await conversationCommand(
        fixture.base,
        projectID,
        {
          commandId: planCommandID,
          text: `All requirements are known. Propose one complete Requirement now, without an interview. The only change is to set src/version.txt to exactly ${slug} followed by a newline. Run node --check src/server.mjs. Keep the application intact. Non-goals: dependencies, runtime configuration and any other file changes. Existing src/server.mjs at ${baseSHA}:\n${source}`,
        },
        { cookie: developer.cookie },
      );
      const [planning] = await database.client<
        Array<{ id: string; state: string; model: string; userID: string; skills: string[] }>
      >`
        SELECT id, state, authority->>'modelId' AS model, input->>'createdBy' AS "userID", authority->'skillRevisionIds' AS skills FROM factory.agent_turn WHERE command_id = ${planCommandID}
      `;
      expect(planning).toMatchObject({
        state: "completed",
        model: modelId,
        userID: developer.id,
        skills: [planningSkillID],
      });
      expect(observations.some((entry) => entry.model === modelId && entry.planning)).toBe(true);
      const planningLoaded = await database.client<
        Array<{ revisionId: string }>
      >`SELECT revision_id AS "revisionId" FROM factory.agent_turn_skill WHERE turn_id = ${planning?.id ?? "00000000-0000-0000-0000-000000000000"}`;
      expect([...planningLoaded]).toEqual([{ revisionId: planningSkillID }]);
      const [requirement] = await database.client<
        Array<{ id: string; ticketID: string; createdBy: string }>
      >`
        SELECT revision.id, revision.ticket_id AS "ticketID", revision.created_by AS "createdBy"
        FROM factory.requirement_revision revision JOIN factory.ticket ticket ON ticket.id = revision.ticket_id
        WHERE ticket.project_id = ${projectID} ORDER BY revision.ordinal DESC LIMIT 1
      `;
      if (!requirement)
        throw new Error("Real Plan did not propose the fully specified Requirement");
      expect(requirement.createdBy).toBe(developer.id);
      console.info("Team Delivery: real Plan created the developer's Requirement Revision");
      expect(
        await callFactoryFunction(fixture.base, "getTicketDetail", [requirement.ticketID], {
          cookie: outsider.cookie,
        }),
      ).toMatchObject({ ok: false, status: 404 });
      await serverCall(
        callFactoryFunction(
          fixture.base,
          "approveRequirementRevision",
          [requirement.ticketID, requirement.id],
          { cookie: developer.cookie, origin: fixture.base, "content-type": "application/json" },
          AbortSignal.timeout(90_000),
        ),
      );
      const zero = zeroDrizzle(zeroSchema, database.db);
      const ctx = { userId: developer.id, systemManager: false };
      const rootEpicID = crypto.randomUUID();
      const childEpicID = crypto.randomUUID();
      const nextTicketID = crypto.randomUUID();
      await zero.transaction(async (tx) => {
        await zeroServerMutators.epics.create.fn({
          tx,
          ctx,
          args: {
            id: rootEpicID,
            projectId: projectID,
            title: "Release",
            description: "",
            parentId: null,
          },
        });
        await zeroServerMutators.epics.create.fn({
          tx,
          ctx,
          args: {
            id: childEpicID,
            projectId: projectID,
            title: "Version contract",
            description: "",
            parentId: rootEpicID,
          },
        });
        const [ticket] = await database.client<
          Array<{ version: number }>
        >`SELECT version::float8 AS version FROM factory.ticket WHERE id = ${requirement.ticketID}`;
        if (!ticket) throw new Error("Owned first Ticket missing");
        await zeroServerMutators.tickets.assignEpic.fn({
          tx,
          ctx,
          args: {
            projectId: projectID,
            ticketId: requirement.ticketID,
            epicId: childEpicID,
            expectedVersion: ticket.version,
          },
        });
        await zeroServerMutators.tickets.create.fn({
          tx,
          ctx,
          args: {
            id: nextTicketID,
            projectId: projectID,
            title: "Follow-on version after Delivery",
            description: "Use the delivered first version as the implementation base.",
          },
        });
        await zeroServerMutators.tickets.assignEpic.fn({
          tx,
          ctx,
          args: {
            projectId: projectID,
            ticketId: nextTicketID,
            epicId: rootEpicID,
            expectedVersion: 1,
          },
        });
        await zeroServerMutators.dependencies.add.fn({
          tx,
          ctx,
          args: {
            projectId: projectID,
            ticketId: nextTicketID,
            prerequisiteId: requirement.ticketID,
            expectedVersion: 2,
          },
        });
      });
      expect(
        (await zero.run(zeroQueries.epics.list.fn({ args: { projectId: projectID }, ctx }))).find(
          (epic) => epic.id === childEpicID,
        )?.parentId,
      ).toBe(rootEpicID);
      expect(
        await zero.run(
          zeroQueries.dependencies.list.fn({
            args: { projectId: projectID },
            ctx: { userId: outsider.id, systemManager: false },
          }),
        ),
      ).toEqual([]);
      const nextRevision = z.object({ id: z.uuid() }).parse(
        await serverCall(
          callFactoryFunction(
            fixture.base,
            "createRequirementRevision",
            [
              nextTicketID,
              {
                summary: `Set src/version.txt to exactly ${slug}-follow-on followed by a newline. Run node --check src/server.mjs. Keep the application intact.`,
                acceptanceCriteria: [
                  `src/version.txt contains ${slug}-follow-on with a newline`,
                  "node --check src/server.mjs passes",
                ],
                nonGoals: ["Dependencies, runtime configuration and any other file changes"],
              },
            ],
            { cookie: developer.cookie, origin: fixture.base, "content-type": "application/json" },
            AbortSignal.timeout(90_000),
          ),
        ),
      );
      await serverCall(
        callFactoryFunction(
          fixture.base,
          "approveRequirementRevision",
          [nextTicketID, nextRevision.id],
          { cookie: developer.cookie, origin: fixture.base, "content-type": "application/json" },
          AbortSignal.timeout(90_000),
        ),
      );
      const blocked = await callFactoryFunction(
        fixture.base,
        "startTicketChange",
        [nextTicketID],
        { cookie: developer.cookie, origin: fixture.base, "content-type": "application/json" },
        AbortSignal.timeout(90_000),
      );
      expect(blocked).toMatchObject({ ok: false, status: 409 });
      if (blocked.ok) throw new Error("Dependent Ticket was unexpectedly admitted");
      expect(blocked.message).toContain("Prerequisites must be delivered");
      expect(
        await database.client`SELECT id FROM factory.change WHERE ticket_id = ${nextTicketID}`,
      ).toHaveLength(0);
      dependencyProof = {
        ticketID: nextTicketID,
        rootEpicID,
        childEpicID,
        blockedStatus: blocked.status,
      };
      console.info(
        "Team Delivery: parent/child Epics and prerequisite recorded; second Change is blocked",
      );
      await serverCall(
        callFactoryFunction(
          fixture.base,
          "setConversationMode",
          [
            projectID,
            {
              mode: "build",
              ticketId: requirement.ticketID,
            },
          ],
          { cookie: developer.cookie, origin: fixture.base, "content-type": "application/json" },
          AbortSignal.timeout(90_000),
        ),
      );
      const readChange = async () => {
        const [row] = await database.client<
          Array<{
            id: string;
            branch: string;
            state: string;
            attemptID: string | null;
            runtimeState: string | null;
          }>
        >`
          SELECT change.id, change.branch_name AS branch, change.state, change.runtime_attempt_id AS "attemptID", attempt.state AS "runtimeState"
          FROM factory.change change LEFT JOIN factory.runtime_attempt attempt ON attempt.id = change.runtime_attempt_id WHERE change.ticket_id = ${requirement.ticketID}
        `;
        if (row?.state === "failed" || row?.runtimeState === "failed")
          throw new Error("Owned Change or Workspace failed before Build");
        return row;
      };
      const active = await eventually(
        readChange,
        (row) => row?.state === "active",
        "Change branch did not become active",
        60_000,
      );
      if (!active) throw new Error("Owned active Change missing");
      changeID = active.id;
      branch = active.branch;
      await serverCall(
        callFactoryFunction(
          fixture.base,
          "startTicketWorkspace",
          [active.id],
          { cookie: developer.cookie, origin: fixture.base, "content-type": "application/json" },
          AbortSignal.timeout(180_000),
        ),
      );
      const change = await eventually(
        readChange,
        (row) => row?.state === "active" && row.runtimeState === "ready",
        "Ticket Workspace did not become ready",
        300_000,
      );
      if (!change?.attemptID) throw new Error("Owned Change runtime missing");
      const admittedChangeID = change.id;
      changeID = change.id;
      branch = change.branch;
      const [workspace] = await database.client<Array<{ id: string }>>`
        SELECT id FROM factory.development_workspace WHERE change_id=${change.id}`;
      if (!workspace) throw new Error("Owned shared source Workspace missing");
      const initialSource = z.object({ content: z.string(), version: z.string() }).parse(
        await (
          await command(`/api/workspaces/${workspace.id}/source/read`, developer.cookie, {
            path: "src/version.txt",
          })
        ).json(),
      );
      await command(`/api/workspaces/${workspace.id}/source/write`, developer.cookie, {
        path: "src/version.txt",
        version: initialSource.version,
        content: Buffer.from(`human-before-agent-${slug}\n`).toString("base64"),
      });
      console.info("Team Delivery: shared Ticket Workspace ready; starting the developer's Build");
      expect(
        await callFactoryFunction(fixture.base, "getAgentView", [changeID], {
          cookie: outsider.cookie,
        }),
      ).toMatchObject({ ok: false, status: 404 });
      expect(
        (
          await request(
            `/api/runtime-access?path=${encodeURIComponent(`/runtime/${change.attemptID}/ide/`)}`,
            outsider.cookie,
          )
        ).status,
      ).toBe(404);
      const buildCommandID = crypto.randomUUID();
      await serverCall(
        callFactoryFunction(
          fixture.base,
          "startCoding",
          [
            changeID,
            {
              commandId: buildCommandID,
            },
          ],
          { cookie: developer.cookie, origin: fixture.base, "content-type": "application/json" },
          AbortSignal.timeout(90_000),
        ),
      );
      const [admitted] = await database.client<
        Array<{ id: string; model: string; userID: string; skills: string[] }>
      >`
        SELECT id, authority->>'modelId' AS model, input->>'createdBy' AS "userID", authority->'skillRevisionIds' AS skills FROM factory.agent_turn WHERE command_id = ${buildCommandID}
      `;
      expect(admitted).toMatchObject({
        model: modelId,
        userID: developer.id,
        skills: [buildSkillID],
      });
      const replacement = await publishSkill(
        { ...buildSkill, instructions: "Replacement content must not reach this admitted Build" },
        1,
      );
      await serverCall(
        callFactoryFunction(
          fixture.base,
          "saveSystemSkills",
          [
            {
              ...systemSkills.settings,
              build: { required: [], optional: [replacement.id], selected: [] },
            },
          ],
          { cookie: adminCookie },
        ),
      );
      await serverCall(
        callFactoryFunction(fixture.base, "setSkillPublication", [buildSkillID, false], {
          cookie: adminCookie,
        }),
      );
      await serverCall(
        callFactoryFunction(
          fixture.base,
          "saveProjectModels",
          [
            projectID,
            { ...configured.project, build: { modelId, models: [modelId], allowOverride: false } },
          ],
          { cookie: manager.cookie },
        ),
      );
      const [stillAdmitted] = await database.client<Array<{ model: string }>>`
        SELECT authority->>'modelId' AS model FROM factory.agent_turn WHERE command_id = ${buildCommandID}
      `;
      expect(stillAdmitted?.model).toBe(modelId);
      let observedBuildState = "";
      const verification = await eventually(
        async () => {
          const [row] = await database.client<
            Array<{
              id: string;
              state: string;
              sha: string;
              runtimeRevision: string;
              userID: string;
              attemptID: string;
              runtimeState: string;
            }>
          >`
          SELECT verification.id, verification.state, verification.commit_sha AS sha, attempt.id AS "attemptID", attempt.state AS "runtimeState", attempt.revision AS "runtimeRevision", change.created_by AS "userID"
          FROM factory.verification verification JOIN factory.runtime_attempt attempt ON attempt.id = verification.runtime_attempt_id
          JOIN factory.change change ON change.id = verification.change_id
          WHERE verification.change_id = ${admittedChangeID} ORDER BY verification.created_at DESC LIMIT 1
        `;
          const [turn] = await database.client<Array<{ state: string }>>`
            SELECT state FROM factory.agent_turn WHERE command_id=${buildCommandID}`;
          const state = `Build ${turn?.state ?? "absent"}; Verification ${row?.state ?? "not started"}`;
          if (state !== observedBuildState) {
            console.info(`Team Delivery: ${state}`);
            observedBuildState = state;
          }
          if (["failed", "stopped"].includes(turn?.state ?? ""))
            throw new Error("Owned real Build ended without successful Verification");
          if (
            row?.state === "failed" ||
            ["failed", "cleanup-failed"].includes(row?.runtimeState ?? "")
          )
            throw new Error("Owned exact Verification failed");
          return row;
        },
        (row) => row?.state === "succeeded",
        "Real Build did not reach exact successful Verification",
        480_000,
      );
      if (!verification) throw new Error("Owned Verification missing");
      const verificationSlot = (await reserveSlots()).find(
        (slot) => slot.assignedAttemptID === verification.attemptID,
      );
      expect(verificationSlot).toMatchObject({
        role: "verification",
        assignedAttemptID: verification.attemptID,
      });
      expect(verificationSlot?.podUID).toBeTruthy();
      expect(verificationSlot?.claimUID).toBeTruthy();
      const exactSHA = verification.sha;
      verifiedSHA = exactSHA;
      const agentSource = z.object({ content: z.string() }).parse(
        await (
          await command(`/api/workspaces/${workspace.id}/source/read`, developer.cookie, {
            path: "src/version.txt",
          })
        ).json(),
      );
      expect(Buffer.from(agentSource.content, "base64").toString()).toBe(`${slug}\n`);
      console.info("Team Delivery: real Build passed exact-commit Verification");
      const buildLoaded = await database.client<
        Array<{ revisionId: string }>
      >`SELECT revision_id AS "revisionId" FROM factory.agent_turn_skill WHERE turn_id = ${admitted?.id ?? "00000000-0000-0000-0000-000000000000"}`;
      expect([...buildLoaded]).toEqual([{ revisionId: buildSkillID }]);
      expect(observations.some((entry) => entry.model === modelId && entry.build)).toBe(true);
      expect(observations.some((entry) => entry.replacement)).toBe(false);
      const changeTurns = await database.client<
        Array<{ skills: string[] }>
      >`SELECT authority->'skillRevisionIds' AS skills FROM factory.agent_turn WHERE change_id = ${admittedChangeID} AND authority->>'mode' = 'build'`;
      expect(changeTurns.length).toBeGreaterThan(0);
      expect(
        changeTurns.every((turn) => JSON.stringify(turn.skills) === JSON.stringify([buildSkillID])),
      ).toBe(true);
      expect(verification.runtimeRevision).toBe(verifiedSHA);
      expect(verification.userID).toBe(developer.id);
      expect((await forge.getBranch(repository, branch))?.headSha).toBe(verifiedSHA);
      expect(
        await callFactoryFunction(
          fixture.base,
          "startTicketChange",
          [nextTicketID],
          { cookie: developer.cookie, origin: fixture.base, "content-type": "application/json" },
          AbortSignal.timeout(90_000),
        ),
      ).toMatchObject({ ok: false, status: 409 });
      const initial = await eventually(
        staging,
        (row) => row?.state === "ready",
        "Initial Staging did not become ready",
        300_000,
      );
      expect(initial?.revision).toBe(baseSHA);
      await serverCall(
        callFactoryFunction(fixture.base, "approveDelivery", [changeID], {
          cookie: developer.cookie,
        }),
      );
      const promoted = await eventually(
        async () => {
          const [row] = await database.client<
            Array<{ state: string }>
          >`SELECT state FROM factory.change WHERE id = ${admittedChangeID}`;
          return row?.state === "delivered" ? staging() : undefined;
        },
        (row) => row?.state === "ready" && row.revision === exactSHA,
        "Approved version did not reach healthy Preview",
        360_000,
      );
      if (!promoted) throw new Error("Owned promoted Preview missing");
      const [approval] = await database.client<Array<{ human: string; sha: string }>>`
        SELECT approved_by AS human, commit_sha AS sha FROM factory.delivery_approval WHERE change_id = ${changeID}
      `;
      expect(approval).toEqual({ human: developer.id, sha: exactSHA });
      expect((await forge.getDefaultBranch(repository)).headSha).toBe(exactSHA);
      const grant = await request(
        `/api/runtime-access?path=${encodeURIComponent(`/runtime/${promoted.id}/app/`)}`,
        developer.cookie,
      );
      expect(grant.status).toBe(302);
      const location = new URL(grant.headers.get("location") ?? "");
      const redeemed = await fetch(`${fixture.base}${location.pathname}${location.search}`, {
        redirect: "manual",
      });
      expect(redeemed.status).toBe(302);
      const accessCookie = redeemed.headers
        .getSetCookie()
        .map((item) => item.split(";")[0])
        .join("; ");
      const preview = await request(`/runtime/${promoted.id}/app/source`, accessCookie);
      expect(preview.status).toBe(200);
      expect(await preview.json()).toMatchObject({ version: slug });
      console.info(
        "Team Delivery: developer approval merged the verified commit; Preview serves its version",
      );
      expect(
        (
          await request(
            `/api/runtime-access?path=${encodeURIComponent(`/runtime/${promoted.id}/app/`)}`,
            outsider.cookie,
          )
        ).status,
      ).toBe(404);
      const pull = await forge.getPullRequest(repository, "main", branch);
      await serverCall(
        callFactoryFunction(fixture.base, "setSkillPublication", [buildSkillID, true], {
          cookie: adminCookie,
        }),
      );
      const nextSkills = inheritedSkillSettingsView.parse(
        await serverCall(
          callFactoryFunction(fixture.base, "getInheritedSkills", [projectID], {
            cookie: developer.cookie,
          }),
        ),
      );
      // Republishing does not restore the permission removed after the first admission.
      expect(nextSkills.effective.build).toMatchObject({
        required: [],
        selected: [],
        available: true,
      });
      expect(nextSkills.effective.build.ignoredReason).not.toBeNull();
      await serverCall(
        callFactoryFunction(
          fixture.base,
          "setConversationMode",
          [
            projectID,
            {
              mode: "build",
              ticketId: nextTicketID,
            },
          ],
          { cookie: developer.cookie, origin: fixture.base, "content-type": "application/json" },
          AbortSignal.timeout(90_000),
        ),
      );
      const nextChange = await eventually(
        async () => {
          const [row] = await database.client<
            Array<{ id: string; state: string; baseSha: string; branchName: string }>
          >`
          SELECT id, state, base_sha AS "baseSha", branch_name AS "branchName" FROM factory.change WHERE ticket_id = ${nextTicketID}`;
          if (row?.state === "failed") throw new Error("Dependent Change failed before Build");
          return row;
        },
        (row) => row?.state === "active",
        "Delivered prerequisite did not unlock the dependent Change",
        60_000,
      );
      if (!nextChange) throw new Error("Owned dependent Change missing");
      expect(nextChange.baseSha).toBe(exactSHA);
      dependencyProof.nextChange = nextChange;
      await serverCall(
        callFactoryFunction(
          fixture.base,
          "startTicketWorkspace",
          [nextChange.id],
          { cookie: developer.cookie, origin: fixture.base, "content-type": "application/json" },
          AbortSignal.timeout(180_000),
        ),
      );
      await eventually(
        async () => {
          const [row] = await database.client<
            Array<{ state: string }>
          >`SELECT attempt.state FROM factory.change change
          JOIN factory.runtime_attempt attempt ON attempt.id = change.runtime_attempt_id WHERE change.id = ${nextChange.id}`;
          if (row?.state === "failed")
            throw new Error("Dependent Ticket Workspace failed before Build");
          return row;
        },
        (row) => row?.state === "ready",
        "Dependent Ticket Workspace did not become ready",
        300_000,
      );
      const nextBuildCommandID = crypto.randomUUID();
      await serverCall(
        callFactoryFunction(
          fixture.base,
          "startCoding",
          [
            nextChange.id,
            {
              commandId: nextBuildCommandID,
            },
          ],
          { cookie: developer.cookie, origin: fixture.base, "content-type": "application/json" },
          AbortSignal.timeout(90_000),
        ),
      );
      const nextBuild = await eventually(
        async () => {
          const [turn] = await database.client<Array<{ state: string }>>`
            SELECT state FROM factory.agent_turn WHERE command_id=${nextBuildCommandID}`;
          if (["failed", "stopped"].includes(turn?.state ?? ""))
            throw new Error("Owned dependent Build ended without its exact commit");
          const [row] = await database.client<
            Array<{ id: string; state: string; model: string; skills: string[]; commitSHA: string }>
          >`
          SELECT turn.id, turn.state, authority->>'modelId' AS model, authority->'skillRevisionIds' AS skills, commit.commit_sha AS "commitSHA"
          FROM factory.agent_turn turn JOIN factory.change_commit_operation commit ON commit.id = turn.id
          WHERE turn.command_id = ${nextBuildCommandID} AND commit.state = 'succeeded'`;
          return row;
        },
        (row) => row?.state === "completed",
        "Real dependent Build did not commit its follow-on implementation",
        480_000,
      );
      if (!nextBuild) throw new Error("Owned dependent Build missing");
      dependencyProof.nextBuild = nextBuild;
      expect(nextBuild).toMatchObject({
        model: modelId,
        skills: [],
        state: "completed",
      });
      expect(
        await database.client`SELECT revision_id FROM factory.agent_turn_skill WHERE turn_id = ${nextBuild.id}`,
      ).toHaveLength(0);
      expect((await forge.getDefaultBranch(repository)).headSha).toBe(exactSHA);
      expect(await forge.getFile(repository, "src/version.txt", nextBuild.commitSHA)).toBe(
        `${slug}-follow-on\n`,
      );
      console.info(
        "Team Delivery: first delivered base unlocked a real second OpenCode Build and exact follow-on commit",
      );
      await writeFile(
        `${directory}/delivered.json`,
        `${JSON.stringify({ projectID, changeID, requirement, planning, admitted, planningLoaded, buildLoaded, providerObservations: observations, verification, verificationSlot, approval, initial, promoted, dependencyProof, pullRequestURL: pull?.url, previewVersion: slug }, null, 2)}\n`,
      );
    } catch (cause) {
      const attempts =
        await database.client`SELECT id, state, isolated_kind, failure FROM factory.runtime_attempt WHERE project_id = ${projectID}`;
      const turns =
        await database.client`SELECT id, state, authority, outcome_summary FROM factory.agent_turn WHERE project_id = ${projectID}`;
      await writeFile(
        `${directory}/failure.json`,
        `${JSON.stringify({ error: cause instanceof Error ? cause.message : "Unknown failure", attempts, turns, reserve: await reserveSlots() }, null, 2)}\n`,
      );
      throw cause;
    } finally {
      await reserve.close();
      try {
        const cleanOwnedResources = async () => {
          if (adminCookie) {
            const changes = await database.client<
              Array<{ id: string; state: string; branch: string; baseSHA: string }>
            >`
              SELECT id, state, branch_name AS branch, base_sha AS "baseSHA" FROM factory.change WHERE project_id = ${projectID}`;
            for (const change of changes) {
              if (change.state !== "delivered") {
                await serverCall(
                  callFactoryFunction(
                    fixture.base,
                    "stopCoding",
                    [change.id],
                    {
                      cookie: adminCookie,
                      origin: fixture.base,
                      "content-type": "application/json",
                    },
                    AbortSignal.timeout(90_000),
                  ),
                );
                await serverCall(
                  callFactoryFunction(
                    fixture.base,
                    "cancelChange",
                    [change.id],
                    {
                      cookie: adminCookie,
                      origin: fixture.base,
                      "content-type": "application/json",
                    },
                    AbortSignal.timeout(90_000),
                  ),
                );
              }
            }
            await eventually(
              async () => {
                const attempts = await database.client<
                  Array<{ id: string }>
                >`SELECT id FROM factory.runtime_attempt WHERE project_id = ${projectID} AND state <> 'stopped'`;
                for (const attempt of attempts)
                  await serverCall(
                    callFactoryFunction(
                      fixture.base,
                      "stopRuntimeAttempt",
                      [attempt.id],
                      {
                        cookie: adminCookie,
                        origin: fixture.base,
                        "content-type": "application/json",
                      },
                      AbortSignal.timeout(90_000),
                    ),
                  );
                if (attempts.length) return attempts.length;
                await removeOwnedProjectSources(database, projectID, (workspaceID) =>
                  serverCall(
                    callFactoryFunction(fixture.base, "stopWorkspaceSource", [workspaceID], {
                      cookie: adminCookie,
                    }),
                  ),
                );
                const kubernetes = Bun.spawn(
                  [
                    "kubectl",
                    "--context",
                    "orbstack",
                    "get",
                    "namespaces",
                    "-l",
                    `factory.dev/project=${projectID}`,
                    "-o",
                    "json",
                  ],
                  { stdout: "pipe", stderr: "pipe" },
                );
                const [output, error, status] = await Promise.all([
                  new Response(kubernetes.stdout).text(),
                  new Response(kubernetes.stderr).text(),
                  kubernetes.exited,
                ]);
                if (status !== 0)
                  throw new Error(`Cannot confirm owned namespace cleanup: ${error.slice(0, 200)}`);
                return (
                  attempts.length +
                  z.object({ items: z.array(z.unknown()) }).parse(JSON.parse(output)).items.length
                );
              },
              (count) => count === 0,
              "Owned team resources did not stop",
              180_000,
            );
            for (const change of changes) {
              const pull = await forge.getPullRequest(repository, "main", change.branch);
              if (pull && !pull.merged && pull.state === "open") {
                const [commit] = await database.client<
                  Array<{ sha: string }>
                >`SELECT commit_sha AS sha FROM factory.change_commit_operation WHERE change_id = ${change.id} AND state = 'succeeded' ORDER BY sequence DESC LIMIT 1`;
                if (pull.headSha !== commit?.sha)
                  throw new Error("Owned PR cleanup refused unexpected head");
                const response = await fetch(
                  `http://127.0.0.1:33030/api/v1/repos/${repository.owner}/${repository.name}/pulls/${pull.number}`,
                  {
                    method: "PATCH",
                    headers: {
                      authorization: `token ${forgejoToken}`,
                      "content-type": "application/json",
                    },
                    body: JSON.stringify({ state: "closed" }),
                  },
                );
                if (!response.ok) throw new Error("Owned PR could not be closed");
              }
              const remaining = await forge.getBranch(repository, change.branch);
              if (remaining) {
                const [commit] = await database.client<
                  Array<{ sha: string }>
                >`SELECT commit_sha AS sha FROM factory.change_commit_operation WHERE change_id = ${change.id} AND state = 'succeeded' ORDER BY sequence DESC LIMIT 1`;
                if (![change.baseSHA, commit?.sha].includes(remaining.headSha))
                  throw new Error("Owned branch cleanup refused unexpected head");
                await forge.deleteBranch(repository, change.branch);
              }
            }
          }
          for (const slot of await reserveSlots()) {
            if (slot.state === "deleted") continue;
            if (slot.assignedAttemptID)
              throw new Error("Used execution slot was not removed with its Attempt");
            await reserveClient.retire(slot);
          }
          safeToDispose = true;
          await writeFile(
            `${directory}/cleanup.json`,
            `${JSON.stringify({ ownedRuntimesRemoved: true, ownedReserveRemoved: true, ownedBranchRemoved: true, unrelatedRuntimesUntouched: true })}\n`,
          );
        };
        await cleanOwnedResources();
      } finally {
        await database.client.end();
        try {
          if (safeToDispose) await fixture.dispose();
          else await fixture.shutdown();
        } finally {
          await provider.stop(true);
        }
      }
    }
  },
  1_500_000,
);
