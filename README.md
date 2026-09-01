# Loreline

**Turn undocumented organizational knowledge into verified, AI-ready context.**

Loreline is a local-first CLI for assessing repositories, finding knowledge gaps, and conducting adaptive handoff interviews. It produces open Markdown and JSON artifacts that stay beside the work, ready for both people and AI agents.

## Quick start

Requires Node.js 20 or newer.

```bash
npx @tysoncung/loreline init
npx @tysoncung/loreline scan
npx @tysoncung/loreline interview --interviewee "Alex"
```

For local development:

```bash
npm install
npm run build
node dist/cli.js scan --path .
```

## What it does

### Assess AI readiness

```bash
loreline scan
```

Loreline checks for:

- A clear project overview
- Instructions for AI agents
- Explicit ownership
- Architecture and system boundaries
- Decision history
- Operations and troubleshooting knowledge
- Automated verification
- Concentration of knowledge in git history

It writes:

```text
.loreline/
  readiness.json
  readiness.md
```

Use a readiness threshold in CI:

```bash
loreline scan --fail-under 70
```

See [docs/github-actions.md](docs/github-actions.md) for an official GitHub Actions workflow you can copy directly into your repository.

#### Narrowing what gets scanned

`--include` and `--exclude` accept repeatable glob patterns (`**` crosses directories, `*` and `?` do not) and are merged with the patterns in `loreline.yaml`:

```bash
loreline scan --exclude "docs/**" --exclude "vendor/**"
loreline scan --include "src/**" --include "README.md"
```

Excluded files never appear in `filesScanned`, finding evidence, or citations. The readiness report only records a `scope` field when `--include` or `--exclude` was used; a scan with no scope flags produces the same artifact as today.

#### Git history and knowledge concentration

Every scan of a git repository also analyzes commit history to find areas where knowledge is concentrated in a single contributor. Loreline counts each commit once per area (the first path segment of the files it touched, or `(root)` for files at the repository root) per author, ignoring merge commits. Areas with at least 5 counted commits where one contributor authored more than 80% of them are flagged in the `knowledge-concentration` finding. This is a familiarity signal from commit-touch frequency, not a measure of code ownership, current expertise, or contribution quality, and analysis never leaves the machine.

Bot identities (any author name ending in `[bot]`) are always excluded. Exclude additional identities, such as your own alias or a former contributor, with a repeatable flag:

```bash
loreline scan --exclude-identity "dependabot" --exclude-identity "Alex Chen"
```

Skip history analysis entirely with `--no-history`. When history is unavailable (not a git repository, or git is missing) or fewer than 10 commits were analyzed, the finding falls back to `partial` with a recommendation to review contributor concentration manually. The readiness report only includes the top-level `history` summary field when history was available.

```bash
loreline scan --no-history
```

#### Scanning a document collection

`--mode documents` (default is `--mode repository`) assesses a documentation set instead of the whole project, judging documents on Markdown, MDX, plain text, reStructuredText, and AsciiDoc files (`.md`, `.mdx`, `.txt`, `.rst`, `.adoc`) discovered under `loreline.yaml`'s `scan.include`/`scan.exclude`:

```bash
loreline scan --mode documents --path docs
```

It checks for:

- Purpose: each document opens with an H1 heading or a frontmatter `title` within its first 5 lines
- Ownership: frontmatter `owner:` or `author:`
- Freshness: frontmatter `updated:`/`date:` (or, failing that, file modification time) within the last 365 days
- Structure: a `README.md` or `index.md` at the collection root
- Linkage: every document is reachable via a relative Markdown link from another document (root `README.md`/`index.md` count as entry points by default)
- Terminology: a glossary, terminology, or definitions document exists
- Operations: at least one runbook, procedure, process, policy, or escalation document exists with real content

Frontmatter is a leading `---`-delimited YAML block; a document with no such block, or one that fails to parse, is treated as having no frontmatter rather than failing the scan. Files that cannot be decoded as UTF-8 are listed in the report's `unreadable` field and excluded from every finding's coverage math and from `filesScanned`. Document mode never analyzes git history, even without `--no-history`.

### Capture knowledge before it leaves

```bash
loreline interview --interviewee "Alex Chen"
```

Interview questions adapt to gaps found by the readiness scan. Each answer records its category, why it was asked, and the readiness finding that triggered it.

For repeatable demos or integrations, answers can be supplied as JSON:

