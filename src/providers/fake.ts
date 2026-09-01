import type { AiProvider, AiSettings, CompletionRequest, CompletionResult } from "./types.js";
import { ProviderError } from "./types.js";

const FAKE_RESPONSES_ENV_VAR = "LORELINE_FAKE_RESPONSES";

/**
 * A scripted provider for tests: cycles through a fixed list of responses
 * and records every request it receives so assertions can inspect what was
 * asked of it, without ever touching the network.
 */
export class FakeProvider implements AiProvider {
  readonly name = "fake";
  readonly model: string;
  readonly requests: CompletionRequest[] = [];
  private readonly responses: string[];
  private index = 0;

  constructor(responses: string[], model = "fake") {
    if (responses.length === 0) {
      throw new ProviderError("fake provider requires at least one scripted response");
    }
    this.responses = responses;
    this.model = model;
  }

  async complete(request: CompletionRequest): Promise<CompletionResult> {
    this.requests.push(request);
    const text = this.responses[this.index % this.responses.length];
    this.index += 1;
    return { text: text ?? "", provider: this.name, model: this.model };
  }
}

/**
 * Builds a FakeProvider from scripted responses stored in the
 * LORELINE_FAKE_RESPONSES environment variable (a JSON array of strings),
 * so CLI-level tests can drive AI-dependent commands offline.
 */
export function createFakeProvider(settings: AiSettings, env: NodeJS.ProcessEnv): AiProvider {
  const raw = env[FAKE_RESPONSES_ENV_VAR];
  if (!raw) {
    throw new ProviderError(
      `missing scripted responses; set ${FAKE_RESPONSES_ENV_VAR} to a JSON array of strings`,
    );
  }

  const responses = parseResponses(raw);
  return new FakeProvider(responses, settings.model);
}

function parseResponses(raw: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ProviderError(
      `invalid ${FAKE_RESPONSES_ENV_VAR}; expected a JSON array of strings`,
    );
  }

  if (!Array.isArray(parsed) || !parsed.every((item) => typeof item === "string")) {
    throw new ProviderError(
      `invalid ${FAKE_RESPONSES_ENV_VAR}; expected a JSON array of strings`,
    );
  }

  return parsed;
}
