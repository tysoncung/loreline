import { providerHttpError } from "./http.js";
import type { AiProvider, AiSettings, CompletionRequest, CompletionResult, FetchImpl } from "./types.js";
import { ProviderError } from "./types.js";

const DEFAULT_BASE_URL = "https://api.openai.com";

interface OpenAiChatResponse {
  choices?: Array<{ message?: { content?: string } }>;
}

export function createOpenAiProvider(
  settings: AiSettings,
  env: NodeJS.ProcessEnv,
  fetchImpl: FetchImpl = globalThis.fetch,
): AiProvider {
  const apiKey = env.OPENAI_API_KEY ?? env.LORELINE_API_KEY;
  if (!apiKey) {
    throw new ProviderError(
      "missing OpenAI API key; set OPENAI_API_KEY or LORELINE_API_KEY",
    );
  }

  const baseUrl = settings.baseUrl ?? DEFAULT_BASE_URL;
  const model = settings.model;

  return {
    name: "openai",
    model,
    async complete(request: CompletionRequest): Promise<CompletionResult> {
      const body: Record<string, unknown> = {
        model,
        messages: request.messages,
      };
      if (request.maxTokens !== undefined) {
        body.max_tokens = request.maxTokens;
      }
      if (request.temperature !== undefined) {
        body.temperature = request.temperature;
      }

      const response = await fetchImpl(`${baseUrl}/v1/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(body),
      });

      if (!response.ok) {
        throw await providerHttpError("openai", response);
      }

      const data = (await response.json()) as OpenAiChatResponse;
      const text = data.choices?.[0]?.message?.content;
      if (typeof text !== "string") {
        throw new ProviderError("openai response did not include message content");
      }

      return { text, provider: "openai", model };
    },
  };
}