```bash
loreline interview \
  --interviewee "Alex Chen" \
  --answers ./answers.json
```

Knowledge records are stored as both Markdown and structured JSON under `.loreline/interviews/`.

#### Resuming an interview

Every interview run keeps an open session under `.loreline/sessions/`, saved after each accepted answer, so a dropped connection or an interrupted terminal does not lose earlier answers. Resume it with the session id printed at the start of the run:

```bash
loreline interview --resume 20260901143022-alex-chen
```

`--interviewee` is not required with `--resume`; it is taken from the session. Resuming skips questions that already have an answer and only asks the ones still outstanding.

To go back and change an answer that was already recorded, add `--revise`. The interviewer is re-asked every previously answered question, and each prior value is archived in that question's revision history rather than discarded:

```bash
loreline interview --resume 20260901143022-alex-chen --revise
```

`--answers` works the same way with `--resume`: any question the file does not cover falls back to the terminal prompt.

#### Narrowing an interview

`--categories` and `--findings` accept comma-separated lists to focus an interview:

```bash
loreline interview --interviewee "Alex Chen" --categories risk,operations
loreline interview --interviewee "Alex Chen" --findings architecture,operations
```

`--categories` filters every question (targeted and base) to those categories. `--findings` filters the targeted questions to only the listed readiness finding ids; base questions are unaffected by it. Combining both applies both filters.

`--interactive` opens a numbered picker over the readiness findings that did not pass, letting you choose which ones to focus on with a comma-separated selection (empty input selects all). It requires an interactive terminal and errors when stdin is not a TTY.

An interview run with a scope records it on the interview record (schema version 2) and on the session, so resuming keeps the same scope.

#### AI-assisted interviews

```bash
loreline interview --interviewee "Alex Chen" --ai --provider ollama --model llama3
```

`--ai` adds AI-generated questions and inline follow-ups to the deterministic interview:

1. Loreline resolves the AI provider and model first (from `--provider`/`--model`/`--base-url` flags or the config `ai` block), failing fast on a bad configuration before touching any file content.
2. It picks up to 8 files cited by the readiness findings that did not pass (honoring `--categories`/`--findings` scope), builds a transmission preview, and prints it. A high-confidence secret finding blocks the run entirely; redact or exclude the file and retry.
3. Unless `--yes` is passed, it asks for confirmation on an interactive terminal (`Send this context to <provider>? [y/N]`) before sending anything; a non-interactive run without `--yes` refuses instead of guessing.
4. Only the approved, redacted excerpts are sent. The model proposes up to 5 extra questions, which are appended to the deterministic set.
5. Any answer under 60 characters can trigger one AI-generated follow-up question, asked immediately after the question it follows up on (bounded by `--max-followups`, default 2 per interview).
6. After every question is answered, Loreline asks the model to flag possible contradictions between answers; each one is recorded as an unanswered question in category `contradiction` for a human to resolve, never auto-resolved.

Every AI-generated question and follow-up carries an `origin` field (`{ type: "ai", provider, model, promptVersion }`) in the session and the interview record, so it is always clear which questions came from a person and which came from a model. Without `--ai`, no provider is ever constructed and the interview behaves exactly as before.

A local model needs no API key and nothing leaves the machine except to `localhost`:

```bash
loreline interview --interviewee "Alex Chen" --ai --provider ollama --model llama3 --yes
```

`--yes` skips the interactive confirmation, which is useful for CI or scripted demos once the transmission preview has already been reviewed once.

### Compile reusable AI context

```bash
loreline compile
```

Loreline compiles answered interview questions into `.loreline/context.md` and `.loreline/context.json`, grouped by topic with a citation back to every source record. The output remains explicitly reviewable rather than presenting interview statements as independently verified facts.

#### AI-assisted compilation proposals

```bash
loreline compile --ai --provider ollama --model llama3
```

`--ai` runs the deterministic compile above unchanged, then asks the model to draft documentation-update proposals from the fresh context:

1. Loreline resolves the AI provider and model first (from `--provider`/`--model`/`--base-url` flags or the config `ai` block), failing fast on a bad configuration.
2. Compiled entries are grouped by category. Loreline prints the list of categories that would be sent and the byte size of each one.
3. Unless `--yes` is passed, it asks for confirmation on an interactive terminal (`Send this context to <provider>? [y/N]`) before the first network call; a non-interactive run without `--yes` refuses instead of guessing.
4. Before each category is sent, the assembled question/answer text is scanned for secrets. Any high-confidence finding aborts the whole run immediately, naming the offending category, before that category's network call (or any later one) is made; otherwise the redacted text is what is actually sent.
5. For each category, the model returns a consolidated summary, any claims it sees as conflicting, and suggested updates for documents such as AGENTS.md, ADRs, runbooks, or ownership docs.

