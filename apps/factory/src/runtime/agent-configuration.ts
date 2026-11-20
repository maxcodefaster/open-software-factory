import { and, asc, eq, sql } from "drizzle-orm";
import type { createDatabase } from "../../../../packages/db/src/client";
import { agentTurn, modelConnectionVersion } from "../../../../packages/db/src/schema";
import {
  runtimeBuildBrowserToken,
  runtimeModelToken,
} from "../../../../packages/runtime-domain/src/identity";
import { modelEnvironment } from "../models/controller";
import { substrateFactoryURL } from "./endpoints";

type Database = ReturnType<typeof createDatabase>;
const agentModelID = process.env["FACTORY_AGENT_MODEL_ID"]?.trim() || "factory-coding-model";
export async function agentConfiguration(
  database: Database,
  changeID: string,
  secret: string,
  attemptID: string,
  generation: number,
  browserToolsImage: string | null,
  binding: unknown,
) {
  if (!browserToolsImage || !/^[a-zA-Z0-9.:/-]+@sha256:[a-f0-9]{64}$/.test(browserToolsImage))
    throw new Error(
      "Configure FACTORY_BROWSER_TOOLS_IMAGE with the pinned Build browser image before starting implementation",
    );
  const [admitted] = await database.db
    .select({
      modelID: sql<string | null>`${agentTurn.authority}->>'modelId'`,
      provider: modelConnectionVersion.provider,
      reasoningEffort: sql<
        "medium" | "high" | "xhigh" | "max" | null
      >`${agentTurn.authority}->>'codingReasoning'`,
    })
    .from(agentTurn)
    .leftJoin(
      modelConnectionVersion,
      and(
        sql`${modelConnectionVersion.connectionId}::text=${agentTurn.authority}->'modelConnection'->>'connectionID'`,
        sql`${modelConnectionVersion.version}::text=${agentTurn.authority}->'modelConnection'->>'version'`,
      ),
    )
    .where(eq(agentTurn.changeId, changeID))
    .orderBy(asc(agentTurn.createdAt), asc(agentTurn.id))
    .limit(1);
  const modelID = admitted?.modelID ?? agentModelID;
  return {
    modelBaseURL: substrateFactoryURL(`/internal/model/${attemptID}/v1`, binding),
    modelToken: runtimeModelToken(secret, attemptID, generation),
    modelID,
    modelIDs: admitted ? [modelID] : modelEnvironment().models,
    provider: admitted?.provider ?? "openai",
    ...(admitted?.reasoningEffort ? { reasoningEffort: admitted.reasoningEffort } : {}),
    browserToolsImage,
    browserURL: substrateFactoryURL(`/internal/build-browser/${attemptID}`, binding),
    browserToken: runtimeBuildBrowserToken(secret, attemptID, generation),
  };
}
