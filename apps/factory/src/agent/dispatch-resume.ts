import { and, eq, sql as expression } from "drizzle-orm";
import { drizzleTransaction } from "#db/client";
import {
  agentTurn,
  auditEvent,
  changeAgentTurnIntent,
  change as changeTable,
  operation,
} from "#db/schema";
import { projectAuthorityIn } from "../access/authority";
import { lockChangeWriterIn } from "../access/change-writer";
import { CommandError } from "../command-error";
import type { RuntimeHub } from "../runtime/transport-api";
import {
  type AgentActivity,
  type AgentAdmission,
  type AgentTurnStore,
  type Database,
  type ExecuteTurn,
  opencode,
} from "./controller-types";
import { confirmSettledOpenCodeInput } from "./opencode-adapter";
import { activeCodingPausePredicate } from "./turn-lifecycle";

const RESUME_CONTINUATION_PROMPT =
  "Continue the already commissioned implementation from the retained checkout. Factory paused the previous turn at its Coding allowance. Preserve existing changes, complete the remaining work and run the repository checks. Do not commit or push; Factory handles that after successful completion.";

export type ResumePausedTurnDeps = {
  database: Database;
  hub: RuntimeHub;
  turns: AgentTurnStore;
  admission: AgentAdmission;
  activity: Pick<AgentActivity, "run">;
  execute: ExecuteTurn;
};

export async function resumePausedTurn(
  deps: ResumePausedTurnDeps,
  changeID: string,
  userID: string,
  commandID: string,
  pausedTurnID: string,
): Promise<string> {
  const { database, hub, turns, admission, activity, execute } = deps;
  const [pendingResume] = await database.db
    .select({
      state: agentTurn.state,
      review: expression<boolean>`${agentTurn.authority} ? 'review'`,
      attemptID: changeAgentTurnIntent.runtimeAttemptId,
      sessionID: changeAgentTurnIntent.sessionId,
      promptID: changeAgentTurnIntent.promptId,
    })
    .from(agentTurn)
    .innerJoin(changeAgentTurnIntent, eq(changeAgentTurnIntent.turnId, agentTurn.id))
    .innerJoin(operation, activeCodingPausePredicate(expression`${agentTurn.id}::text`))
    .where(and(eq(agentTurn.id, pausedTurnID), eq(agentTurn.changeId, changeID)));
  const [project] = await database.db
    .select({ id: changeTable.projectId })
    .from(changeTable)
    .where(eq(changeTable.id, changeID));
  if (!project) throw new CommandError("not-found", "Change not found");
  await database.client.begin((sql) => projectAuthorityIn(sql, userID, project.id));
  if (pendingResume?.state === "failed" && pendingResume.review)
    throw new CommandError(
      "conflict",
      "Retry the independent review after resolving its Coding allowance. A review cannot resume as implementation.",
    );
  if (
    pendingResume?.state === "failed" &&
    (!pendingResume.attemptID ||
      !(await confirmSettledOpenCodeInput(
        opencode(hub, pendingResume.attemptID),
        pendingResume.sessionID,
        pendingResume.promptID,
      )))
  )
    throw new CommandError(
      "conflict",
      "Wait for the previous model call and queued input to finish before resuming",
    );
  const turnID = await database.client.begin(async (sql) => {
    await sql`SELECT pg_advisory_xact_lock(hashtext(${`coding-resume:${commandID}`}))`;
    const input = { changeID, pausedTurnID };
    const scope = `coding-resume:${changeID}`;
    const dedupeKey = `usage.policy_command:${commandID}`;
    const db = drizzleTransaction(sql);
    const [old] = await db
      .select({
        actorID: auditEvent.actorId,
        input: expression<{
          changeID: string;
          pausedTurnID: string;
        }>`${auditEvent.payload}->'input'`,
        result: expression<{ turnID: string }>`${auditEvent.payload}->'result'`,
      })
      .from(auditEvent)
      .where(eq(auditEvent.dedupeKey, dedupeKey));
    const [currentProject] = await db
      .select({ id: changeTable.projectId })
      .from(changeTable)
      .where(eq(changeTable.id, changeID));
    if (!currentProject) throw new CommandError("not-found", "Change not found");
    if (old) {
      await projectAuthorityIn(sql, userID, currentProject.id);
      if (
        old.actorID !== userID ||
        old.input.changeID !== changeID ||
        old.input.pausedTurnID !== pausedTurnID
      )
        throw new CommandError("conflict", "Resume command changed input");
      return old.result.turnID;
    }
    await db
      .select({ id: agentTurn.id })
      .from(agentTurn)
      .where(eq(agentTurn.id, pausedTurnID))
      .for("update");
    await lockChangeWriterIn(sql, changeID);
    await projectAuthorityIn(sql, userID, currentProject.id);
    const [paused] = await db
      .select({ state: agentTurn.state })
      .from(operation)
      .innerJoin(agentTurn, eq(expression`${agentTurn.id}::text`, operation.scopeId))
      .where(and(activeCodingPausePredicate(pausedTurnID), eq(agentTurn.changeId, changeID)))
      .for("update");
    if (!paused) throw new CommandError("conflict", "This Coding pause is no longer current");
    let next: string;
    if (paused.state === "pending") next = await turns.resumePendingIn(sql, pausedTurnID);
    else if (paused.state === "failed") {
      const accepted = await admission.admitIn(sql, changeID, userID, {
        kind: "change-prompt",
        commandId: commandID,
        resume: true,
        text: RESUME_CONTINUATION_PROMPT,
      });
      next = accepted.turn.id;
    } else
      throw new CommandError(
        "conflict",
        "Wait for the current model call to finish before resuming",
      );
    const result = { turnID: next };
    await db.insert(auditEvent).values({
      id: commandID,
      kind: "usage.policy_command",
      scopeType: "execution_policy",
      scopeId: scope,
      actorId: userID,
      dedupeKey,
      payload: {
        commandId: commandID,
        scope,
        actorId: userID,
        input,
        result,
      },
    });
    return next;
  });
  activity.run(execute(turnID));
  return turnID;
}
