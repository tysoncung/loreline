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

## Principles

- **Local first:** source material does not need to leave the machine.
- **Open artifacts:** Markdown, YAML, and JSON instead of a proprietary silo.
- **Evidence and provenance:** generated knowledge remains traceable.
- **Human verified:** AI assists capture; accountable people approve it.
- **Close to the work:** context lives where future maintainers and agents will encounter it.

## Status

Loreline is an early prototype. The current release supports repository readiness scans and adaptive knowledge interviews. Planned work includes document collections, Git history informed questions, knowledge validation workflows, and pluggable AI providers.

## License

MIT
