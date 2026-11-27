import { and, eq, notInArray, sql as query } from "drizzle-orm";
import { agentTurnAuthorityInput } from "#conversation-domain/agent-turn";
import type { ModelConnectionReference } from "#conversation-domain/model-connection";
import { type DatabaseTransaction, drizzleTransaction } from "#db/client";
import {
  agentTurn,
  changeAgentTurnIntent,
  changeCommitOperation,
  conversationContext,
  modelConnectionVersion,
  operation,
} from "#db/schema";
import { projectAuthorityIn, projectDevelopmentAuthorityIn } from "../access/authority";
import { requireDeliveredPrerequisites } from "../change/api";
import { CommandError } from "../command-error";
import { codingReasoningIn } from "../models/api";
import { monitoringChangeAuthorityIn } from "../monitoring/authority";
import type { createSkillController } from "../skills/api";
import { codingBudgetIn } from "../usage/api";
import { createContractRates } from "../usage/journal-api";
import type {
  AdmissionDatabase,
  ChangeAgentInput,
  ChangeContext,
  DefaultModelResolver,
} from "./change-admission-context";

async function readConnectionProviderIn(
  db: ReturnType<typeof drizzleTransaction>,
  modelConnection: ModelConnectionReference | undefined,
): Promise<string | undefined> {
  if (!modelConnection) return undefined;
  const [connection] = await db
    .select({ provider: modelConnectionVersion.provider })
    .from(modelConnectionVersion)
    .where(
      and(
        eq(modelConnectionVersion.connectionId, modelConnection.connectionID),
        eq(modelConnectionVersion.version, modelConnection.version),
      ),
    );
  return connection?.provider;
}

