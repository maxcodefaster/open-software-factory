import type { createDatabase } from "../../../../packages/db/src/client";
import {
  runtimeBuildBrowserToken,
  runtimeModelToken,
} from "../../../../packages/runtime-domain/src/identity";
import { modelEnvironment } from "../models/controller";
import { runtimeFactoryURL } from "./endpoints";
type Database = ReturnType<typeof createDatabase>;
const agentModelID = process.env["FACTORY_AGENT_MODEL_ID"]?.trim() || "factory-coding-model";
export async function agentConfiguration(
  database: Database,
  changeID: string,
  secret: string,
  attemptID: string,
  generation: number,
  browserToolsImage: string | null,
) {
  if (!browserToolsImage || !/^[a-zA-Z0-9.:/-]+@sha256:[a-f0-9]{64}$/.test(browserToolsImage))
    throw new Error(
      "Configure FACTORY_BROWSER_TOOLS_IMAGE with the pinned Build browser image before starting implementation",
    );
  const [admitted] = await database.client<
    Array<{
      modelID: string;
      provider: "openai" | "anthropic" | "deepseek" | null;
      reasoningEffort: "medium" | "high" | "xhigh" | "max" | null;
    }>
  >`
    SELECT turn.authority->>'modelId' AS "modelID", version.provider,
      turn.authority->>'codingReasoning' AS "reasoningEffort"
    FROM factory.agent_turn turn LEFT JOIN factory.model_connection_version version
      ON version.connection_id::text=turn.authority->'modelConnection'->>'connectionID'
      AND version.version::text=turn.authority->'modelConnection'->>'version'
    WHERE turn.change_id=${changeID} ORDER BY turn.created_at, turn.id LIMIT 1`;
  const modelID = admitted?.modelID ?? agentModelID;
  return {
    modelBaseURL: runtimeFactoryURL(`/internal/model/${attemptID}/v1`),
    modelToken: runtimeModelToken(secret, attemptID, generation),
    modelID,
    modelIDs: admitted ? [modelID] : modelEnvironment().models,
    provider: admitted?.provider ?? "openai",
    ...(admitted?.reasoningEffort ? { reasoningEffort: admitted.reasoningEffort } : {}),
    browserToolsImage,
    browserURL: runtimeFactoryURL(`/internal/build-browser/${attemptID}`),
    browserToken: runtimeBuildBrowserToken(secret, attemptID, generation),
  };
}
