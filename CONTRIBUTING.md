# Contributing to Loreline

Thanks for your interest in improving Loreline. This guide covers how to set up your development environment, how the codebase is organized, and what we expect from a pull request.

## Development setup

Loreline requires Node.js 20 or newer.

```bash
npm install
npm run dev -- scan --path .
npm test
npm run typecheck
npm run build
```

- `npm run dev` runs the CLI directly from TypeScript source with `tsx`, useful while iterating.
- `npm test` runs the test suite under Node's built-in test runner.
- `npm run typecheck` runs `tsc --noEmit` and must be clean.
- `npm run build` compiles `src/` to `dist/` and is what `npm publish` uses via `prepack`.

## Architecture tour

Loreline is a small, local-first CLI. Each module in `src/` has a single responsibility:

- **`src/cli.ts`** dispatches the `init`, `scan`, `interview`, `compile`, and `verify` commands to their handlers and parses command-line flags.
- **`src/config.ts`** loads and initializes `loreline.yaml`, the project configuration that controls scan scope and output location.
- **`src/scanner.ts`** runs the repository readiness scan and produces the readiness report (`readiness.json` and `readiness.md`).
- **`src/interview.ts`** builds interview questions from readiness gaps and drives the interview flow, recording answers with their category, rationale, and triggering finding.
- **`src/knowledge.ts`** compiles answered interviews into reusable context (`context.md`, `context.json`) and verifies knowledge quality (`verification.json`).
- **`src/validation.ts`** validates every artifact Loreline reads or writes against the packaged JSON Schemas in `schemas/v1/`, using ajv.
- **`src/types.ts`** holds the shared TypeScript types for artifacts and internal data structures used across the other modules.

### Schema policy

Every machine-readable artifact (config, readiness, interview, context, verification) is validated against a schema in `schemas/v1/`. These schemas are strict: `additionalProperties` is `false`, so an unrecognized field fails validation rather than being silently ignored.

This means:

- Adding a field to an artifact requires a new versioned schema directory (for example `schemas/v2/`), not an edit to the existing one.
- Code that reads artifacts routes by the artifact's `schemaVersion` field to select the matching schema and types.
- Version 1 artifacts remain supported going forward; a new schema version adds support rather than replacing what came before.

See the "Artifact schemas and compatibility" section in the README for the user-facing description of this policy.

## Tests

Loreline follows test-driven development: every change should come with tests that cover it, whether that is a new readiness check, an interview behavior, a schema validation rule, or a bug fix. Add or update tests in `test/` alongside your change rather than as a follow-up.

## Pull requests

- Keep pull requests small and focused on one change.
- Reference the issue your PR addresses (for example, `refs #17`).
- Make sure `npm test` and `npm run typecheck` both pass before requesting review.
- Fill out the PR template checklist; it covers tests, secrets, provenance, schema versioning, and docs.

## Release practice

Releases are published to npm from tagged commits on `main`. A release must preserve schema compatibility: existing artifact versions continue to validate, and any additive or breaking schema change ships as a new versioned schema directory rather than a change to an existing one.

## Security

If you find a security vulnerability, please do not open a public issue. See [SECURITY.md](SECURITY.md) for how to report it privately.

## Roadmap

Loreline's roadmap is tracked as GitHub milestones from v0.3.0 through v0.7.0, each with its own set of issues. Check the milestones and open issues before starting significant work, to avoid duplicating effort or going in a direction that has already been decided against.
