import { callFactoryFunction, decodeBrowserFunction } from "./server-functions";
import { serverCall, type ServerResult } from "../../apps/factory/src/server-functions/result";
import { expect } from "bun:test";
import { resolve } from "node:path";
import { expect as visible } from "@playwright/test";
import { z } from "zod";
import {
  agentViewSchema,
  changesResponseSchema,
  deliveryViewSchema,
  conversationViewSchema,
  type AgentView,
} from "../../apps/factory/src/api-contracts";
import type { releaseInstallation } from "./release-installation";

type Fixture = Awaited<ReturnType<typeof releaseInstallation>>;

export async function releaseInspection(fixture: Fixture) {
  const { state, database } = fixture;
  if (!state.changeID || !state.buildCommandID)
    throw new Error("Completed release implementation required before inspection");
  const inspectionChangeID = state.changeID;
  const cookie = await fixture.login("developer");
  if (!state.inspectionCommandID) {
    state.inspectionCommandID = crypto.randomUUID();
    await fixture.save("inspection-intended", 0);
  }
  const [prior] = await database.client<Array<{ state: string }>>`
    SELECT operation.state FROM factory.change_commit_operation operation JOIN factory.agent_turn turn ON turn.id = operation.id
    WHERE turn.command_id = ${state.inspectionCommandID}`;
  if (prior?.state === "failed" && !state.inspectionRetryCommandID) {
    state.inspectionRetryCommandID = crypto.randomUUID();
    await fixture.save("inspection-retry-intended", 0);
  }
  const commandID = state.inspectionRetryCommandID ?? state.inspectionCommandID;
  const accepted = agentViewSchema.parse(
    await serverCall(
      callFactoryFunction(
        fixture.base,
        "sendCodingPrompt",
        [
          state.changeID,
          {
            commandId: commandID,
            text: [
              "Complete the missing browser acceptance on the existing welcome dashboard. Do not reimplement it.",
              "Read .factory/system.json. Its primaryApp web is browser channel app, not web.",
              "Before editing, use browser_open app, browser_snapshot, browser_console and browser_screenshot. Read the returned JPEG with the native read tool. Stop and report an actionable failure if inspection is not confirmed.",
              "Inspect the existing repository test setup, then add one focused dependency-free regression for the approved accessible Continue control below the heading in normal flow and preserved /health and /source behavior. Correct only a defect actually found by inspection. Preserve runtime configuration and version.",
              "Run the regression and node --check src/server.mjs. After editing, reopen app and repeat DOM, console, screenshot and native JPEG read. Report actual observations with their returned App/checkout context. Do not commit or push.",
            ].join("\n"),
          },
        ],
        { cookie: cookie },
      ),
    ),
  );
  expect(accepted.turn?.commandId).toBe(commandID);
  const started = performance.now();
  await visible
    .poll(
      async () => {
        const [turn] = await database.client<Array<{ state: string; summary: string | null }>>`
        SELECT state, outcome_summary AS summary FROM factory.agent_turn
        WHERE command_id = ${commandID}`;
        if (turn && ["failed", "stopped", "needs-resolution"].includes(turn.state))
          throw new Error(
            fixture.sanitize(
              `Release inspection ended ${turn.state}: ${turn.summary ?? "Unknown"}`,
            ),
          );
        const delivery = deliveryViewSchema.parse(
          await serverCall(
            callFactoryFunction(fixture.base, "getDelivery", [inspectionChangeID], {
              cookie: cookie,
            }),
          ),
        );
        const [commit] = await database.client<Array<{ sha: string | null; state: string }>>`
        SELECT commit_sha AS sha, state FROM factory.change_commit_operation WHERE id = ${accepted.turn?.id ?? ""}`;
        return (
          turn?.state === "completed" &&
          commit?.state === "succeeded" &&
          delivery.verificationState === "succeeded" &&
          delivery.verificationCommitSha === commit.sha
        );
      },
      { timeout: 600_000, intervals: [1_000, 2_000, 3_000] },
    )
    .toBe(true);
  const agent = agentViewSchema.parse(
    await serverCall(
      callFactoryFunction(fixture.base, "getAgentView", [state.changeID], { cookie: cookie }),
    ),
  );
  const [intent] = await database.client<Array<{ prompt: string }>>`
    SELECT prompt_id AS prompt FROM factory.change_agent_turn_intent WHERE turn_id = ${accepted.turn?.id ?? ""}`;
  const boundary = agent.messages.find((message) => message.id === intent?.prompt);
  expect(boundary?.role).toBe("user");
  const reads = agent.messages.filter(
    (message) =>
      !!boundary &&
      message.at >= boundary.at &&
      message.activity?.status === "completed" &&
      message.text.startsWith("Read /tmp/factory-build-browser-") &&
      message.text.endsWith("/screenshot.jpg"),
  );
  expect(reads.length).toBeGreaterThanOrEqual(2);
  await fixture.record("inspection-result", {
    turnID: accepted.turn?.id,
    imageReads: reads.map(({ id, text }) => ({ id, text })),
  });
  await fixture.save("inspection", performance.now() - started);
}

