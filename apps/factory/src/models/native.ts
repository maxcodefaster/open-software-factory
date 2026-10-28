import type { MastraModelConfig } from "@mastra/core/llm";
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

export async function providerCatalogue() {
  const { getProviderConfig } = await import("@mastra/core/llm");
  return modelProvider.options.map((provider) => {
    const upstream = getProviderConfig(provider);
    if (!upstream) throw new Error(`Pinned Mastra provider unavailable: ${provider}`);
    return {
      provider,
      label: upstream.name,
      // The upstream catalogue includes image, embedding and Realtime models.
      // These are not candidates for Factory's text/tool conversation roles.
      // Explicit deployment/connection model IDs remain separately configurable.
      models: upstream.models.filter(
        (id) =>
          modelIdInput.safeParse(id).success &&
          (provider !== "openai" ||
            !/^(?:chatgpt-image|gpt-image|gpt-realtime|text-embedding)(?:-|$)/.test(id)),
      ),
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

export async function nativeModel(
  connection: ResolvedModelConnection,
  modelId: string,
): Promise<MastraModelConfig> {
  const provider = connection.provider ?? "openai";
  const id = modelIdInput.parse(modelId);
  if (id.startsWith(`${provider}/`))
    throw new CommandError("conflict", "Select the provider model ID without a provider prefix");
  const baseURL = connection.baseURL;
  const responses = provider === "openai" && (id === "gpt-6-luna" || id === "gpt-6.1-sol");
  // Router URL overrides in pinned Mastra select chat-completions even for Anthropic.
  // Use the native SDK for enterprise endpoints, never translate Messages to OpenAI.
  if (baseURL || responses) {
    const options = { apiKey: connection.apiKey, ...(baseURL ? { baseURL } : {}) };
    switch (provider) {
      case "anthropic": {
        const { createAnthropic } = await import("@ai-sdk/anthropic");
        return createAnthropic(options)(id);
      }
      case "deepseek": {
        const { createDeepSeek } = await import("@ai-sdk/deepseek");
        return createDeepSeek(options)(id);
      }
      case "openai": {
        const { createOpenAI } = await import("@ai-sdk/openai");
        const sdk = createOpenAI(options);
        return responses ? sdk.responses(id) : sdk.chat(id);
      }
    }
  }
  return { id: `${provider}/${id}` as const, apiKey: connection.apiKey };
}

export function modelProviderOptions(connection: ResolvedModelConnection, modelId: string) {
  if ((connection.provider ?? "openai") !== "openai") return undefined;
  if (modelId === "gpt-6-luna") return { openai: { reasoningEffort: "low", store: false } };
  if (modelId === "gpt-6.1-sol") return { openai: { store: false } };
  return undefined;
}
