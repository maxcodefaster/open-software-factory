import { expect } from "bun:test";
import { zeroDrizzle } from "@rocicorp/zero/server/adapters/drizzle";
import { z } from "zod";
import { deliveryViewSchema } from "../../apps/factory/src/api-contracts";
import type { createDatabase } from "../../packages/db/src/client";
import { zeroSchema } from "../../packages/zero-schema/src";
import { zeroServerMutators } from "../../packages/zero-schema/src/server";
import { eventually } from "./factory-process";

export async function starterDelivery(input: {
  database: ReturnType<typeof createDatabase>;
  projectID: string;
  api(path: string, method?: string, body?: unknown): Promise<unknown>;
}) {
  const { database, projectID, api } = input;
  const title = "Make the protected home welcoming";
  const description =
    "Change only the protected home heading from You're home. to Welcome home. Preserve signup, login, logout, database, runtime configuration and dependencies. Add a focused test of the new heading and run npm run check. Do not commit or push.";
  const [owner] = await database.client<
    { userID: string }[]
  >`SELECT created_by AS "userID" FROM factory.project WHERE id=${projectID}`;
  if (!owner) throw new Error("Starter owner missing");
  const existing = await database.client<
    { ticketID: string; changeID: string | null; commandID: string | null }[]
  >`SELECT ticket.id AS "ticketID",change.id AS "changeID",turn.command_id AS "commandID"
    FROM factory.ticket ticket LEFT JOIN factory.change change ON change.ticket_id=ticket.id
    LEFT JOIN LATERAL (SELECT command_id FROM factory.agent_turn WHERE change_id=change.id
      ORDER BY created_at DESC,id DESC LIMIT 1) turn ON true
    WHERE ticket.project_id=${projectID} AND ticket.title=${title} LIMIT 2`;
  if (existing.length > 1) throw new Error("Starter proof has ambiguous prior Build work");
  const previous = existing[0];
  const ticketID = previous?.ticketID ?? crypto.randomUUID();
  const zero = zeroDrizzle(zeroSchema, database.db);
  if (!previous)
    await zero.transaction((tx) =>
      zeroServerMutators.tickets.create.fn({
        tx,
        ctx: { userId: owner.userID, systemManager: true },
        args: { id: ticketID, projectId: projectID, title, description },
      }),
    );
  expect(await database.client`SELECT id FROM factory.ticket WHERE id=${ticketID}`).toHaveLength(1);
  const [savedRevision] = await database.client<{ id: string }[]>`
    SELECT id FROM factory.requirement_revision WHERE ticket_id=${ticketID} ORDER BY ordinal DESC LIMIT 1`;
  const revision =
    savedRevision ??
    ((await api(`/api/tickets/${ticketID}/requirements`, "POST", {
      summary: description,
      acceptanceCriteria: [
        "Authenticated home displays Welcome home.",
        "Signup, login, logout and database auth checks pass",
        "npm run check passes",
      ],
      nonGoals: ["Runtime configuration, new dependencies, unrelated UI or authentication changes"],
    })) as { id: string });
  if (previous?.changeID && !previous.commandID)
    throw new Error("Starter proof has a Change without its admitted Build command");
  const command = {
    commandId: previous?.commandID ?? crypto.randomUUID(),
    revisionId: revision.id,
  };
  const started = performance.now();
  const change = previous?.changeID
    ? { id: previous.changeID }
    : ((await api(`/api/tickets/${ticketID}/implement`, "POST", command)) as { id: string });
  if (!previous?.changeID)
    expect(await api(`/api/tickets/${ticketID}/implement`, "POST", command)).toMatchObject({
      id: change.id,
    });
  const retryCommandID = process.env["FACTORY_STARTER_BUILD_RETRY_COMMAND"];
  if (retryCommandID) {
    z.uuid().parse(retryCommandID);
    if (!previous?.changeID) throw new Error("Build retry requires retained commissioned work");
    const [retry] = await database.client<{ changeID: string }[]>`
      SELECT change_id AS "changeID" FROM factory.agent_turn WHERE command_id=${retryCommandID}`;
    if (retry && retry.changeID !== change.id)
      throw new Error("Starter retry command belongs to other work");
    if (!retry) {
      const [failed] = await database.client<{ state: string }[]>`
        SELECT state FROM factory.agent_turn WHERE command_id=${command.commandId}`;
      if (!failed || !["failed", "stopped"].includes(failed.state))
        throw new Error("Starter retry requires a settled failed or stopped Build");
    }
    await api(`/api/changes/${change.id}/agent/start`, "POST", { commandId: retryCommandID });
    command.commandId = retryCommandID;
    console.log(JSON.stringify({ starterBuildRetry: retryCommandID, changeID: change.id }));
  }
  await eventually(
    async () => {
      const [current] = await database.client<{ state: string; failure: string | null }[]>`
        SELECT state,failure FROM factory.change WHERE id=${change.id}`;
      if (current?.state === "failed") throw new Error(`Starter Change failed: ${current.failure}`);
      const [turn] = await database.client<
        { state: string; summary: string | null }[]
      >`SELECT state,outcome_summary AS summary FROM factory.agent_turn WHERE command_id=${command.commandId}`;
      if (turn && ["failed", "stopped", "needs-resolution"].includes(turn.state))
        throw new Error(
          `Starter Build ${turn.state}: ${turn.summary?.slice(0, 400) ?? "no summary"}`,
        );
      const [commit] = await database.client<
        { error: string | null }[]
      >`SELECT operation.last_error AS error FROM factory.change_commit_operation operation JOIN factory.agent_turn turn ON turn.id=operation.id WHERE turn.command_id=${command.commandId}`;
      if (commit?.error) throw new Error(`Starter commit handoff: ${commit.error}`);
      return turn?.state;
    },
    (value) => value === "completed",
    "Starter Build did not complete",
    600_000,
  );
  const usage = await database.client<
    { source: string; model: string; purpose: string; count: number }[]
  >`
    SELECT entry.source,operation.model,operation.purpose,count(*)::int AS count FROM factory.usage_operation operation
    JOIN factory.usage_entry entry ON entry.operation_id=operation.id
    WHERE operation.id='turn:'||(SELECT id FROM factory.agent_turn WHERE command_id=${command.commandId})
    GROUP BY entry.source,operation.model,operation.purpose`;
  expect(usage.some((row) => row.source === "step" && row.purpose === "coding")).toBe(true);
  expect(usage.every((row) => row.model === process.env["FACTORY_AGENT_MODEL_ID"])).toBe(true);
  const verified = await eventually(
    async () => {
      const delivery = deliveryViewSchema.parse(await api(`/api/changes/${change.id}/delivery`));
      if (delivery.verificationState === "failed")
        throw new Error(`Starter Verification failed: ${delivery.verificationSummary}`);
      return delivery;
    },
    (value) => value.verificationState === "succeeded",
    "Starter fresh Verification did not complete",
    600_000,
  );
  if (!verified?.verificationCommitSha) throw new Error("Starter verified commit missing");
  const [fresh] = await database.client<
    { sha: string; revision: string; workspaceID: string | null }[]
  >`SELECT verification.commit_sha AS sha,attempt.revision,attempt.workspace_id AS "workspaceID" FROM factory.verification verification JOIN factory.runtime_attempt attempt ON attempt.id=verification.runtime_attempt_id WHERE verification.change_id=${change.id} AND verification.state='succeeded' ORDER BY verification.created_at DESC LIMIT 1`;
  expect(fresh).toEqual({
    sha: verified.verificationCommitSha,
    revision: verified.verificationCommitSha,
    workspaceID: null,
  });
  const [approval] = await database.client<{ id: string }[]>`
    SELECT id FROM factory.delivery_approval WHERE change_id=${change.id}`;
  if (!approval) await api(`/api/changes/${change.id}/delivery/approve`, "POST", {});
  const [completed] = await database.client<{ state: string; previewState: string }[]>`
    SELECT change.state,attempt.state AS "previewState" FROM factory.change change
    JOIN factory.staging_preview preview ON preview.project_id=change.project_id
    JOIN factory.runtime_attempt attempt ON attempt.id=preview.runtime_attempt_id WHERE change.id=${change.id}`;
  if (completed?.state === "delivered" && ["stopped", "failed"].includes(completed.previewState))
    await api(`/api/projects/${projectID}/staging/ensure`, "POST", {});
  const promoted = await eventually(
    async () => {
      const [row] = await database.client<
        {
          id: string;
          state: string;
          changeState: string;
          revision: string;
          promotionState: string | null;
          failure: string | null;
        }[]
      >`SELECT attempt.id,attempt.state,change.state AS "changeState",preview.revision,
        promotion.state AS "promotionState",promotion.last_error AS failure
        FROM factory.staging_preview preview JOIN factory.runtime_attempt attempt ON attempt.id=preview.runtime_attempt_id
        JOIN factory.change change ON change.project_id=preview.project_id
        LEFT JOIN factory.promotion_operation promotion ON promotion.change_id=change.id WHERE change.id=${change.id}`;
      if (row?.promotionState === "failed")
        throw new Error(`Starter promotion failed: ${row.failure}`);
      return row;
    },
    (row) => row?.state === "ready" && row.changeState === "delivered",
    "Starter Delivery did not promote healthy Main-Preview",
    600_000,
  );
  expect(promoted?.revision).toBe(verified.verificationCommitSha);
  console.log(
    JSON.stringify({
      journey: "Starter native Build, fresh Verification and Delivery",
      elapsedMS: Math.round(performance.now() - started),
    }),
  );
  return { changeID: change.id, ticketID, previewID: promoted?.id };
}