export async function releaseBuild(fixture: Fixture) {
  const { state, database } = fixture;
  const { projectID, ticketID } = state;
  if (!projectID || !ticketID || !state.completed.includes("spec"))
    throw new Error("Release Spec must be approved before Build");
  const cookie = await fixture.login("developer");
  const page = await fixture.page("developer");
  await fixture.selectProject(page);
  await page
    .locator(".ticket-card-body")
    .filter({ hasText: `TCK-${ticketID.slice(0, 6).toUpperCase()}` })
    .click();
  await page.getByRole("button", { name: "Toggle Agent panel" }).click();
  const panel = page.getByRole("complementary", { name: "Agent panel" });
  await panel.getByRole("button", { name: "Build", exact: true }).click();
  await visible(panel.getByRole("button", { name: "Build", exact: true })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  const changes = changesResponseSchema.parse(
    await serverCall(
      callFactoryFunction(fixture.base, "getChanges", [projectID], { cookie: cookie }),
    ),
  );
  const change = changes.changes.find((value) => value.ticketId === ticketID);
  if (!change) throw new Error("Build mode did not create the approved Change");
  state.changeID = change.id;
  if (!state.buildCommandID) {
    const started = performance.now();
    await visible(
      panel.getByRole("button", { name: "Start implementation", exact: true }),
    ).toBeEnabled({ timeout: 120_000 });
    const pending = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname.startsWith("/_server/data/startCoding-") &&
        response.request().method() === "POST",
      { timeout: 120_000 },
    );
    await panel.getByRole("button", { name: "Start implementation", exact: true }).click();
    const response = await pending;
    const body = await serverCall(decodeBrowserFunction<ServerResult<AgentView>>(response));
    const command = z.object({ commandId: z.uuid() }).parse(body.turn);
    state.buildCommandID = command.commandId;
    fixture.noSecrets(JSON.stringify(body));
    agentViewSchema.parse(body);
    await fixture.save("build-admitted", performance.now() - started);
    const replay = agentViewSchema.parse(
      await serverCall(
        callFactoryFunction(fixture.base, "startCoding", [change.id, command], { cookie: cookie }),
      ),
    );
    expect(replay.turn?.id).toBe(agentViewSchema.parse(body).turn?.id);
    const [count] = await database.client<Array<{ count: number }>>`
      SELECT count(*)::int AS count FROM factory.agent_turn WHERE command_id = ${command.commandId}`;
    expect(count?.count).toBe(1);
    await page.mouse.move(0, 0);
    await page.screenshot({ path: resolve(fixture.evidence, "build-started-wide.png") });
    await fixture.save("build-duplicate", performance.now() - started);
  }
  const started = performance.now();
  await visible
    .poll(
      async () => {
        const [turn] = await database.client<Array<{ state: string; summary: string | null }>>`
      SELECT state, outcome_summary AS summary FROM factory.agent_turn WHERE command_id = ${state.buildCommandID ?? ""}`;
        if (turn && ["failed", "stopped", "needs-resolution"].includes(turn.state))
          throw new Error(
            fixture.sanitize(
              `Release Build ended ${turn.state}: ${turn.summary?.slice(0, 500) ?? "No summary"}`,
            ),
          );
        const delivery = deliveryViewSchema.parse(
          await serverCall(
            callFactoryFunction(fixture.base, "getDelivery", [change.id], { cookie: cookie }),
          ),
        );
        return { turn: turn?.state, verification: delivery.verificationState };
      },
      { timeout: 600_000, intervals: [1_000, 2_000, 3_000] },
    )
    .toEqual({ turn: "completed", verification: "succeeded" });
  const delivery = deliveryViewSchema.parse(
    await serverCall(
      callFactoryFunction(fixture.base, "getDelivery", [change.id], { cookie: cookie }),
    ),
  );
  state.verifiedSHA = delivery.verificationCommitSha;
  const [verification] = await database.client<Array<{ sha: string; revision: string }>>`
    SELECT verification.commit_sha AS sha, attempt.revision FROM factory.verification verification
    JOIN factory.runtime_attempt attempt ON attempt.id = verification.runtime_attempt_id
    WHERE verification.change_id = ${change.id} AND verification.state = 'succeeded' ORDER BY verification.created_at DESC LIMIT 1`;
  expect(verification?.sha).toBe(state.verifiedSHA);
  expect(verification?.revision).toBe(state.verifiedSHA);
  const sessions = await database.client<
    Array<{ id: string; state: string; context: unknown; cleaned: boolean }>
  >`
    SELECT id, state, inspection_context AS context, cleanup_confirmed_at IS NOT NULL AS cleaned
    FROM factory.build_browser_session WHERE change_id = ${change.id}`;
  expect(sessions.length).toBeGreaterThan(0);
  expect(sessions.every((value) => value.state === "closed" && value.cleaned)).toBe(true);
  const context = z
    .object({
      app: z.string(),
      changeId: z.uuid(),
      headCommit: z.string(),
      workingTreeModified: z.boolean(),
    })
    .parse(sessions.findLast((value) => value.context)?.context);
  expect(context.app).toBe("app");
  expect(context.changeId).toBe(change.id);
  const runtimeTimes = await database.client<
    Array<{ id: string; state: string; created: string; updated: string }>
  >`
    SELECT id, state, created_at AS created, updated_at AS updated FROM factory.runtime_attempt
    WHERE project_id = ${projectID} ORDER BY created_at`;
  await fixture.record("build-verification", {
    changeID: change.id,
    commandID: state.buildCommandID,
    verification,
    sessions: sessions.map(({ id, state, context, cleaned }) => ({ id, state, context, cleaned })),
    runtimes: runtimeTimes.map(({ id, state, created, updated }) => ({
      id,
      state,
      created,
      updated,
    })),
    timingMeaning:
      "Runtime creation to last product state observation, not measured image pull or individual process duration.",
    resourceObservation:
      "Kubernetes Metrics API is unavailable in this local cluster. No measured RAM/CPU claim.",
  });
  const conversation = conversationViewSchema.parse(
    await serverCall(
      callFactoryFunction(fixture.base, "getConversation", [projectID, { ticketId: ticketID }], {
        cookie: cookie,
      }),
    ),
  );
  expect(conversation.entries.some((entry) => entry.kind === "answer")).toBe(true);
  expect(
    conversation.entries.some((entry) => entry.kind === "mode-change" && entry.mode === "build"),
  ).toBe(true);
  await page.mouse.move(0, 0);
  await page.screenshot({ path: resolve(fixture.evidence, "build-verified-wide.png") });
  await fixture.save("build-verified", performance.now() - started);
}