The result is written under `.loreline/proposals/<timestamp>/`:

```text
.loreline/proposals/<timestamp>/
  proposal.md
  suggestions/
    <target>.md
```

`proposal.md` has one section per category with three subsections: "Quoted facts" (the verbatim answers with source file and interviewee), "Inferred summary (AI-generated)" (the model's summary, with a provenance line naming the provider, model, and prompt version), and "Unresolved and conflicting" (conflicts the model flagged, conflicts Loreline detects deterministically whenever two answers to the same question disagree, and any questions still unanswered in that category). `suggestions/<target>.md` files hold the model's proposed documentation updates as drafts only; nothing is ever written to, or applied against, real project documentation, and nothing is created or modified outside `.loreline/proposals/`.

If AI proposal generation fails (invalid model output, provider error), the deterministic `context.md` and `context.json` from step 1 are left untouched; only the proposal step exits non-zero.

### Verify knowledge quality

```bash
loreline verify --max-age 180
```

Verification checks that structured interviews belong to the configured project, have no unanswered questions, and are recent enough to trust. It writes `.loreline/verification.json` and exits with status 2 when issues are found, making it suitable for CI.

### Human approval and review

```bash
loreline review --entry system-shape --approve --owner "Jamie Diaz" --reviewer "Jamie Diaz" --due 2026-12-01
loreline review --entry system-shape --dispute --owner "Riley Chen" --reason "This is out of date."
```

`loreline review` records a human decision on one compiled context entry, appending it to `.loreline/reviews.json`. It requires a compiled `.loreline/context.json` (run `loreline compile` first) and exactly one of `--approve` or `--dispute`. Reviews are keyed by entry id and a fingerprint of the answer text, so approving an entry never silently carries over to a rewritten answer, and every past decision stays in the log even after a newer one is recorded. `--owner` must be a real named human; empty owners and an owner of `ai` are rejected, since AI-origin answers are never auto-approved.

Running `loreline compile` again merges the latest review state into each entry: `.loreline/context.md` shows `_Review: approved by <owner> on <date>_` or `_Review: DISPUTED by <owner>: <reason>_` beside the entry, `_Review: stale (answer changed since review)_` when the answer changed after the review was recorded, and `_Review: CONFLICTING - approved and disputed for the same answer_` when both an approval and a dispute exist for the same answer text.

```bash
loreline verify --require-approval
```

`--require-approval` extends verification with an approval-completeness check against `.loreline/context.json`: any compiled entry without a current, approved review is an error; a stale approval (the answer changed since it was reviewed) is a warning; and an approved review past its `--due` date is a warning. Run `loreline compile` before verifying with `--require-approval`, or verification reports a single error asking for it.

### Import and export adapters

```bash
loreline import --adapter markdown --source ./docs --yes
loreline export --adapter markdown --dest ./exported-context --yes
```

Adapters move knowledge between Loreline and an external document collection. Only one adapter ships today: `markdown`. `loreline import --adapter <name> ...` and `loreline export --adapter <name> ...` reject an unknown adapter with an error listing the available ones.

**Import (`loreline import --adapter markdown --source <directory>`)** walks `<directory>` for `.md`/`.markdown` files and records them in `.loreline/imports.json` (schema version 1). For each file, the title comes from frontmatter `title` or the first `#` heading (falling back to the filename), and `author`/`updated`/`link` frontmatter fields are captured when present. Every document is fingerprinted with sha256 so re-running import is safe:

- A file not seen before is **new**.
- A file whose fingerprint matches the log is **unchanged** and left as-is.
- A file whose fingerprint differs from the log is **changed** and re-imported with a fresh `importedAt`.
- A log entry whose stored fingerprint does not match the sha256 of its own stored content (i.e. `.loreline/imports.json` was hand-edited) is a **conflict**: it is reported and never overwritten by import.

**Import is a dry run by default.** Without `--yes`, `loreline import` prints the plan (new/changed/unchanged counts and file lists, plus any conflicts) and writes nothing. Pass `--yes` to actually merge the plan into `.loreline/imports.json`.

**Compile** (`loreline compile`) reads `.loreline/imports.json` when it exists and surfaces each imported document's metadata (title, path or link, adapter, `importedAt`) under a `## Imported references` section in `context.md` and an `imports` array in `context.json`. The imported document's full content is never embedded in the compiled context, only its provenance.

**Export (`loreline export --adapter markdown --dest <directory>`)** requires a compiled `.loreline/context.json` (run `loreline compile` first) and writes one `<category>.md` file per entry category into `<directory>`, each entry rendered with its question, answer, and a provenance line (interviewee, generated date, source interview file, and review status when the entry has one). `<directory>` may be outside the repository; it is created recursively. **Export is also a dry run by default:** without `--yes` it prints the file(s) that would be written and writes nothing. With `--yes`, it writes them; if a destination file already exists, export refuses and names the file unless `--force` is also passed.

Both commands operate entirely on the local filesystem: nothing is sent to a network service, and the only files touched are the ones under `--source`, `.loreline/imports.json`, `.loreline/context.json`, and `--dest`.

### Knowledge risk dashboard and handoff plan

```bash
loreline handoff
loreline handoff --departing "Jamie Diaz" --date 2026-12-01 --redact-names
```

`loreline handoff` turns whatever artifacts already exist under `.loreline/` (`readiness.json`, `verification.json`, `context.json`) into a single ranked list of knowledge risks, written to `.loreline/handoff.json` and `.loreline/handoff.md`. Every artifact is optional except `readiness.json`; with no readiness report at all (and none passed programmatically), it errors and asks you to run `loreline scan` first.

Each risk is scored and explained with a human-readable factor sentence for every point it contributes:

- A missing readiness finding contributes its full weight; a partial finding contributes half.
- An area where git history shows one contributor authored more than 80% of at least 5 commits contributes 15 points as a single-person dependency, doubled when `--departing` names that top contributor (case-insensitively).
- A stale or disputed knowledge review contributes 10 points, once per affected category, to every risk that covers that category.
- Cited evidence that changed or went missing since the scan, or a failed knowledge verification run, each contribute 10 points to the verification risk.
- With `--date <YYYY-MM-DD>`, every risk gains a "days until departure" factor (which can be negative) and 10 extra points when fewer than 30 days remain.

Risks are sorted by severity (highest first, tie-broken by id) and capped at 20. Each risk also lists `recommendedTopics` (interview categories worth revisiting) and `suggestedValidators` (the area's second-most-active contributor, or the configured project owner). Unresolved interview questions from `context.json` are listed under open questions, and a verification summary is included when `verification.json` exists.

`--redact-names` replaces every contributor, and review-owner name with a stable `Contributor N` alias (the same person always gets the same number, in first-seen order) everywhere a name would otherwise appear in the plan, including the `--departing` value itself. The project owner from `loreline.yaml` is never redacted, since it identifies an accountable role rather than a contributor being profiled. `--json` also prints the plan to stdout.

## Configuration

`loreline init` creates:

```yaml
schemaVersion: 1
project:
  name: my-project
  owner: TODO
scan:
  include:
    - "**/*"
  exclude:
    - .git
    - node_modules
    - dist
    - build
    - coverage
    - .loreline
  maxFiles: 10000
output:
  directory: .loreline
```

## AI providers

Loreline ships a provider-neutral layer for talking to an AI model, used by `--ai`-flagged commands. It never makes a network call unless a command is explicitly run with `--ai` flags (or a config `ai` block), and it never stores credentials: API keys are read from the environment only, at the moment a request is made.

An `ai` block in `loreline.yaml` (schema version 2) selects a default provider and model:

```yaml
schemaVersion: 2
ai:
  provider: openai
  model: gpt-4o-mini
```

| Provider    | Default endpoint                 | API key environment variable(s)          |
| ----------- | --------------------------------- | ----------------------------------------- |
| `openai`    | `https://api.openai.com`          | `OPENAI_API_KEY` or `LORELINE_API_KEY`    |
| `anthropic` | `https://api.anthropic.com`       | `ANTHROPIC_API_KEY` or `LORELINE_API_KEY` |
| `ollama`    | `http://localhost:11434`          | none (local server)                       |
| `fake`      | none (scripted, offline)          | none; responses come from `LORELINE_FAKE_RESPONSES` |

A command's `--provider`, `--model`, and `--base-url` flags override the config `ai` block field by field. Credentials are never part of `loreline.yaml`; the config schema has no key field, so nothing secret can end up committed to the repository.

### Transmission safety

Before any file content is sent to a remote AI provider, Loreline scans it for likely secrets and builds a transmission preview so a human can review exactly what would leave the machine.

`scanTextForSecrets` (`src/secrets.ts`) checks content against a set of rules:

- **High confidence** (blocks transmission): PEM private key blocks, AWS access key IDs, GitHub tokens (classic and fine-grained PAT), Slack tokens, Stripe live keys, and quoted `key: "value"` / `key = "value"` assignments where the key name looks like `api_key`, `secret`, `token`, or `password`.
- **Medium confidence** (reported, does not block): JWT-shaped strings and long base64/hex runs with high Shannon entropy.
- **Sensitive files**: any file named `.env`, `.env.*`, `*.pem`, or `id_rsa*` is flagged wholesale as a single high-confidence finding, without its content ever being scanned or echoed anywhere.

`buildTransmissionPreview(root, files)` (`src/transmit.ts`) reads each file, scans its full content, and returns a `TransmissionPreview` with a size, a truncated excerpt, and findings per file. The preview is `blocked` whenever any non-excluded file has a high-confidence finding. `renderTransmissionPreview` turns it into stable, human-readable text, and `approvedPayload` returns the excerpts that are safe to send (high-confidence matches redacted, excluded files dropped) or throws if the preview is still blocked. No finding, rendered preview, or thrown error ever includes more than the first 4 characters of a matched value.

### Evaluation suite

`npm run eval` (a subset of `npm test`) checks question and context quality end to end: question deduplication, readiness-gap coverage, grounding, contradiction preservation, and hard leakage checks for excluded content and planted secrets. See [`docs/evaluations.md`](docs/evaluations.md) for what each eval checks, release thresholds, and how to enable the one model-graded eval locally.

## Artifact schemas and compatibility

Every machine-readable Loreline artifact is validated against a packaged JSON Schema:

- `@tysoncung/loreline/schemas/v1/config`
- `@tysoncung/loreline/schemas/v2/config`
- `@tysoncung/loreline/schemas/v1/readiness`
- `@tysoncung/loreline/schemas/v2/readiness`
- `@tysoncung/loreline/schemas/v1/interview`
- `@tysoncung/loreline/schemas/v2/interview`
- `@tysoncung/loreline/schemas/v1/session`
- `@tysoncung/loreline/schemas/v1/context`
- `@tysoncung/loreline/schemas/v2/context`
- `@tysoncung/loreline/schemas/v1/verification`
- `@tysoncung/loreline/schemas/v1/reviews`
- `@tysoncung/loreline/schemas/v1/imports`
- `@tysoncung/loreline/schemas/v1/handoff`

The `schemaVersion` field controls compatibility. Loreline preserves support for all artifacts within the current major schema version. Additive fields require a new schema version because schemas reject unknown properties, and incompatible changes require an explicit migration path. Unsupported versions fail with field-level validation errors instead of being interpreted as current data.

## Principles

- **Local first:** source material does not need to leave the machine.
- **Open artifacts:** Markdown, YAML, and JSON instead of a proprietary silo.
- **Evidence and provenance:** generated knowledge remains traceable.
- **Human verified:** AI assists capture; accountable people approve it.
- **Close to the work:** context lives where future maintainers and agents will encounter it.

## Status

Loreline is an early prototype. It supports repository and document-collection readiness scans (including git history informed knowledge-concentration checks in repository mode), adaptive knowledge interviews (deterministic and AI-assisted), provenance-rich context compilation, knowledge verification, human approval and review workflows, markdown import/export adapters, and a ranked knowledge risk dashboard and handoff plan for departing contributors.

The readiness score's baseline shifted with the addition of the `knowledge-concentration` finding: total finding weight moved from 100 to 110, so scores from before this change are not directly comparable to scores after it. Re-run `loreline scan` to get a current baseline.

## Contributing

Contributions are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md) for development setup, an architecture tour of `src/`, the schema versioning policy, and pull request guidance.

## Security

Loreline is local-first and does not transmit repository or interview content without explicit user action. See [SECURITY.md](SECURITY.md) for the supported versions, threat model, and how to report a vulnerability privately.

## License

MIT
