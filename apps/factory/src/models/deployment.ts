import { createHmac } from "node:crypto";
import { modelProvider } from "../../../../packages/conversation-domain/src/model-connection";
import { validateModelEndpoint } from "./native";

// Deployment credentials remain server-only. Adoption uses the normal durable
// encrypted connection write; reading Settings never copies or probes a key.
export function deploymentModelConnections(signingKey: string) {
  return (["planning", "build"] as const).map((role) => {
    const planning = role === "planning";
    const apiKey =
      (planning && process.env["FACTORY_PLANNING_MODEL_API_KEY"]) ||
      process.env["FACTORY_MODEL_API_KEY"];
    const endpoint =
      (planning && process.env["FACTORY_PLANNING_MODEL_BASE_URL"]) ||
      process.env["FACTORY_MODEL_BASE_URL"] ||
      null;
    const provider = modelProvider.parse(
      (planning && process.env["FACTORY_PLANNING_MODEL_PROVIDER"]) ||
        process.env["FACTORY_MODEL_PROVIDER"] ||
        "openai",
    );
    const modelId =
      process.env[planning ? "FACTORY_PROJECT_AGENT_MODEL" : "FACTORY_AGENT_MODEL_ID"] ?? "";
    const hash = createHmac("sha256", signingKey).update(`deployment-model:${role}`).digest("hex");
    const connectionID = `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-8${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
    let valid = true;
    try {
      validateModelEndpoint({ provider, endpoint }, endpoint ? [new URL(endpoint).origin] : []);
    } catch {
      valid = false;
    }
    return {
      role,
      provider,
      modelId,
      endpoint,
      configured: Boolean(valid && apiKey && modelId),
      connectionID,
      apiKey,
    };
  });
}
