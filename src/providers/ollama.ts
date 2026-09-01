import { providerHttpError } from "./http.js";
import type { AiProvider, AiSettings, CompletionRequest, CompletionResult, FetchImpl } from "./types.js";
import { ProviderError } from "./types.js";

const DEFAULT_BASE_URL = "http://localhost:11434";

interface OllamaChatResponse {
  message?: { content?: string };
}

export function createOllamaProvider(
  settings: AiSettings,
  _env: NodeJS.ProcessEnv,
  fetchImpl: FetchImpl = globalThis.fetch,
): AiProvider {
  const baseUrl = settings.baseUrl ?? DEFAULT_BASE_URL;
  const model = settings.model;

  return {
    name: "ollama",
    model,
    async complete(request: CompletionRequest): Promise<CompletionResult> {
      let response: Response;
      try {
        response = await fetchImpl(`${baseUrl}/api/chat`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            model,
            messages: request.messages,
            stream: false,
          }),
        });
      } catch (error) {
        if (isConnectionRefused(error)) {
          throw new ProviderError(
            `could not reach Ollama at ${baseUrl}. Is Ollama running?`,
            { cause: error },
          );
        }
        throw error;
      }

      if (!response.ok) {
        throw await providerHttpError("ollama", response);
      }

      const data = (await response.json()) as OllamaChatResponse;
      const text = data.message?.content;
      if (typeof text !== "string") {
        throw new ProviderError("ollama response did not include message content");
      }

      return { text, provider: "ollama", model };
    },
  };
}

function isConnectionRefused(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  if (error instanceof TypeError) {
    return true;
  }
  const cause = (error as { cause?: unknown }).cause;
  if (cause && typeof cause === "object" && "code" in cause) {
    return (cause as { code?: unknown }).code === "ECONNREFUSED";
  }
  return false;
}
