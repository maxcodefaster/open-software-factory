import { createAnthropic } from "@ai-sdk/anthropic";
import { createDeepSeek } from "@ai-sdk/deepseek";
import { createOpenAI } from "@ai-sdk/openai";
import { getProviderConfig, type MastraModelConfig } from "@mastra/core/llm";
import {
  type ModelConnectionMetadata,
  type ModelProvider,
  modelProvider,
} from "../../../../packages/conversation-domain/src/model-connection";
import { modelIdInput } from "../../../../packages/conversation-domain/src/model-settings";
import { CommandError } from "../command-error";

export type ResolvedModelConnection = {
  provider?: ModelProvider;
  baseURL?: string;
  apiKey: string;
};

export const nativeEndpoints = {
  openai: "https://api.openai.com/v1",
  anthropic: "https://api.anthropic.com/v1",
  deepseek: "https://api.deepseek.com",
} as const satisfies Record<ModelProvider, string>;

export function providerCatalogue() {
  return modelProvider.options.map((provider) => {
    const upstream = getProviderConfig(provider);
    if (!upstream) throw new Error(`Pinned Mastra provider unavailable: ${provider}`);
    return {
      provider,
      label: upstream.name,
      models: upstream.models.filter((id) => modelIdInput.safeParse(id).success),
    };
  });
}

export function validateModelEndpoint(
  metadata: ModelConnectionMetadata,
  allowedOrigins: readonly string[] = [],
) {
  const endpoint = metadata.endpoint ?? nativeEndpoints[metadata.provider];
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw new CommandError("conflict", "Invalid model endpoint");
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    /\\|\/(?:\.|\.\.)(?:\/|$)/.test(endpoint) ||
    /%2f|%5c|%2e/i.test(url.pathname)
  )
    throw new CommandError(
      "conflict",
      "Model endpoint must use HTTPS without embedded credentials",
    );
  const defaultURL = new URL(nativeEndpoints[metadata.provider]);
  if (url.origin !== defaultURL.origin && !allowedOrigins.includes(url.origin))
    throw new CommandError("forbidden", "This model endpoint is not allowed by the deployment");
  if (
    url.origin === defaultURL.origin &&
    url.pathname.replace(/\/$/, "") !== defaultURL.pathname.replace(/\/$/, "")
  )
    throw new CommandError("conflict", "Use the provider's native endpoint");
  return url.toString().replace(/\/$/, "");
}

export function nativeModel(
  connection: ResolvedModelConnection,
  modelId: string,
): MastraModelConfig {
  const provider = connection.provider ?? "openai";
  const id = modelIdInput.parse(modelId);
  if (id.startsWith(`${provider}/`))
    throw new CommandError("conflict", "Select the provider model ID without a provider prefix");
  const baseURL = connection.baseURL;
  // Router URL overrides in pinned Mastra select chat-completions even for Anthropic.
  // Use the native SDK for enterprise endpoints, never translate Messages to OpenAI.
  if (baseURL || (provider === "openai" && id === "gpt-6-luna")) {
    const options = { apiKey: connection.apiKey, ...(baseURL ? { baseURL } : {}) };
    switch (provider) {
      case "anthropic":
        return createAnthropic(options)(id);
      case "deepseek":
        return createDeepSeek(options)(id);
      case "openai": {
        const sdk = createOpenAI(options);
        return id === "gpt-6-luna" ? sdk.responses(id) : sdk.chat(id);
      }
    }
  }
  return { id: `${provider}/${id}` as const, apiKey: connection.apiKey };
}

export function modelProviderOptions(connection: ResolvedModelConnection, modelId: string) {
  return (connection.provider ?? "openai") === "openai" && modelId === "gpt-6-luna"
    ? { openai: { reasoningEffort: "low", store: false } }
    : undefined;
}
