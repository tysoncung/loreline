import assert from "node:assert/strict";
import test from "node:test";
import type { LorelineConfig } from "../src/types.js";
import { validateArtifact } from "../src/validation.js";
import { createAnthropicProvider } from "../src/providers/anthropic.js";
import { createFakeProvider, FakeProvider } from "../src/providers/fake.js";
import { createOllamaProvider } from "../src/providers/ollama.js";
import { createOpenAiProvider } from "../src/providers/openai.js";
import { createProvider, resolveAiSettings } from "../src/providers/index.js";
import { ProviderError } from "../src/providers/types.js";
import type { CompletionRequest } from "../src/providers/types.js";

function baseConfig(overrides: Partial<LorelineConfig> = {}): LorelineConfig {
  return {
    schemaVersion: 1,
    project: { name: "payments", owner: "platform-team" },
    scan: { include: ["**/*"], exclude: [], maxFiles: 10000 },
    output: { directory: ".loreline" },
    ...overrides,
  };
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

// ---------------------------------------------------------------------------
// FakeProvider
// ---------------------------------------------------------------------------

test("FakeProvider cycles scripted responses and records requests", async () => {
  const provider = new FakeProvider(["first", "second"]);
  const request: CompletionRequest = { messages: [{ role: "user", content: "hi" }] };

  const first = await provider.complete(request);
  const second = await provider.complete(request);
  const third = await provider.complete(request);

  assert.equal(first.text, "first");
  assert.equal(second.text, "second");
  assert.equal(third.text, "first");
  assert.equal(provider.requests.length, 3);
  assert.deepEqual(provider.requests[0], request);
});

test("FakeProvider rejects an empty scripted response list", () => {
  assert.throws(() => new FakeProvider([]), ProviderError);
});

test("createFakeProvider reads scripted responses from LORELINE_FAKE_RESPONSES", async () => {
  const provider = createProvider(
    { provider: "fake", model: "fake-model" },
    { LORELINE_FAKE_RESPONSES: JSON.stringify(["scripted answer"]) } as NodeJS.ProcessEnv,
  );

  const result = await provider.complete({ messages: [{ role: "user", content: "hi" }] });
  assert.equal(result.text, "scripted answer");
  assert.equal(result.provider, "fake");
  assert.equal(result.model, "fake-model");
});

test("createFakeProvider errors when LORELINE_FAKE_RESPONSES is missing", () => {
  assert.throws(
    () => createProvider({ provider: "fake", model: "fake-model" }, {} as NodeJS.ProcessEnv),
    (error: unknown) => {
      assert.ok(error instanceof ProviderError);
      assert.match(error.message, /LORELINE_FAKE_RESPONSES/);
      return true;
    },
  );
});

test("createFakeProvider errors when LORELINE_FAKE_RESPONSES is invalid JSON", () => {
  assert.throws(
    () =>
      createProvider(
        { provider: "fake", model: "fake-model" },
        { LORELINE_FAKE_RESPONSES: "not json" } as NodeJS.ProcessEnv,
      ),
    (error: unknown) => {
      assert.ok(error instanceof ProviderError);
      assert.match(error.message, /LORELINE_FAKE_RESPONSES/);
      return true;
    },
  );
});

test("createFakeProvider errors when LORELINE_FAKE_RESPONSES is not an array of strings", () => {
  assert.throws(
    () =>
      createProvider(
        { provider: "fake", model: "fake-model" },
        { LORELINE_FAKE_RESPONSES: JSON.stringify([1, 2, 3]) } as NodeJS.ProcessEnv,
      ),
    (error: unknown) => {
      assert.ok(error instanceof ProviderError);
      assert.match(error.message, /LORELINE_FAKE_RESPONSES/);
      return true;
    },
  );
});

// ---------------------------------------------------------------------------
// resolveAiSettings
// ---------------------------------------------------------------------------

test("resolveAiSettings prefers flags over config.ai field-by-field", () => {
  const config = baseConfig({
    ai: { provider: "openai", model: "gpt-4o-mini", baseUrl: "https://config.example" },
  });

  const settings = resolveAiSettings(config, {
    provider: "anthropic",
    model: "claude-3",
  });

  assert.deepEqual(settings, {
    provider: "anthropic",
    model: "claude-3",
    baseUrl: "https://config.example",
  });
});

test("resolveAiSettings falls back to config.ai when flags are absent", () => {
  const config = baseConfig({
    ai: { provider: "ollama", model: "llama3" },
  });

  const settings = resolveAiSettings(config, {});
  assert.deepEqual(settings, { provider: "ollama", model: "llama3" });
});

test("resolveAiSettings errors when no provider is configured anywhere", () => {
  const config = baseConfig();
  assert.throws(
    () => resolveAiSettings(config, {}),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal(
        error.message,
        "no AI provider configured; set ai in loreline.yaml or pass --provider",
      );
      return true;
    },
  );
});

