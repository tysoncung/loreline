# Evaluation suite

Loreline ships an evaluation suite under `test/evals/` that checks the
quality and safety of AI-generated interview questions and the context sent
to an AI provider. It is separate from the unit tests in intent (it exercises
end-to-end behavior against a small synthetic repository) but runs the same
way: every eval is a `node:test` test, so it is deterministic, offline by
default, and included in `npm test`.

## What each eval checks

All evals run against `test/fixtures/eval-repo/`, a tiny synthetic repository
copied into a temp directory for each run. `secrets-excluded/` is listed in
its `loreline.yaml` `scan.exclude`, and `secrets-excluded/creds.txt` (a
planted fake credential) is written at test time only; it is never committed.

`test/evals/interview-quality.eval.test.ts`:

1. **Question non-duplication** - `generateQuestions` is given a scripted
   response containing an exact duplicate and a case-variant duplicate of
   the same question text. The accepted set must contain no case-insensitive
   duplicate question texts.
2. **Readiness-gap coverage** - `buildInterviewQuestions` is run on a scan of
   the eval repo. Every non-pass finding id that has a known question mapping
   must appear as some question's `sourceFinding`. Finding ids without a
   known mapping are documented (not enforced) in the recorded `details`.
3. **Grounding** - `generateQuestions` is given a scripted response
   containing one question grounded in a real finding and one referencing an
   unknown finding id. The ungrounded question must be dropped, and every
   accepted question's `sourceFinding` must exist in the report.
4. **Contradiction preservation** - two interview records (driven through
   `conductInterview`) answer the same question id with contradicting text.
   `compileWithAi`'s proposal must list the conflict under "Unresolved and
   conflicting" regardless of what the model itself reports. A third
   interview, driven with a scripted provider, must also produce a
   `contradiction-*` entry with category `contradiction` directly in the
   interview record.
5. **Grounding spot-check (model-graded)** - the only eval that calls a real
   AI provider. Skipped unless `LORELINE_EVAL_PROVIDER` is set (see below).

`test/evals/context-quality.eval.test.ts`:

6. **Excluded-content leakage (hard failure)** - evidence is selected the
   same way `loreline interview --ai` selects it (files cited by non-pass
   findings), previewed, approved, and sent to a scripted provider. The
   planted token and every line of `secrets-excluded/creds.txt` must appear
   in none of the recorded provider requests.
7. **Secret leakage (hard failure)** - an interview answer contains the
   planted high-severity token. `compileWithAi` must abort before making any
   provider request and before writing any proposal artifact, so no proposal
   file can contain the token. `redactSecrets` must independently strip the
   same token from a transmission-shaped excerpt.

## Release thresholds

- **Excluded-content leakage or secret leakage failing is a hard release
  blocker.** These evals exist specifically to prove that content outside a
  configured scan scope, and planted secrets, never reach a network request
  or a written artifact. Do not release with either eval failing.
- A failure in question non-duplication, readiness-gap coverage, grounding,
  or contradiction preservation is a regression to investigate before
  release, not necessarily a hard block: read the recorded `details` for the
  failing run and confirm whether the underlying behavior actually changed
  or the eval's fixture assumptions need updating.
- The model-graded grounding spot-check is informational. It is skipped by
  default and depends on a live provider's output, so treat a failure as a
  prompt to look closer, not an automatic blocker.

## How to run

```sh
npm test        # runs every test, including the evaluation suite
npm run eval    # runs only test/evals/*.eval.test.ts
```

Every eval appends one JSON line to `test/evals/results/results.jsonl`
(gitignored, created on demand) shaped as:

```json
{
  "eval": "question-non-duplication",
  "provider": "fake",
  "model": "eval-model",
  "promptVersion": "interview-v1",
  "pass": true,
  "details": "accepted 1 question(s) from 3 scripted duplicates ...",
  "recordedAt": "2026-09-01T00:00:00.000Z"
}
```

`provider`/`model`/`promptVersion` record what actually ran (`fake` and a
scripted model name for the deterministic evals; the real provider and model,
and `PROMPT_VERSION/COMPILE_PROMPT_VERSION`, for the model-graded eval), so a
prompt version bump's effect on eval outcomes stays traceable over time.

## Enabling the model-graded eval locally

The grounding spot-check is skipped by default (`t.skip()`) so CI stays
offline and deterministic. To run it locally, set `LORELINE_EVAL_PROVIDER` to
one of `openai`, `anthropic`, or `ollama`, plus that provider's usual
credential environment variable (see the [AI providers](../README.md#ai-providers)
section of the README):

```sh
# OpenAI
LORELINE_EVAL_PROVIDER=openai OPENAI_API_KEY=sk-... npm run eval

# Anthropic
LORELINE_EVAL_PROVIDER=anthropic ANTHROPIC_API_KEY=sk-ant-... npm run eval

# Ollama (local server, no API key)
LORELINE_EVAL_PROVIDER=ollama npm run eval
```

`LORELINE_EVAL_MODEL` overrides the default model used for the chosen
provider (`gpt-4o-mini` for openai and `llama3.1` for ollama), and is
required for anthropic, which has no bundled default. The eval makes one
real network call to the configured provider and records its result like
any other eval.
