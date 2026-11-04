import type { ModelProbeResult } from "../../../../packages/conversation-domain/src/model-connection";

function origin(endpoint: string | null | undefined) {
  if (!endpoint) return undefined;
  try {
    return new URL(endpoint).origin;
  } catch {
    return endpoint;
  }
}

// The probe deliberately returns only a status, never provider errors or URLs.
// Each status therefore names the most likely cause and what a person can do.
export function modelProbeExplanation(
  status: ModelProbeResult["status"],
  endpoint?: string | null,
) {
  const custom = origin(endpoint);
  switch (status) {
    case "ready":
      return "Access checked.";
    case "invalid-credentials":
      return "The provider rejected the API key. Save a valid key and check again.";
    case "model-denied":
      return "The provider does not allow this model for the key, or does not know it. Choose another model.";
    case "rate-limited":
      return "The provider is rate limiting this key. Wait and check again.";
    case "unsupported":
      return "The model answered, but it cannot call tools with structured output, which Factory requires.";
    case "unavailable":
      return custom
        ? `Factory could not reach ${custom}. Check that the endpoint answers from the cluster. An operator must also list this origin in modelAllowedOrigins in the Helm values.`
        : "Factory could not reach the provider. Check again. If it persists, check this installation's outbound network access.";
    case "timeout":
      return "The provider did not answer in time. Check again.";
    case "stopped":
      return "The check was stopped. Nothing was saved.";
    case "superseded":
      return "Another change replaced this connection or the model settings during the check. Review them and check again.";
  }
}