test("resolveAiSettings errors on an invalid provider value", () => {
  const config = baseConfig();
  assert.throws(
    () => resolveAiSettings(config, { provider: "not-a-real-provider", model: "x" }),
    (error: unknown) => {
      assert.ok(error instanceof ProviderError);
      assert.match(error.message, /openai/);
      assert.match(error.message, /anthropic/);
      assert.match(error.message, /ollama/);
      assert.match(error.message, /fake/);
      return true;
    },
  );
});

test("resolveAiSettings errors when a provider resolves but no model is configured anywhere", () => {
  const config = baseConfig();
  assert.throws(
    () => resolveAiSettings(config, { provider: "openai" }),
    (error: unknown) => {
      assert.ok(error instanceof ProviderError);
      assert.match(error.message, /model/i);
      assert.match(error.message, /openai/);
      return true;
    },
  );
});

// ---------------------------------------------------------------------------
// OpenAI provider
// ---------------------------------------------------------------------------

test("createOpenAiProvider throws a ProviderError naming both env vars when the key is missing", () => {
  assert.throws(
    () => createOpenAiProvider({ provider: "openai", model: "gpt-4o-mini" }, {} as NodeJS.ProcessEnv),
    (error: unknown) => {
      assert.ok(error instanceof ProviderError);
      assert.match(error.message, /OPENAI_API_KEY/);
      assert.match(error.message, /LORELINE_API_KEY/);
      return true;
    },
  );
});

test("createOpenAiProvider posts chat completions and parses the response", async () => {
  const secretKey = "sk-super-secret-value-should-never-leak";
  let capturedUrl = "";
  let capturedInit: RequestInit | undefined;

  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    capturedUrl = String(url);
    capturedInit = init;
    return jsonResponse(200, {
      choices: [{ message: { content: "hello from openai" } }],
    });
  }) as typeof fetch;

  const provider = createOpenAiProvider(
    { provider: "openai", model: "gpt-4o-mini" },
    { OPENAI_API_KEY: secretKey } as NodeJS.ProcessEnv,
    fetchImpl,
  );

  const result = await provider.complete({ messages: [{ role: "user", content: "hi" }] });

  assert.equal(result.text, "hello from openai");
  assert.equal(result.provider, "openai");
  assert.equal(result.model, "gpt-4o-mini");
  assert.equal(capturedUrl, "https://api.openai.com/v1/chat/completions");

  const headers = new Headers(capturedInit?.headers);
  assert.equal(headers.get("authorization"), `Bearer ${secretKey}`);

  const body = JSON.parse(String(capturedInit?.body)) as {
    model: string;
    messages: unknown;
  };
  assert.equal(body.model, "gpt-4o-mini");
  assert.deepEqual(body.messages, [{ role: "user", content: "hi" }]);
});

test("createOpenAiProvider respects a custom baseUrl", async () => {
  let capturedUrl = "";
  const fetchImpl = (async (url: string | URL) => {
    capturedUrl = String(url);
    return jsonResponse(200, { choices: [{ message: { content: "ok" } }] });
  }) as typeof fetch;

  const provider = createOpenAiProvider(
    { provider: "openai", model: "gpt-4o-mini", baseUrl: "https://proxy.example" },
    { OPENAI_API_KEY: "key" } as NodeJS.ProcessEnv,
    fetchImpl,
  );
  await provider.complete({ messages: [{ role: "user", content: "hi" }] });
  assert.equal(capturedUrl, "https://proxy.example/v1/chat/completions");
});

test("createOpenAiProvider surfaces a non-2xx response as an actionable ProviderError without leaking the key", async () => {
  const secretKey = "sk-should-not-appear-anywhere";
  const fetchImpl = (async () =>
    jsonResponse(401, { error: { message: "Incorrect API key provided" } })) as typeof fetch;

  const provider = createOpenAiProvider(
    { provider: "openai", model: "gpt-4o-mini" },
    { OPENAI_API_KEY: secretKey } as NodeJS.ProcessEnv,
    fetchImpl,
  );

  await assert.rejects(
    provider.complete({ messages: [{ role: "user", content: "hi" }] }),
    (error: unknown) => {
      assert.ok(error instanceof ProviderError);
      assert.match(error.message, /401/);
      assert.match(error.message, /Incorrect API key provided/);
      assert.ok(!error.message.includes(secretKey));
      return true;
    },
  );
});

