import { appendFile, cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createProvider } from "../../src/providers/index.js";
import type { AiProvider, AiProviderName } from "../../src/providers/types.js";
import type { InterviewScope } from "../../src/scope.js";
import type { ReadinessReport } from "../../src/types.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_SOURCE = path.join(HERE, "..", "fixtures", "eval-repo");
const RESULTS_DIR = path.join(HERE, "results");
const RESULTS_FILE = path.join(RESULTS_DIR, "results.jsonl");

// A fake, unmistakably-planted GitHub-token-shaped credential, built by
// string concatenation so it never appears as a literal secret-shaped
// substring in this source file. It matches secrets.ts's "github-token"
// high-confidence rule, so it is exactly the kind of content the evaluation
// suite must prove never leaves the machine.
export const PLANTED_TOKEN = "ghp_" + "eval".repeat(9) + "1234";

export interface EvalRepo {
  root: string;
  cleanup: () => Promise<void>;
}

/**
 * Copies the committed test/fixtures/eval-repo/ tree into a fresh temp
 * directory and writes the planted-token fixture file into
 * secrets-excluded/, which loreline.yaml (also copied) lists in
 * scan.exclude. The planted file is never committed to the repository; it
 * exists only for the lifetime of one eval run.
 */
export async function setupEvalRepo(): Promise<EvalRepo> {
  const root = await mkdtemp(path.join(tmpdir(), "loreline-eval-repo-"));
  await cp(FIXTURE_SOURCE, root, { recursive: true });

  const secretsDir = path.join(root, "secrets-excluded");
  await mkdir(secretsDir, { recursive: true });
  await writeFile(
    path.join(secretsDir, "creds.txt"),
    "# Planted fake credential for the excluded-content leakage eval.\n" +
      "# This directory is listed in loreline.yaml's scan.exclude, so a\n" +
      "# correct scan never reads this file at all.\n" +
      "deploy_token=" +
      PLANTED_TOKEN +
      "\n",
  );

  return {
    root,
    cleanup: async () => {
      await rm(root, { recursive: true, force: true });
    },
  };
}

export interface EvalResultRecord {
  eval: string;
  provider: string;
  model: string;
  promptVersion: string;
  pass: boolean;
  details: string;
}

/** Appends one JSON line describing an eval run to test/evals/results/results.jsonl (gitignored). */
export async function recordEvalResult(result: EvalResultRecord): Promise<void> {
  await mkdir(RESULTS_DIR, { recursive: true });
  const line = JSON.stringify({ ...result, recordedAt: new Date().toISOString() });
  await appendFile(RESULTS_FILE, `${line}\n`);
}

/**
 * Runs one eval body, recording exactly one result line whether it passes or
 * throws. `body` returns the human-readable `details` string to record on
 * success; on failure the thrown error's message is recorded instead and the
 * error is rethrown so node:test still reports the eval as failed.
 */
export async function withEvalResult(
  meta: { eval: string; provider: string; model: string; promptVersion: string },
  body: () => Promise<string>,
): Promise<void> {
  let pass = false;
  let details = "";
  try {
    details = await body();
    pass = true;
  } catch (error) {
    details = error instanceof Error ? error.message : String(error);
    throw error;
  } finally {
    await recordEvalResult({ ...meta, pass, details });
  }
}

const REAL_PROVIDER_NAMES: readonly AiProviderName[] = ["openai", "anthropic", "ollama"];
const DEFAULT_EVAL_MODELS: Record<(typeof REAL_PROVIDER_NAMES)[number], string> = {
  openai: "gpt-4o-mini",
  anthropic: "claude-3-5-haiku-20241022",
  ollama: "llama3.1",
};

/**
 * Builds a real AI provider from LORELINE_EVAL_PROVIDER (openai | anthropic |
 * ollama) and the provider's usual credential env vars, so the one
 * model-graded eval can opt in locally. Returns undefined (never throws) when
 * LORELINE_EVAL_PROVIDER is unset, which is the default in CI: the
 * model-graded test calls t.skip() in that case. LORELINE_EVAL_MODEL
 * overrides the default model per provider.
 */
export function maybeRealProvider(): AiProvider | undefined {
  const providerName = process.env.LORELINE_EVAL_PROVIDER;
  if (!providerName) {
    return undefined;
  }
  if (!(REAL_PROVIDER_NAMES as readonly string[]).includes(providerName)) {
    throw new Error(
      `LORELINE_EVAL_PROVIDER must be one of ${REAL_PROVIDER_NAMES.join(", ")}; got "${providerName}"`,
    );
  }
  const name = providerName as (typeof REAL_PROVIDER_NAMES)[number];
  const model = process.env.LORELINE_EVAL_MODEL ?? DEFAULT_EVAL_MODELS[name];
  return createProvider({ provider: name, model }, process.env);
}

// Mirrors the private selectEvidenceFiles() in src/cli.ts: up to `limit`
// distinct files cited by non-pass findings, honoring scope.findings when
// present. Kept here (rather than exported from cli.ts) so the eval suite
// exercises the same selection a real `loreline interview --ai` run would
// make, without changing the CLI's public surface.
export function selectEvidenceFiles(
  report: ReadinessReport,
  scope: InterviewScope | undefined,
  limit: number,
): string[] {
  const findings = report.findings
    .filter((finding) => finding.status !== "pass")
    .filter((finding) => !scope?.findings || scope.findings.includes(finding.id));

  const files = new Set<string>();
  outer: for (const finding of findings) {
    for (const citation of finding.citations ?? []) {
      if (files.size >= limit) {
        break outer;
      }
      files.add(citation.file);
    }
  }
  return [...files];
}
