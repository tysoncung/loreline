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

### Compile reusable AI context

```bash
loreline compile
```

Loreline compiles answered interview questions into `.loreline/context.md` and `.loreline/context.json`, grouped by topic with a citation back to every source record. The output remains explicitly reviewable rather than presenting interview statements as independently verified facts.

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

## Artifact schemas and compatibility

Every machine-readable Loreline artifact is validated against a packaged JSON Schema:

- `@tysoncung/loreline/schemas/v1/config`
- `@tysoncung/loreline/schemas/v1/readiness`
- `@tysoncung/loreline/schemas/v2/readiness`
- `@tysoncung/loreline/schemas/v1/interview`
- `@tysoncung/loreline/schemas/v2/interview`
- `@tysoncung/loreline/schemas/v1/session`
- `@tysoncung/loreline/schemas/v1/context`
- `@tysoncung/loreline/schemas/v1/verification`

The `schemaVersion` field controls compatibility. Loreline preserves support for all artifacts within the current major schema version. Additive fields require a new schema version because schemas reject unknown properties, and incompatible changes require an explicit migration path. Unsupported versions fail with field-level validation errors instead of being interpreted as current data.

## Principles

- **Local first:** source material does not need to leave the machine.
- **Open artifacts:** Markdown, YAML, and JSON instead of a proprietary silo.
- **Evidence and provenance:** generated knowledge remains traceable.
- **Human verified:** AI assists capture; accountable people approve it.
- **Close to the work:** context lives where future maintainers and agents will encounter it.

## Status

Loreline is an early prototype. It supports repository and document-collection readiness scans (including git history informed knowledge-concentration checks in repository mode), adaptive knowledge interviews, provenance-rich context compilation, and knowledge verification. Planned work includes approval workflows and pluggable AI providers.

The readiness score's baseline shifted with the addition of the `knowledge-concentration` finding: total finding weight moved from 100 to 110, so scores from before this change are not directly comparable to scores after it. Re-run `loreline scan` to get a current baseline.

## Contributing

Contributions are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md) for development setup, an architecture tour of `src/`, the schema versioning policy, and pull request guidance.

## Security

Loreline is local-first and does not transmit repository or interview content without explicit user action. See [SECURITY.md](SECURITY.md) for the supported versions, threat model, and how to report a vulnerability privately.

## License

MIT
