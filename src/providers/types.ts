export interface AiMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface CompletionRequest {
  messages: AiMessage[];
  maxTokens?: number;
  temperature?: number;
}

export interface CompletionResult {
  text: string;
  provider: string;
  model: string;
}

export interface AiProvider {
  readonly name: string;
  readonly model: string;
  complete(request: CompletionRequest): Promise<CompletionResult>;
}

export type AiProviderName = "openai" | "anthropic" | "ollama" | "fake";

export interface AiSettings {
  provider: AiProviderName;
  model: string;
  baseUrl?: string;
}

/**
 * A fetch-compatible function signature, so provider factories can accept an
 * injected implementation for tests instead of always hitting the network.
 */
export type FetchImpl = typeof fetch;

export class ProviderError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "ProviderError";
  }
}
