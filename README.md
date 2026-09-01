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
- `@tysoncung/loreline/schemas/v1/interview`
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

Loreline is an early prototype. It supports repository readiness scans, adaptive knowledge interviews, provenance-rich context compilation, and knowledge verification. Planned work includes document collections, Git history informed questions, approval workflows, and pluggable AI providers.

## License

MIT
