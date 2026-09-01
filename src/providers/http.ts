import { ProviderError } from "./types.js";

const MAX_ERROR_BODY_LENGTH = 200;

/**
 * Extracts a human-readable message from a failed HTTP response body.
 * Providers agree on the `{ error: { message } }` shape (openai, anthropic,
 * and ollama all nest their error message the same way); anything else
 * falls back to the raw body text, truncated so a large HTML error page
 * never blows up an error message.
 */
export async function readErrorMessage(response: Response): Promise<string> {
  const text = await response.text();
  try {
    const parsed = JSON.parse(text) as { error?: { message?: string } };
    if (parsed.error && typeof parsed.error.message === "string") {
      return parsed.error.message;
    }
  } catch {
    // Not JSON; fall through to the truncated plain text below.
  }
  return text.length > MAX_ERROR_BODY_LENGTH
    ? `${text.slice(0, MAX_ERROR_BODY_LENGTH)}...`
    : text;
}

export async function providerHttpError(
  provider: string,
  response: Response,
): Promise<ProviderError> {
  const detail = await readErrorMessage(response);
  const suffix = detail ? `: ${detail}` : "";
  return new ProviderError(
    `${provider} request failed with status ${response.status}${suffix}`,
  );
}
