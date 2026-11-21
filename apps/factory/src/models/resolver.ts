import { modelProvider } from "../../../../packages/conversation-domain/src/model-connection";
import { CommandError } from "../command-error";
import { type ResolvedModelConnection } from "./inference-contracts";

export function installationPlanningConnection(): ResolvedModelConnection {
  const baseURL =
    process.env["FACTORY_PLANNING_MODEL_BASE_URL"]?.trim() ||
    process.env["FACTORY_MODEL_BASE_URL"]?.trim();
  const apiKey =
    process.env["FACTORY_PLANNING_MODEL_API_KEY"]?.trim() ||
    process.env["FACTORY_MODEL_API_KEY"]?.trim();
  if (!apiKey)
    throw new CommandError(
      "unavailable",
      "The Planning model is not configured. Configure a model connection in Settings before continuing.",
    );
  const provider = modelProvider.parse(
    process.env["FACTORY_PLANNING_MODEL_PROVIDER"]?.trim() ||
      process.env["FACTORY_MODEL_PROVIDER"]?.trim() ||
      "openai",
  );
  return { provider, ...(baseURL ? { baseURL: baseURL.replace(/\/$/, "") } : {}), apiKey };
}
