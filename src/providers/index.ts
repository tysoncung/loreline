import type { LorelineConfig } from "../types.js";
import { createAnthropicProvider } from "./anthropic.js";
import { createFakeProvider } from "./fake.js";
import { createOllamaProvider } from "./ollama.js";
import { createOpenAiProvider } from "./openai.js";
import type { AiProvider, AiProviderName, AiSettings } from "./types.js";
import { ProviderError } from "./types.js";

export * from "./types.js";
export { FakeProvider, createFakeProvider } from "./fake.js";
export { createAnthropicProvider } from "./anthropic.js";
export { createOllamaProvider } from "./ollama.js";
export { createOpenAiProvider } from "./openai.js";

const PROVIDER_NAMES: readonly AiProviderName[] = ["openai", "anthropic", "ollama", "fake"];

export interface AiFlags {
  provider?: string;
  model?: string;
  baseUrl?: string;
}

/**
 * Resolves the AI settings to use for a command, merging `--provider`,
 * `--model`, and `--baseUrl` flags over the `ai` block in loreline.yaml,
 * field by field. Flags win when present; otherwise the config value is
 * used.
 */
export function resolveAiSettings(config: LorelineConfig, flags: AiFlags): AiSettings {
  const providerValue = flags.provider ?? config.ai?.provider;
  if (!providerValue) {
    throw new Error("no AI provider configured; set ai in loreline.yaml or pass --provider");
  }
  if (!isAiProviderName(providerValue)) {
    throw new ProviderError(
      `invalid AI provider "${providerValue}"; valid values are ${PROVIDER_NAMES.join(", ")}`,
    );
  }

  const model = flags.model ?? config.ai?.model;
  if (!model) {
    throw new ProviderError(
      `no AI model configured for provider "${providerValue}"; set ai.model in loreline.yaml or pass --model`,
    );
  }

  const baseUrl = flags.baseUrl ?? config.ai?.baseUrl;
  return baseUrl !== undefined
    ? { provider: providerValue, model, baseUrl }
    : { provider: providerValue, model };
}

/**
 * Builds the concrete provider for the resolved settings. Production
 * callers pass no fetch implementation, so each provider defaults to the
 * global fetch; tests reach the individual `create*Provider` factories
 * directly to inject a stub.
 */
export function createProvider(settings: AiSettings, env: NodeJS.ProcessEnv): AiProvider {
  switch (settings.provider) {
    case "openai":
      return createOpenAiProvider(settings, env);
    case "anthropic":
      return createAnthropicProvider(settings, env);
    case "ollama":
      return createOllamaProvider(settings, env);
    case "fake":
      return createFakeProvider(settings, env);
    default: {
      const exhaustive: never = settings.provider;
      throw new ProviderError(`unsupported AI provider "${String(exhaustive)}"`);
    }
  }
}

function isAiProviderName(value: string): value is AiProviderName {
  return (PROVIDER_NAMES as readonly string[]).includes(value);
}