// ---------------------------------------------------------------------------
// Anthropic provider
// ---------------------------------------------------------------------------

test("createAnthropicProvider throws a ProviderError naming both env vars when the key is missing", () => {
  assert.throws(
    () =>
      createAnthropicProvider({ provider: "anthropic", model: "claude-3-haiku" }, {} as NodeJS.ProcessEnv),
    (error: unknown) => {
      assert.ok(error instanceof ProviderError);
      assert.match(error.message, /ANTHROPIC_API_KEY/);
      assert.match(error.message, /LORELINE_API_KEY/);
      return true;
    },
  );
});

test("createAnthropicProvider joins system messages, defaults maxTokens, and parses the response", async () => {
  const secretKey = "anthropic-secret-value";
  let capturedUrl = "";
  let capturedInit: RequestInit | undefined;

  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    capturedUrl = String(url);
    capturedInit = init;
    return jsonResponse(200, { content: [{ text: "hello from anthropic" }] });
  }) as typeof fetch;

  const provider = createAnthropicProvider(
    { provider: "anthropic", model: "claude-3-haiku" },
    { ANTHROPIC_API_KEY: secretKey } as NodeJS.ProcessEnv,
    fetchImpl,
  );

  const result = await provider.complete({
    messages: [
      { role: "system", content: "You are terse." },
      { role: "system", content: "Never rhyme." },
      { role: "user", content: "hi" },
    ],
  });

  assert.equal(result.text, "hello from anthropic");
  assert.equal(capturedUrl, "https://api.anthropic.com/v1/messages");

  const headers = new Headers(capturedInit?.headers);
  assert.equal(headers.get("x-api-key"), secretKey);
  assert.equal(headers.get("anthropic-version"), "2023-06-01");

  const body = JSON.parse(String(capturedInit?.body)) as {
    system?: string;
    max_tokens: number;
    messages: unknown;
  };
  assert.equal(body.system, "You are terse.\n\nNever rhyme.");
  assert.equal(body.max_tokens, 1024);
  assert.deepEqual(body.messages, [{ role: "user", content: "hi" }]);
});

test("createAnthropicProvider uses an explicit maxTokens when provided", async () => {
  const fetchImpl = (async (_url: string | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { max_tokens: number };
    assert.equal(body.max_tokens, 42);
    return jsonResponse(200, { content: [{ text: "ok" }] });
  }) as typeof fetch;

  const provider = createAnthropicProvider(
    { provider: "anthropic", model: "claude-3-haiku" },
    { ANTHROPIC_API_KEY: "key" } as NodeJS.ProcessEnv,
    fetchImpl,
  );
  await provider.complete({ messages: [{ role: "user", content: "hi" }], maxTokens: 42 });
});

test("createAnthropicProvider surfaces a non-2xx response as an actionable ProviderError without leaking the key", async () => {
  const secretKey = "anthropic-should-not-leak";
  const fetchImpl = (async () =>
    jsonResponse(429, { error: { type: "rate_limit_error", message: "Rate limited" } })) as typeof fetch;

  const provider = createAnthropicProvider(
    { provider: "anthropic", model: "claude-3-haiku" },
    { ANTHROPIC_API_KEY: secretKey } as NodeJS.ProcessEnv,
    fetchImpl,
  );

  await assert.rejects(
    provider.complete({ messages: [{ role: "user", content: "hi" }] }),
    (error: unknown) => {
      assert.ok(error instanceof ProviderError);
      assert.match(error.message, /429/);
      assert.match(error.message, /Rate limited/);
      assert.ok(!error.message.includes(secretKey));
      return true;
    },
  );
});

// ---------------------------------------------------------------------------
// Ollama provider
// ---------------------------------------------------------------------------

