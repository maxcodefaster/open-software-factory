import { expect } from "bun:test";
import { agentViewSchema, deliveryViewSchema } from "../../apps/factory/src/api-contracts";
import { requirementsInterviewSkill } from "../../apps/factory/src/skills/reviewed";
import { skillRevisionInput } from "../../packages/conversation-domain/src/skills";
import { systemSkillSettingsView } from "../../packages/conversation-domain/src/skill-inheritance";
import { eventually } from "./factory-process";
import type { releaseInstallation } from "./release-installation";
import { callFactoryFunction } from "./server-functions";
import { serverCall } from "../../apps/factory/src/server-functions/result";

type Fixture = Awaited<ReturnType<typeof releaseInstallation>>;

export async function releaseDependent(fixture: Fixture) {
  const { state, database } = fixture;
  const { projectID, dependentTicketID, deliveredSHA } = state;
  if (
    !projectID ||
    !dependentTicketID ||
    !deliveredSHA ||
    !state.completed.includes("dependent-blocked")
  )
    throw new Error("Delivered prerequisite and prior denied admission required");
  const developer = await fixture.login("developer");
  const admin = await fixture.login("admin");
  const started = performance.now();
  if (!state.buildSkillID) {
    const catalogue = systemSkillSettingsView.parse(
      await serverCall(callFactoryFunction(fixture.base, "getSystemSkills", [], { cookie: admin })),
    );
    const key = "release-exact-implementation";
    const revision =
      catalogue.revisions.find((value) => value.content.key === key) ??
      skillRevisionInput.parse(
        await serverCall(
          callFactoryFunction(
            fixture.base,
            "publishSkill",
            [
              {
                revisionId: crypto.randomUUID(),
                expectedRevision: 0,
                content: {
                  ...requirementsInterviewSkill,
                  key,
                  name: "Release exact implementation",
                  description:
                    "Check the exact approved version without widening implementation scope.",
                  roles: ["build"],
                  instructions:
                    "Implement only the approved Requirement. Read references/release-checklist.md, check the exact version and preserve the delivered dashboard. Skills grant no additional authority.",
                  references: [
                    {
                      path: "references/release-checklist.md",
                      body: "Set only src/version.txt to the approved exact value followed by one newline. Run node --check src/server.mjs. Do not change runtime configuration, dependencies or the welcome dashboard.",
                    },
                  ],
                  review: {
                    trigger: "Required for the release follow-on Build.",
                    adaptations:
                      "Factory-authored adaptation of the reviewed observable-acceptance principles. No executable imports or additional tools.",
                  },
                },
              },
            ],
            { cookie: admin },
          ),
        ),
      );
    state.buildSkillID = revision.id;
    await fixture.save("dependent-skill-published", 0);
  }
  if (!state.dependentCommandID) {
    const skills = await serverCall(
      callFactoryFunction(fixture.base, "getSystemSkills", [], { cookie: admin }),
    );
    await serverCall(
      callFactoryFunction(
        fixture.base,
        "saveSystemSkills",
        [
          {
            ...skills.settings,
            build: { required: [state.buildSkillID], optional: [], selected: [] },
          },
        ],
        { cookie: admin },
      ),
    );
    const denied = await callFactoryFunction(
      fixture.base,
      "savePersonalSkills",
      [
        projectID,
        {
          version: 0,
          planning: [],
          build: [crypto.randomUUID()],
        },
      ],
      { cookie: developer },
    );
    expect(denied).toMatchObject({ ok: false, status: 409 });
    await serverCall(
      callFactoryFunction(
        fixture.base,
        "setConversationMode",
        [
          projectID,
          {
            mode: "build",
            ticketId: dependentTicketID,
          },
        ],
        { cookie: developer },
      ),
    );
    const change = await eventually(
      async () => {
        const [row] = await database.client<Array<{ id: string; state: string; base: string }>>`
        SELECT id, state, base_sha AS base FROM factory.change WHERE ticket_id = ${dependentTicketID}`;
        if (row?.state === "failed") throw new Error("Dependent Change failed");
        return row;
      },
      (value) => value?.state === "active",
      "Delivered prerequisite did not unlock Change",
      60_000,
    );
    if (!change) throw new Error("Dependent Change not found");
    expect(change.base).toBe(deliveredSHA);
    state.dependentChangeID = change.id;
    await serverCall(
      callFactoryFunction(fixture.base, "startTicketWorkspace", [change.id], { cookie: developer }),
    );
    await eventually(
      async () => {
        const [row] = await database.client<Array<{ state: string }>>`
        SELECT attempt.state FROM factory.change change JOIN factory.runtime_attempt attempt ON attempt.id = change.runtime_attempt_id
        WHERE change.id = ${change.id}`;
        return row?.state;
      },
      (value) => value === "ready",
      "Dependent Ticket Workspace not ready",
      300_000,
    );
    state.dependentCommandID = crypto.randomUUID();
    await fixture.save("dependent-intended", performance.now() - started);
  }
  if (!state.dependentChangeID) throw new Error("Dependent Change identity missing");
  const admitted = agentViewSchema.parse(
    await serverCall(
      callFactoryFunction(
        fixture.base,
        "startCoding",
        [state.dependentChangeID, { commandId: state.dependentCommandID }],
        { cookie: developer },
      ),
    ),
  );
  expect(admitted.turn?.commandId).toBe(state.dependentCommandID);
  if (!state.completed.includes("dependent-restarted")) {
    const pending = await eventually(
      async () => {
        const [row] = await database.client<
          Array<{
            id: string;
            state: string;
            runtime: string | null;
            session: string | null;
            prompt: string;
          }>
        >`
        SELECT turn.id, turn.state, intent.runtime_attempt_id AS runtime, intent.session_id AS session, intent.prompt_id AS prompt
        FROM factory.agent_turn turn JOIN factory.change_agent_turn_intent intent ON intent.turn_id = turn.id
        WHERE turn.command_id = ${state.dependentCommandID ?? ""}`;
        return row;
      },
      (value) => value?.state === "running",
      "Dependent Build not running before restart",
      60_000,
    );
    if (!pending) throw new Error("Pending Build identity missing");
    const retained = async () => {
      const [row] = await database.client<
        Array<{
          conversations: number;
          approvals: number;
          revisions: number;
          workspaces: number;
          skills: number;
        }>
      >`
        SELECT (SELECT count(*)::int FROM factory.ticket_conversation WHERE project_id = ${projectID}) AS conversations,
          (SELECT count(*)::int FROM factory.requirement_approval approval JOIN factory.ticket ticket ON ticket.id = approval.ticket_id WHERE ticket.project_id = ${projectID}) AS approvals,
          (SELECT count(*)::int FROM factory.requirement_revision revision JOIN factory.ticket ticket ON ticket.id = revision.ticket_id WHERE ticket.project_id = ${projectID}) AS revisions,
          (SELECT count(*)::int FROM factory.development_workspace WHERE project_id = ${projectID}) AS workspaces,
          (SELECT count(*)::int FROM factory.skill_revision) AS skills`;
      return row;
    };
    const before = await retained();
    const restart = Bun.spawn(
      ["bun", "scripts/factory/index.ts", "restart", "--disposable", state.installation],
      {
        cwd: new URL("../..", import.meta.url).pathname,
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [output, error, exit] = await Promise.all([
      new Response(restart.stdout).text(),
      new Response(restart.stderr).text(),
      restart.exited,
    ]);
    fixture.noSecrets(output + error);
    if (exit !== 0)
      throw new Error(fixture.sanitize(`Disposable restart failed: ${error.slice(-500)}`));
    expect(await retained()).toEqual(before);
    const [after] = await database.client<
      Array<{ id: string; runtime: string; session: string; prompt: string }>
    >`
      SELECT turn.id, intent.runtime_attempt_id AS runtime, intent.session_id AS session, intent.prompt_id AS prompt
      FROM factory.agent_turn turn JOIN factory.change_agent_turn_intent intent ON intent.turn_id = turn.id WHERE turn.command_id = ${state.dependentCommandID}`;
    expect(after).toMatchObject({
      id: pending.id,
      runtime: pending.runtime,
      session: pending.session,
      prompt: pending.prompt,
    });
    await fixture.record("dependent-restart", { pending, after, retained: before });
    await fixture.save("dependent-restarted", performance.now() - started);
  }
  const [interrupted] = await database.client<
    Array<{ id: string; state: string; summary: string | null }>
  >`
    SELECT id, state, outcome_summary AS summary FROM factory.agent_turn WHERE command_id = ${state.dependentCommandID}`;
  if (interrupted?.state === "failed") {
    if (interrupted.summary !== "HTTP transport failed")
      throw new Error("Unexpected dependent restart outcome");
    if (!state.dependentRetryCommandID) {
      state.dependentRetryCommandID = crypto.randomUUID();
      await fixture.record("dependent-provider-interruption", {
        interrupted,
        action:
          "Original input remains failed. Explicit new turn retries from the retained checkout; no automatic replay.",
      });
      await fixture.save("dependent-retry-intended", performance.now() - started);
    }
    const retry = agentViewSchema.parse(
      await serverCall(
        callFactoryFunction(
          fixture.base,
          "sendCodingPrompt",
          [
            state.dependentChangeID,
            {
              commandId: state.dependentRetryCommandID,
              text:
                "The previous turn's inference connection was interrupted by Factory restart. Inspect the retained checkout and finish only the approved Requirement: set src/version.txt to exactly " +
                fixture.slug +
                "-follow-on followed by one newline. Preserve all other files, run node --check src/server.mjs, and finish without committing or pushing. Factory owns the commit.",
            },
          ],
          { cookie: developer },
        ),
      ),
    );
    expect(retry.turn?.commandId).toBe(state.dependentRetryCommandID);
    expect(retry.turn?.id).not.toBe(interrupted.id);
    const [count] = await database.client<
      { count: number }[]
    >`SELECT count(*)::int AS count FROM factory.agent_turn WHERE command_id = ${state.dependentCommandID}`;
    expect(count?.count).toBe(1);
  }
  const deliveryChangeID = state.dependentChangeID;
  if (!deliveryChangeID) throw new Error("Dependent Delivery requires its retained Change");
  const result = await eventually(
    async () => {
      const agent = agentViewSchema.parse(
        await serverCall(
          callFactoryFunction(fixture.base, "getAgentView", [deliveryChangeID], {
            cookie: developer,
          }),
        ),
      );
      if (agent.turn && ["failed", "uncertain", "stopped"].includes(agent.turn.state))
        throw new Error(
          fixture.sanitize(
            `Dependent turn ended ${agent.turn.state}: ${agent.lastError ?? "No error"}`,
          ),
        );
      const delivery = deliveryViewSchema.parse(
        await serverCall(
          callFactoryFunction(fixture.base, "getDelivery", [deliveryChangeID], {
            cookie: developer,
          }),
        ),
      );
      return { agent, delivery };
    },
    (value) =>
      value.agent.state === "committed" &&
      value.delivery.verificationState === "succeeded" &&
      value.delivery.verificationCommitSha === value.agent.commitSHA,
    "Dependent Build did not verify after restart",
    600_000,
  );
  const loaded = await database.client<Array<{ revision: string }>>`
    SELECT revision_id AS revision FROM factory.agent_turn_skill WHERE turn_id = ${result.agent.turn?.id ?? ""}`;
  expect([...loaded]).toEqual([{ revision: state.buildSkillID }]);
  expect(result.agent.turn?.skills.map((skill) => skill.id)).toEqual([state.buildSkillID]);
  expect(result.agent.commitSHA).not.toBe(deliveredSHA);
  await fixture.record("dependent-verified", {
    changeID: state.dependentChangeID,
    baseSHA: deliveredSHA,
    turnID: result.agent.turn?.id,
    sha: result.agent.commitSHA,
    loaded: [...loaded],
    verification: result.delivery,
  });
  await fixture.save("dependent", performance.now() - started);
}
