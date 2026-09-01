import { providerHttpError } from "./http.js";
import type { AiProvider, AiSettings, CompletionRequest, CompletionResult, FetchImpl } from "./types.js";
import { ProviderError } from "./types.js";

const DEFAULT_BASE_URL = "https://api.anthropic.com";
const DEFAULT_MAX_TOKENS = 1024;
const ANTHROPIC_VERSION = "2023-06-01";

interface AnthropicMessagesResponse {
  content?: Array<{ text?: string }>;
}

export function createAnthropicProvider(
  settings: AiSettings,
  env: NodeJS.ProcessEnv,
  fetchImpl: FetchImpl = globalThis.fetch,
): AiProvider {
  const apiKey = env.ANTHROPIC_API_KEY ?? env.LORELINE_API_KEY;
  if (!apiKey) {
    throw new ProviderError(
      "missing Anthropic API key; set ANTHROPIC_API_KEY or LORELINE_API_KEY",
    );
  }

  const baseUrl = settings.baseUrl ?? DEFAULT_BASE_URL;
  const model = settings.model;

  return {
    name: "anthropic",
    model,
    async complete(request: CompletionRequest): Promise<CompletionResult> {
      const systemMessages = request.messages.filter((message) => message.role === "system");
      const conversation = request.messages
        .filter((message) => message.role !== "system")
        .map((message) => ({ role: message.role, content: message.content }));
      const system = systemMessages.map((message) => message.content).join("\n\n");

      const body: Record<string, unknown> = {
        model,
        messages: conversation,
        max_tokens: request.maxTokens ?? DEFAULT_MAX_TOKENS,
      };
      if (system) {
        body.system = system;
      }
      if (request.temperature !== undefined) {
        body.temperature = request.temperature;
      }

      const response = await fetchImpl(`${baseUrl}/v1/messages`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": apiKey,
          "anthropic-version": ANTHROPIC_VERSION,
        },
        body: JSON.stringify(body),
      });

      if (!response.ok) {
        throw await providerHttpError("anthropic", response);
      }

      const data = (await response.json()) as AnthropicMessagesResponse;
      const text = data.content?.[0]?.text;
      if (typeof text !== "string") {
        throw new ProviderError("anthropic response did not include message text");
      }

      return { text, provider: "anthropic", model };
    },
  };
}