test("createOllamaProvider posts to /api/chat with no auth header and parses the response", async () => {
  let capturedUrl = "";
  let capturedInit: RequestInit | undefined;

  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    capturedUrl = String(url);
    capturedInit = init;
    return jsonResponse(200, { message: { content: "hello from ollama" } });
  }) as typeof fetch;

  const provider = createOllamaProvider(
    { provider: "ollama", model: "llama3" },
    {} as NodeJS.ProcessEnv,
    fetchImpl,
  );

  const result = await provider.complete({ messages: [{ role: "user", content: "hi" }] });

  assert.equal(result.text, "hello from ollama");
  assert.equal(capturedUrl, "http://localhost:11434/api/chat");

  const headers = new Headers(capturedInit?.headers);
  assert.equal(headers.get("authorization"), null);

  const body = JSON.parse(String(capturedInit?.body)) as {
    model: string;
    stream: boolean;
  };
  assert.equal(body.model, "llama3");
  assert.equal(body.stream, false);
});

test("createOllamaProvider surfaces a connection-refused failure with guidance to start Ollama", async () => {
  const fetchImpl = (async () => {
    const cause = Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:11434"), {
      code: "ECONNREFUSED",
    });
    throw new TypeError("fetch failed", { cause });
  }) as typeof fetch;

  const provider = createOllamaProvider(
    { provider: "ollama", model: "llama3" },
    {} as NodeJS.ProcessEnv,
    fetchImpl,
  );

  await assert.rejects(
    provider.complete({ messages: [{ role: "user", content: "hi" }] }),
    (error: unknown) => {
      assert.ok(error instanceof ProviderError);
      assert.match(error.message, /Is Ollama running\?/);
      return true;
    },
  );
});

test("createOllamaProvider surfaces a non-2xx response as an actionable ProviderError", async () => {
  const fetchImpl = (async () => jsonResponse(500, { error: "model not found" })) as typeof fetch;

  const provider = createOllamaProvider(
    { provider: "ollama", model: "does-not-exist" },
    {} as NodeJS.ProcessEnv,
    fetchImpl,
  );

  await assert.rejects(
    provider.complete({ messages: [{ role: "user", content: "hi" }] }),
    (error: unknown) => {
      assert.ok(error instanceof ProviderError);
      assert.match(error.message, /500/);
      return true;
    },
  );
});

// ---------------------------------------------------------------------------
// Config v2 with an ai block
// ---------------------------------------------------------------------------

test("config v2 with an ai block validates", async () => {
  const value = {
    schemaVersion: 2,
    project: { name: "payments", owner: "platform-team" },
    scan: { include: ["**/*"], exclude: [], maxFiles: 10000 },
    output: { directory: ".loreline" },
    ai: { provider: "openai", model: "gpt-4o-mini", baseUrl: "https://proxy.example" },
  };

  const result = await validateArtifact<LorelineConfig>("config", value, "config-v2.json");
  assert.deepEqual(result, value);
});

test("config v2 without an ai block still validates", async () => {
  const value = {
    schemaVersion: 2,
    project: { name: "payments", owner: "platform-team" },
    scan: { include: ["**/*"], exclude: [], maxFiles: 10000 },
    output: { directory: ".loreline" },
  };

  const result = await validateArtifact<LorelineConfig>("config", value, "config-v2-no-ai.json");
  assert.deepEqual(result, value);
});

test("config v1 still loads", async () => {
  const value = {
    schemaVersion: 1,
    project: { name: "payments", owner: "platform-team" },
    scan: { include: ["**/*"], exclude: [], maxFiles: 10000 },
    output: { directory: ".loreline" },
  };

  const result = await validateArtifact<LorelineConfig>("config", value, "config-v1.json");
  assert.deepEqual(result, value);
});

test("config v2 rejects an ai block with an unknown provider", async () => {
  const value = {
    schemaVersion: 2,
    project: { name: "payments", owner: "platform-team" },
    scan: { include: ["**/*"], exclude: [], maxFiles: 10000 },
    output: { directory: ".loreline" },
    ai: { provider: "not-a-provider", model: "gpt-4o-mini" },
  };

  await assert.rejects(validateArtifact("config", value, "config-v2-bad-ai.json"));
});

test("config v2 rejects an ai block with a credential-like field", async () => {
  const value = {
    schemaVersion: 2,
    project: { name: "payments", owner: "platform-team" },
    scan: { include: ["**/*"], exclude: [], maxFiles: 10000 },
    output: { directory: ".loreline" },
    ai: { provider: "openai", model: "gpt-4o-mini", apiKey: "sk-should-not-be-here" },
  };

  await assert.rejects(validateArtifact("config", value, "config-v2-key-in-ai.json"));
});