export async function resolveAdmissionPolicyIn(params: {
  database: AdmissionDatabase;
  sql: DatabaseTransaction;
  skills: ReturnType<typeof createSkillController>;
  defaultModel: DefaultModelResolver;
  resolveConnection?:
    | ((sql: DatabaseTransaction) => Promise<ModelConnectionReference | undefined>)
    | undefined;
  changeID: string;
  userID: string;
  input: ChangeAgentInput;
  current: ChangeContext;
}) {
  const {
    database,
    sql,
    skills,
    defaultModel,
    resolveConnection,
    changeID,
    userID,
    input,
    current,
  } = params;
  const db = drizzleTransaction(sql);
  const isResumePrompt = input.kind === "change-prompt" && input.resume === true;
  if (
    (input.contextId ?? null) !== current.contextID &&
    input.kind !== "change-repair" &&
    !isResumePrompt
  )
    throw new CommandError(
      "conflict",
      "The active Coding conversation changed. Keep your draft and return to the active conversation.",
    );
  const [codingContext] = current.contextID
    ? await db
        .select({ nativeID: conversationContext.nativeSessionId })
        .from(conversationContext)
        .where(
          and(
            eq(conversationContext.id, current.contextID),
            eq(conversationContext.changeId, changeID),
          ),
        )
    : [];
  if (codingContext) current.sessionID = codingContext.nativeID;
  if (input.kind === "change-start" && input.codingReasoning)
    await projectDevelopmentAuthorityIn(sql, userID, current.projectID);
  else await projectAuthorityIn(sql, userID, current.projectID);
  const paused = await db
    .select({ turnID: query<string>`(${operation.scopeId})::uuid` })
    .from(operation)
    .innerJoin(agentTurn, eq(query`${agentTurn.id}::text`, operation.scopeId))
    .where(
      and(
        eq(operation.kind, "usage.coding_pause"),
        eq(operation.scopeType, "agent_turn"),
        eq(operation.state, "paused"),
        query`(${operation.payload}->>'resumedByTurnId') IS NULL`,
        eq(agentTurn.changeId, changeID),
        query`${agentTurn.input}->>'contextId' IS NOT DISTINCT FROM ${current.contextID}`,
      ),
    );
  if (paused.length && input.kind !== "change-repair" && !isResumePrompt)
    throw new CommandError(
      "conflict",
      "Coding is paused. Resume the retained work from the Ticket.",
    );
  const budget = await codingBudgetIn(
    sql,
    current.projectID,
    input.kind === "change-repair" || isResumePrompt,
  );
  if (!budget.allowed && input.kind !== "change-repair")
    throw new CommandError(
      "conflict",
      budget.reason === "accounting-incomplete"
        ? "Coding accounting is incomplete. Usage & limits shows what is missing."
        : "The monthly Coding allowance is used. New work can start after reset or an allowance increase.",
    );
  await requireDeliveredPrerequisites(sql, current.projectID, current.ticketID);
  const [firstTurn] = await db
    .select({
      modelId: query<string>`${agentTurn.authority}->>'modelId'`,
      authority: agentTurn.authority,
      skillManifest: changeAgentTurnIntent.skillManifest,
    })
    .from(agentTurn)
    .leftJoin(changeAgentTurnIntent, eq(changeAgentTurnIntent.turnId, agentTurn.id))
    .where(eq(agentTurn.changeId, changeID))
    .orderBy(agentTurn.createdAt, agentTurn.id)
    .limit(1);
  const firstAuthority = firstTurn ? agentTurnAuthorityInput.parse(firstTurn.authority) : undefined;
  const monitoringIncidentID =
    input.kind === "change-start"
      ? current.monitoringIncidentID
      : input.kind === "change-repair" && firstAuthority?.mode === "build"
        ? firstAuthority.monitoringIncidentId
        : undefined;
  if (monitoringIncidentID) {
    const delegated = await monitoringChangeAuthorityIn(
      database,
      sql,
      changeID,
      monitoringIncidentID,
    );
    if (delegated.userId !== userID)
      throw new CommandError("forbidden", "Autofix must use its recorded Project delegation");
  }
  const modelID =
    firstTurn?.modelId ??
    (typeof defaultModel === "string"
      ? defaultModel
      : await defaultModel(sql, {
          projectID: current.projectID,
          userID,
          personal: !monitoringIncidentID,
        }));
  const modelConnection = firstTurn
    ? firstAuthority?.modelConnection
    : await resolveConnection?.(sql);
  const codingReasoning = firstTurn
    ? firstAuthority?.mode === "build"
      ? firstAuthority.codingReasoning
      : undefined
    : input.kind === "change-start" && input.codingReasoning
      ? input.codingReasoning
      : await codingReasoningIn(sql);
  const needsConnectionProvider =
    (input.kind === "change-start" && Boolean(input.codingReasoning)) ||
    (budget.allowed && budget.effective.codingUSD !== null);
  const connectionProvider = needsConnectionProvider
    ? await readConnectionProviderIn(db, modelConnection)
    : undefined;
  if (input.kind === "change-start" && input.codingReasoning) {
    if (firstTurn && input.codingReasoning !== codingReasoning)
      throw new CommandError(
        "conflict",
        "This Change keeps its original reasoning. Start a new Change to choose different reasoning.",
      );
    if ((connectionProvider ?? process.env["FACTORY_MODEL_PROVIDER"] ?? "openai") !== "openai")
      throw new CommandError(
        "conflict",
        "Reasoning selection is available for OpenAI Coding models only.",
      );
  }
  if (budget.allowed && budget.effective.codingUSD !== null) {
    const rate = await createContractRates(database).get(
      connectionProvider ?? "openai",
      modelID,
      sql,
    );
    if (!rate || rate.tiers.some((tier) => tier.input === null || tier.output === null))
      throw new CommandError(
        "conflict",
        "Coding needs known input and output prices before starting with an enabled allowance. Set contract prices in Usage & limits.",
      );
  }
  const assignedSkills = firstAuthority
    ? {
        revisionIds: firstAuthority.skillRevisionIds,
        requiredRevisionIds: firstAuthority.requiredSkillRevisionIds,
      }
    : await skills.resolveAssignment("build", sql, {
        projectID: current.projectID,
        userID,
        personal: !monitoringIncidentID,
      });
  const admittedSkills = await skills.load(assignedSkills.revisionIds, sql);
  const nativeSkills = firstTurn ? firstTurn.skillManifest !== null : true;
  if (current.stopPending)
    throw new CommandError(
      "conflict",
      "Stop is recorded. Wait for runtime confirmation before resuming Build.",
    );
  if (current.sessionState === "starting" || current.sessionState === "working")
    throw new CommandError("conflict", "The Change Agent already owns active Build work");
  if (input.kind !== "change-start" && !current.sessionID)
    throw new CommandError("conflict", "Change Agent has not been started");
  if (input.kind === "change-repair" && current.sessionState !== "committed")
    throw new CommandError("conflict", "Automatic repair is paused. Resume Build manually.");
  const commits = await db
    .select({ id: changeCommitOperation.id })
    .from(changeCommitOperation)
    .where(
      and(
        eq(changeCommitOperation.changeId, changeID),
        notInArray(changeCommitOperation.state, ["succeeded", "failed"]),
      ),
    );
  if (commits[0])
    throw new CommandError(
      "conflict",
      "Wait for the current commit operation before starting Build",
    );
  return {
    budget,
    monitoringIncidentID,
    modelID,
    modelConnection,
    codingReasoning,
    assignedSkills,
    admittedSkills,
    nativeSkills,
  };
}
