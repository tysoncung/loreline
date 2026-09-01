# Loreline Roadmap Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement GitHub issues #16, #17, #9, #12, #11, #6, #7, #4, #5, #1, #8, #2, #3, #13, #14, #15 in dependency order on one branch, one commit per task.

**Architecture:** Loreline is a zero-runtime-dependency-light Node 20 ESM CLI (deps: ajv, yaml). Commands live in `src/cli.ts` (parseArgs-based subcommands), domain logic in one module per concern under `src/`, JSON Schemas under `schemas/v<N>/`, validated at every read/write boundary by `src/validation.ts`. All artifacts are Markdown plus JSON under `.loreline/`. New features follow the same shape: a `src/<concern>.ts` module, a schema when a new machine-readable artifact appears, CLI wiring, and `node:test` tests under `test/`.

**Tech Stack:** TypeScript 5.9 strict ESM, Node 20 builtin `node:test` via tsx, ajv 2020, yaml. No new runtime dependencies anywhere in this plan.

**Spec:** The refined GitHub issues (bodies contain acceptance criteria plus a Refinement section): run `gh issue view <N>` for the authoritative text. Milestones: v0.3.0 (#16 #17 #9), v0.4.0 (#11 #12 #7 #6), v0.5.0 (#4 #5), v0.6.0 (#1 #8 #2 #3 #13), v0.7.0 (#14 #15).

## Global Constraints

- Node >= 20, ESM only, imports of local files use `.js` extension.
- No new runtime dependencies. Test runner is `npm test` (node:test through tsx); typecheck is `npm run typecheck`. Both MUST pass before every commit.
- Schema policy (#10): schemas are strict (`additionalProperties: false`); any field added to an existing artifact requires a new schema version directory `schemas/v2/...` plus routing support; version 1 artifacts must keep validating. New artifact kinds start at v1.
- Credentials only ever come from environment variables; never written to artifacts, logs, or error messages.
- No network calls unless an `--ai` flag was explicitly passed; tests never make network calls.
- Existing command behavior without new flags must remain byte-for-byte compatible (except where a task explicitly bumps an artifact's schemaVersion).
- Commit after every task: `git add -A && git commit -m "<type>: <summary> (refs #N)"`. Do not push.
- User copy rule: never use the em dash character in any authored text or docs.
- All file paths below are relative to the repository root.

---

### Task 1: Security policy (#16)

**Files:**
- Create: `SECURITY.md`
- Modify: `README.md` (add a Security section before License linking the policy)

No code. Content requirements for `SECURITY.md`:
- Supported versions table: only the latest published 0.x minor receives fixes.
- Private reporting: GitHub private vulnerability reporting at `https://github.com/tysoncung/loreline/security/advisories/new`; never open a public issue for a vulnerability. Acknowledgement within 72 hours, status update within 7 days, coordinated disclosure after a fix is released.
- Threat model and trust boundaries: Loreline is local-first. Boundaries: (1) the scanned repository content, (2) generated `.loreline/` artifacts which may contain sensitive organizational knowledge and should be access-controlled like source code, (3) future opt-in AI provider transmissions (#1, #8) which happen only behind explicit `--ai` flags after a preview. Provider credentials are environment variables only; Loreline must never persist them to artifacts or logs.
- Release security checklist section for releases that add outbound transmission: secret scan coverage, preview accuracy, no-credential-persistence test, documented data handling.

**Steps:**
- [ ] Write `SECURITY.md`; add README Security section (two sentences plus link).
- [ ] Run: `npm test` (expect 11 pass), `npm run typecheck`.
- [ ] Commit: `docs: add security policy and threat model (refs #16)`

### Task 2: Contribution guide and templates (#17)

**Files:**
- Create: `CONTRIBUTING.md`, `.github/ISSUE_TEMPLATE/bug_report.md`, `.github/ISSUE_TEMPLATE/feature_request.md`, `.github/ISSUE_TEMPLATE/provider_integration.md`, `.github/pull_request_template.md`
- Modify: `README.md` (add Contributing section linking the guide)

`CONTRIBUTING.md` must cover: Node 20 setup (`npm install`, `npm run dev`, `npm test`, `npm run typecheck`, `npm run build`); architecture tour naming each `src/` module's single responsibility and the schema policy from #10 (strict schemas, versioned directories, routing by `schemaVersion`); TDD expectation (tests accompany every change); PR guidance (small PRs, reference an issue, tests and typecheck green); release practice (npm publish from tagged main, schema compatibility rules); link to `SECURITY.md`; roadmap pointer to milestones v0.3.0 through v0.7.0.

PR template checklist items: tests added or updated; `npm test` and `npm run typecheck` pass; no secrets or personal data in fixtures or artifacts; provenance preserved for any generated knowledge; schema changes follow the versioning policy; docs updated.

Issue templates use YAML frontmatter (`name`, `about`, `labels`). The provider template asks: provider name, API style (OpenAI-compatible, native, local), auth model, data residency notes, and why the shared provider layer (#1) cannot already express it.

**Steps:**
- [ ] Write the five files; add README Contributing section.
- [ ] `npm test` and `npm run typecheck` pass.
- [ ] Commit: `docs: add contribution guide, issue and PR templates (refs #17)`

### Task 3: GitHub Actions workflow (#9)

**Files:**
- Create: `examples/github-actions/loreline.yml`, `.github/workflows/ci.yml`, `docs/github-actions.md`
- Test: `test/workflow-example.test.ts`

`examples/github-actions/loreline.yml`: a complete workflow named "Loreline readiness" with `permissions: { contents: read }`, jobs pinned to `actions/checkout@v4` and `actions/setup-node@v4` with `node-version: 20`, runs `npx @tysoncung/loreline@0.2.0 scan --fail-under 70`, then `npx @tysoncung/loreline@0.2.0 verify || true` (verify is advisory until interviews exist), uploads `.loreline/` with `actions/upload-artifact@v4` (`if: always()`), and writes a step summary from `readiness.json` using plain `node -e` JSON extraction into `$GITHUB_STEP_SUMMARY` (score and finding statuses only, never interview content). AI provider secrets appear only as commented-out lines with a comment pointing at docs. Version is pinned (`@0.2.0`), stated in a comment as required for reproducibility.

`.github/workflows/ci.yml`: name CI, on push to main and pull_request, `permissions: contents: read`, single job: checkout@v4, setup-node@v4 node 20 with npm cache, `npm ci`, `npm run typecheck`, `npm test`, `npm run build`, then a step that runs `node dist/cli.js scan --path . --fail-under 60` so the CLI exercises itself, and validates the example workflow by running the test suite (the test below covers it).

`test/workflow-example.test.ts` (node:test + `yaml` package): parses `examples/github-actions/loreline.yml`; asserts it parses cleanly, `permissions.contents === "read"`, every `uses:` value contains `@v`, every `npx @tysoncung/loreline` invocation pins an exact `@x.y.z` version, and no step references `secrets.` outside comments (read raw text for the secrets assertion).

`docs/github-actions.md`: how to copy the example, required permissions, how artifacts are downloaded, how to enable optional AI secrets later, statement that the default workflow makes no external AI calls. Link it from README's CI mention.

**Steps:**
- [ ] Write the failing test, run `npm test` (fails: file missing).
- [ ] Write the example workflow, CI workflow, and doc; run `npm test` (all pass) and `npm run typecheck`.
- [ ] Commit: `feat: add official GitHub Actions workflow and CI (refs #9)`

### Task 4: Schema version routing (prerequisite for v2 artifacts)

**Files:**
- Modify: `src/validation.ts`, `test/validation.test.ts`

**Interfaces (produces):**
```ts
// src/validation.ts additions
export type ArtifactKind = "config" | "readiness" | "interview" | "context" | "verification" | "session" | "reviews" | "imports"; // extended by later tasks as kinds appear
export const SUPPORTED_VERSIONS: Record<ArtifactKind, number[]>; // starts { config:[1], readiness:[1], interview:[1], context:[1], verification:[1], ... }
export const LATEST_VERSION: Record<ArtifactKind, number>;
export async function validateArtifact<T>(kind: ArtifactKind, value: unknown, source: string): Promise<T>;
```

Behavior: `validateArtifact` reads `(value as {schemaVersion?: unknown}).schemaVersion`. If it is not a supported integer for that kind, throw `Invalid <kind> artifact <source>: unsupported schemaVersion <v> (supported: 1, 2)`. Otherwise load `schemas/v<version>/<kind>.schema.json` (cache key becomes `${kind}:${version}`). Only add kinds/versions to the maps in the task that introduces them.

**Steps:**
- [ ] Add failing tests: routing loads v1 for existing kinds; unsupported version message lists supported versions; missing schemaVersion is rejected.
- [ ] Implement routing; keep the existing exported signature.
- [ ] `npm test`, `npm run typecheck` pass. Commit: `feat: route artifact validation by schema version (refs #10)`

### Task 5: Evidence citations (#12)

**Files:**
- Create: `src/citations.ts`, `schemas/v2/readiness.schema.json`, `test/citations.test.ts`
- Modify: `src/types.ts`, `src/scanner.ts`, `src/knowledge.ts` (verify), `src/validation.ts` (register readiness v2), `package.json` (export `./schemas/v2/readiness`), `README.md` (schema list)

**Interfaces (produces):**
```ts
// src/citations.ts
export interface Citation { file: string; startLine?: number; endLine?: number; fingerprint: string; kind: "evidence" | "inference"; }
export async function citeFile(root: string, file: string): Promise<Citation>; // fingerprint = sha256 hex of file bytes (node:crypto), kind "evidence"
export type CitationState = "intact" | "changed" | "missing";
export async function checkCitation(root: string, citation: Citation): Promise<CitationState>;
```

Changes: `Finding` gains optional `citations?: Citation[]`. `scanRepository` cites every evidence file it lists (evidence files come from the already-exclusion-filtered inventory, satisfying "never cite excluded content"). Readiness report writes `schemaVersion: 2`; `schemas/v2/readiness.schema.json` is the v1 schema with `const: 2` plus optional `citations` on findings (items: object with required `file`, `fingerprint`, `kind`; optional integer `startLine`, `endLine` >= 1; `kind` enum evidence|inference; additionalProperties false). Interview command must keep accepting v1 readiness files (routing from Task 4 handles it). `verifyKnowledge` gains: when `.loreline/readiness.json` exists and has citations, report a warning issue per citation whose state is `changed` (message contains "evidence changed") and per `missing` ("evidence missing"). Markdown rendering: `renderMarkdownReport` appends the cited files after each finding's next action as backticked paths when citations exist; JSON carries the full objects.

**Tests (write first, watch fail):** `citeFile` produces a 64-char hex fingerprint and the relative path; `checkCitation` returns intact for unchanged, changed after appending a byte, missing after deletion (moved file = missing at old path); scan on a temp fixture directory yields findings whose citations all point at existing files; `verifyKnowledge` on a temp `.loreline` with a doctored citation reports the stale-evidence warning.

- [ ] Failing tests, implement, all green, typecheck.
- [ ] Commit: `feat: add evidence citations with fingerprints (refs #12)`

### Task 6: Resumable interview sessions (#11)

**Files:**
- Create: `src/session.ts`, `schemas/v1/session.schema.json`, `test/session.test.ts`
- Modify: `src/cli.ts` (interview flags), `src/interview.ts` (session-aware flow), `src/validation.ts` (kind "session"), `package.json` (export), `README.md`

**Interfaces (produces):**
```ts
// src/session.ts
export interface SessionAnswer { id: string; answer: string; answeredAt: string; author: string; revisions: Array<{ answer: string; answeredAt: string; author: string }>; }
export interface InterviewSession { schemaVersion: 1; sessionId: string; createdAt: string; updatedAt: string; project: string; interviewee: string; interviewer: string; sourceReport: string; status: "open" | "completed"; questions: InterviewQuestion[]; answers: SessionAnswer[]; }
export function createSession(options: { project: string; interviewee: string; interviewer: string; sourceReport: string; questions: InterviewQuestion[] }): InterviewSession; // sessionId = `${YYYYMMDDHHmmss}-${slug(interviewee)}`
export async function saveSession(outputDirectory: string, session: InterviewSession): Promise<string>; // .loreline/sessions/<id>.json, write temp file then rename (atomic), validate before write
export async function loadSession(outputDirectory: string, sessionId: string): Promise<InterviewSession>; // ENOENT -> Error `Session "<id>" not found...` listing available ids
export function recordAnswer(session: InterviewSession, questionId: string, answer: string, author: string, options?: { revise?: boolean }): void; // throws if already answered and !revise ("already answered; pass --revise"); revise pushes old value onto revisions
export function toInterviewRecord(session: InterviewSession): InterviewRecord; // marks nothing; caller sets status
```

CLI: `loreline interview` gains `--resume <sessionId>`, `--revise` (boolean), `--session-only` not needed. Flow in `conductInterview`: create or load session; save after every accepted answer; on completion set `status: "completed"`, save, then write the interview record as before. Interactive interruption (Ctrl-C) or thrown provider errors leave the open session on disk; `--resume` skips already-answered questions (unless `--revise`, which re-asks all answered ones and archives priors). `--interviewee` is not required with `--resume` (taken from session). Supplied `--answers` works with sessions identically.

Schema `schemas/v1/session.schema.json`: strict, mirrors the interface; `status` enum open|completed; `revisions` required array (may be empty).

**Tests:** create+save+load round-trip validates; recordAnswer throws without revise and archives with revise (old answer in revisions, new value current, timestamps distinct fields present); resume flow answers only unanswered questions via supplied answers; a session interrupted after two answers (simulate by calling save mid-way) resumes to completion and the final interview record contains all answers; completed record passes interview schema validation.

- [ ] Failing tests, implement, green, typecheck.
- [ ] Commit: `feat: add resumable interview sessions with revision history (refs #11)`

### Task 7: Scope selection (#6)

**Files:**
- Create: `src/scope.ts`, `test/scope.test.ts`
- Modify: `src/cli.ts`, `src/scanner.ts`, `src/interview.ts`, `schemas/v2/readiness.schema.json` (optional `scope`), `schemas/v2/interview.schema.json` (new, `const: 2` + optional `scope` + everything from v1), `src/validation.ts` (interview v2), `src/interview.ts` writes v2, `package.json` export, `README.md`

**Interfaces (produces):**
```ts
// src/scope.ts
export interface ScanScope { include: string[]; exclude: string[]; }
export interface InterviewScope { categories?: string[]; findings?: string[]; }
export function globToRegExp(pattern: string): RegExp; // supports **, *, ?; * and ? never cross "/"; ** crosses; anchored both ends
export function inScope(relativePath: string, scope: ScanScope): boolean; // include empty => everything included; exclude wins over include
export function selectInteractively(title: string, items: Array<{ id: string; label: string }>): Promise<string[]>; // TTY numbered list, comma-separated selection, empty input = all; only called when stdin is a TTY
```

CLI: `scan` gains repeatable `--include <glob>` / `--exclude <glob>` (parseArgs `multiple: true`) merged with config patterns (CLI flags win by being appended); `interview` gains `--categories a,b` and `--findings x,y` (comma lists) plus `--interactive` which, on a TTY, calls `selectInteractively` over the non-pass findings. `inventoryRepository` applies `inScope` to files (directory pruning for simple name excludes stays as-is for speed). Readiness v2 gains optional `scope: { include: string[]; exclude: string[] }` recorded from the effective scope; interview record becomes v2 with optional `scope: { categories?: string[]; findings?: string[] }` and `buildInterviewQuestions(report, scope?)` filters targeted questions by finding id and all questions by category (base questions filtered by category only). No flags = identical behavior to today (scope omitted from artifacts when defaulted... record it always for scan since schema allows optional: record only when user narrowed something).

**Tests:** globToRegExp table (`**/*.md` matches `a/b/c.md`; `*.md` does not match `a/b.md`; `src/**` matches `src/x/y`; `?` single char); inScope include/exclude precedence; scan with `--exclude "docs/**"` on a fixture omits those files from filesScanned and citations never reference them; buildInterviewQuestions filters by findings and categories; interview record with scope validates against v2 and one without scope still validates against v1 route.

- [ ] Failing tests, implement, green, typecheck.
- [ ] Commit: `feat: add scan and interview scope selection (refs #6)`

### Task 8: Approval and verification metadata (#7)

**Files:**
- Create: `src/review.ts`, `schemas/v1/reviews.schema.json`, `schemas/v2/context.schema.json`, `test/review.test.ts`
- Modify: `src/cli.ts` (new `review` command; `verify --require-approval`), `src/knowledge.ts` (merge reviews into compile; enforce in verify), `src/types.ts`, `src/validation.ts` (kinds), `package.json`, `README.md`

**Interfaces (produces):**
```ts
// src/review.ts
export interface ReviewEntry { entryId: string; answerFingerprint: string; status: "approved" | "disputed"; owner: string; reviewers: string[]; reason?: string; reviewedAt: string; dueDate?: string; }
export interface ReviewLog { schemaVersion: 1; project: string; entries: ReviewEntry[]; } // .loreline/reviews.json; multiple entries per entryId allowed, last-by-reviewedAt wins, conflicts preserved
export async function loadReviews(outputDirectory: string): Promise<ReviewLog | undefined>;
export async function saveReviews(outputDirectory: string, log: ReviewLog): Promise<string>;
export function recordReview(log: ReviewLog, entry: ReviewEntry): void; // appends, never overwrites history
export function effectiveReview(log: ReviewLog | undefined, entryId: string, answerFingerprint: string): { entry?: ReviewEntry; stale: boolean; conflicting: boolean };
export function fingerprintAnswer(answer: string): string; // sha256 hex
```

CLI `loreline review --entry <id> --approve|--dispute --owner <name> [--reviewer <name> ...] [--reason <text>] [--due <YYYY-MM-DD>]`: loads compiled `context.json` (error if absent, "run loreline compile first"), finds the entry, records a review with the current answer fingerprint. Exactly one of --approve/--dispute required. `compileKnowledge` merges: each compiled entry gains optional `review: { status; owner; reviewedAt; dueDate?; reason?; stale: boolean; conflicting: boolean }` in context v2 (schemaVersion 2); stale means the answer fingerprint changed since review; conflicting means an approved and a disputed review share the same fingerprint (both kept visible; Markdown shows both lines). AI-origin entries (Task 12 adds `origin`; until then no entry has origin "ai") are never auto-approved: approval only ever comes from the review command, and `recordReview` refuses `owner` equal to "ai" or empty. `verifyKnowledge` gains options `{ requireApproval?: boolean }`: when set, every compiled entry without a current (non-stale) approved review yields an error issue; stale approvals yield warnings ("approval is stale"); overdue `dueDate` yields warnings. Markdown context render prints `Approved by <owner> on <date>` or `DISPUTED: <reason>` beside entries.

**Tests:** record/load round trip validates; effectiveReview picks latest, flags stale on fingerprint change and conflicting on approve+dispute; compile merges review block (build temp `.loreline` with one interview and one review); verify with requireApproval errors on unapproved, warns on stale and overdue; review command rejects unknown entry id.

- [ ] Failing tests, implement, green, typecheck.
- [ ] Commit: `feat: add human approval metadata and verification policies (refs #7)`

### Task 9: Git history insight (#4)

**Files:**
- Create: `src/history.ts`, `test/history.test.ts`
- Modify: `src/scanner.ts` (new finding), `src/interview.ts` (FINDING_QUESTIONS entry), `src/cli.ts` (`scan --no-history`, `--exclude-identity` repeatable), `README.md`

**Interfaces (produces):**
```ts
// src/history.ts
export interface AreaOwnership { area: string; commits: number; lastChangeAt: string | null; contributors: Array<{ name: string; commits: number; share: number; lastCommitAt: string }>; topShare: number; }
export interface HistoryInsights { available: boolean; analyzedCommits: number; excludedIdentities: string[]; methodology: string; areas: AreaOwnership[]; }
export async function analyzeHistory(root: string, options?: { excludeIdentities?: string[]; maxCommits?: number }): Promise<HistoryInsights>;
```

Implementation: `execFile("git", ["log", "--numstat", "--no-merges", "--date=iso-strict", "--pretty=format:%H%x1f%an%x1f%aI", "-n", String(maxCommits ?? 2000)], { cwd: root })` via `node:child_process` promisified. Not a git repo or git missing: return `{ available: false, ... }` silently. Area = first path segment (files at root use "(root)"). Identities matching `excludeIdentities` (case-insensitive exact name) or `/\[bot\]$/i` are dropped. `share` = contributor commits touching that area / area commits. `topShare` = max share. `methodology` is a fixed sentence stating commit-touch counting, its limits, and that it is a familiarity signal, not ownership or performance. Nothing leaves the machine.

Scanner: `scanRepository` calls `analyzeHistory` (skippable via new optional argument `{ history?: HistoryInsights }` injected from CLI so tests stay deterministic; CLI computes unless `--no-history`). New finding id `knowledge-concentration`, title "Knowledge distribution", weight 10: when history unavailable or under 10 analyzed commits -> status "partial" with recommendation to review manually (evidence empty); else "pass" when no area with >= 5 commits has topShare > 0.8; "partial" when some do; "missing" when more than half of qualifying areas do. Evidence strings: `"<area>: <name> authored <pct>% of <n> commits"`. Readiness v2 schema gains optional top-level `history` object (areas summary as above, all strict); report embeds it when available. FINDING_QUESTIONS gains `knowledge-concentration` -> question id `concentration-backups` category "ownership": "Which areas would stall if their main contributor left tomorrow, and who should shadow them?" reason "Git history shows knowledge concentrated in few people." Score baseline shift is accepted and release-noted in README.

**Tests:** build a throwaway git repo in a temp dir (`git init`, `git -c user.name=A -c user.email=a@x commit` files under `alpha/` 6 times, one commit by `B` under `beta/`, one by `dep-bot[bot]`): analyzeHistory reports areas alpha (topShare 1 for A) and beta, excludes the bot, share sums to 1 per area; excludeIdentities drops A; non-repo temp dir yields available false; scanner finding logic unit-tested by injecting synthetic HistoryInsights for pass, partial, missing cases.

- [ ] Failing tests, implement, green, typecheck.
- [ ] Commit: `feat: discover experts and concentration risk from git history (refs #4)`

### Task 10: Document collection scanning (#5)

**Files:**
- Create: `src/docscan.ts`, `test/docscan.test.ts`, fixture folder `test/fixtures/docs-collection/` (files below)
- Modify: `src/cli.ts` (`scan --mode repository|documents`, default repository), `src/scanner.ts` (mode dispatch + report `mode` field), `schemas/v2/readiness.schema.json` (optional `mode` enum repository|documents, optional `unreadable` string array), `README.md`

**Interfaces (produces):**
```ts
// src/docscan.ts
export async function scanDocuments(root: string, config: LorelineConfig): Promise<ReadinessReport>; // same report shape, mode: "documents"
```

Findings (same Finding type, ids/weights): `doc-purpose` 15 (pass when >= 80% of documents start with an H1 or frontmatter `title` within first 5 lines; partial >= 50%; else missing; evidence: offending files up to 10); `doc-ownership` 15 (frontmatter `owner:` or `author:` coverage, same thresholds); `doc-freshness` 15 (frontmatter `updated:`/`date:` or file mtime within 365 days, same thresholds); `doc-structure` 10 (an index: README.md or index.md at root, pass/missing); `doc-linkage` 15 (share of documents referenced by a relative Markdown link from another document; orphans listed; >= 60% pass, >= 30% partial); `doc-terminology` 10 (a glossary/terminology/definitions file exists, pass/missing); `doc-operations` 20 (any document matching /runbook|procedure|process|policy|escalation/i in name or H1, coverage thresholds pass >= 1 with content, missing when none). Documents = files matching configured include/exclude with extensions md, mdx, txt, rst, adoc (respect `scan.maxFiles`). Files that fail to read as UTF-8 go into report `unreadable` (relative paths) and are excluded from percentages. Citations attach per finding as in Task 5. Everything stays local.

Fixture `test/fixtures/docs-collection/`: `README.md` (H1 + links to `guides/onboarding.md` and `policies/security-policy.md`), `guides/onboarding.md` (frontmatter title+owner+updated 2026-08-01), `policies/security-policy.md` (H1, no owner), `notes/orphan.txt` (plain text, no heading), `glossary.md` (H1 Glossary), and `binary.bin` written by the test as invalid UTF-8 bytes (write in test setup to keep git clean, into a temp copy).

**Tests:** copy fixture to temp dir, add the binary file, run `scanDocuments`: report mode documents; unreadable lists `binary.bin`; `doc-terminology` pass; `doc-ownership` partial or missing per coverage math (assert exact statuses from the fixture composition); orphan detection lists `notes/orphan.txt`; score is a number 0..100 and summary.filesScanned counts only documents.

- [ ] Failing tests, implement, green, typecheck. CLI `--mode documents` wired and help text updated.
- [ ] Commit: `feat: scan document collections for AI readiness (refs #5)`

### Task 11: Provider-neutral AI layer (#1)

**Files:**
- Create: `src/providers/types.ts`, `src/providers/openai.ts`, `src/providers/anthropic.ts`, `src/providers/ollama.ts`, `src/providers/fake.ts`, `src/providers/index.ts`, `test/providers.test.ts`
- Modify: `schemas/v2/config.schema.json` (new: v1 config + `const: 2` + optional `ai` block), `src/config.ts` (defaultConfig stays v1-shaped but typed to accept v2; loadConfig routes), `src/types.ts` (`LorelineConfig` gains optional `ai`), `src/validation.ts` (config v2), `package.json`, `README.md`

**Interfaces (produces):**
```ts
// src/providers/types.ts
export interface AiMessage { role: "system" | "user" | "assistant"; content: string; }
export interface CompletionRequest { messages: AiMessage[]; maxTokens?: number; temperature?: number; }
export interface CompletionResult { text: string; provider: string; model: string; }
export interface AiProvider { readonly name: string; readonly model: string; complete(request: CompletionRequest): Promise<CompletionResult>; }
export interface AiSettings { provider: "openai" | "anthropic" | "ollama" | "fake"; model: string; baseUrl?: string; }
export class ProviderError extends Error { constructor(message: string, options?: { cause?: unknown }); }
// src/providers/index.ts
export function resolveAiSettings(config: LorelineConfig, flags: { provider?: string; model?: string; baseUrl?: string }): AiSettings; // flags > config.ai; error "no AI provider configured; set ai in loreline.yaml or pass --provider" when neither
export function createProvider(settings: AiSettings, env: NodeJS.ProcessEnv): AiProvider;
```

Providers use global `fetch`. openai: POST `${baseUrl ?? "https://api.openai.com"}/v1/chat/completions`, bearer `env.OPENAI_API_KEY ?? env.LORELINE_API_KEY`, missing key -> ProviderError naming the variables, non-2xx -> ProviderError with status and response `error.message` when parseable (never echo the key), result text from `choices[0].message.content`. anthropic: POST `${baseUrl ?? "https://api.anthropic.com"}/v1/messages` headers `x-api-key: env.ANTHROPIC_API_KEY ?? env.LORELINE_API_KEY`, `anthropic-version: 2023-06-01`; system messages join into top-level `system`; text from `content[0].text`; default maxTokens 1024. ollama: POST `${baseUrl ?? "http://localhost:11434"}/api/chat` `{ model, messages, stream: false }`, no key; connection refused -> ProviderError "Is Ollama running?". fake: constructor takes `responses: string[]` (cycled) and records every `CompletionRequest` in a public `requests: CompletionRequest[]`; `createProvider` with provider "fake" reads scripted responses from env `LORELINE_FAKE_RESPONSES` (JSON array) so CLI-level tests can drive it offline.

Config v2 `ai` block (all optional strictly typed): `{ provider: enum, model: string, baseUrl?: string }`. Credentials are NOT part of config; schema has no key field. `loadConfig` returns v1 or v2; `defaultConfig` remains version 1 output (init unchanged). CLI: no command uses providers yet; this task only exports the layer. Add `--version` note in README AI section: network only with `--ai` flags, keys via env.

**Tests (fake + mocked fetch via dependency injection: each provider module exports a factory accepting `fetchImpl?: typeof fetch` defaulting to global):** fake cycles responses and records requests; resolveAiSettings precedence and its error; openai missing key ProviderError names OPENAI_API_KEY; openai/anthropic/ollama happy path against a stubbed fetchImpl asserting URL, headers (bearer/x-api-key present, exact key value never appears in any thrown message), body shape, and parsed text; non-2xx surfaces actionable ProviderError; config v2 with ai block validates, v1 still loads.

- [ ] Failing tests, implement, green, typecheck.
- [ ] Commit: `feat: add provider-neutral AI integration layer (refs #1)`

### Task 12: Secret detection and transmission preview (#8)

**Files:**
- Create: `src/secrets.ts`, `src/transmit.ts`, `test/secrets.test.ts`
- Modify: `README.md`

**Interfaces (produces):**
```ts
// src/secrets.ts
export interface SecretFinding { file: string; line: number; rule: string; severity: "high" | "medium"; preview: string; } // preview = first 4 chars + "..." + rule name, never the full value
export function scanTextForSecrets(text: string, file: string): SecretFinding[];
export function redactSecrets(text: string): string; // replaces every high-confidence match with "[REDACTED:<rule>]"
// src/transmit.ts
export interface TransmissionItem { file: string; excerpt: string; bytes: number; secretFindings: SecretFinding[]; excluded: boolean; }
export interface TransmissionPreview { items: TransmissionItem[]; blocked: boolean; highFindings: number; }
export async function buildTransmissionPreview(root: string, files: string[], options?: { maxExcerptBytes?: number }): Promise<TransmissionPreview>; // deterministic order (sorted), blocked when any non-excluded item has a high finding
export function renderTransmissionPreview(preview: TransmissionPreview): string; // stable text listing files, sizes, redacted findings
export function approvedPayload(preview: TransmissionPreview): Array<{ file: string; excerpt: string }>; // throws if blocked; excludes excluded items; excerpts pass through redactSecrets
```

Rules (high): private key blocks (`-----BEGIN [A-Z ]*PRIVATE KEY-----`), AWS access key id (`\bAKIA[0-9A-Z]{16}\b`), GitHub tokens (`\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36,}\b`, `\bgithub_pat_[A-Za-z0-9_]{22,}\b`), Slack (`\bxox[baprs]-[A-Za-z0-9-]{10,}\b`), Stripe (`\bsk_live_[A-Za-z0-9]{16,}\b`), generic assignment (`(?:api[_-]?key|secret|token|password)\s*[:=]\s*['"][^'"\s]{12,}['"]` case-insensitive). Rules (medium): JWT-shaped (`\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.`), high-entropy base64/hex runs >= 40 chars (Shannon entropy > 4.5 over the run). Files named `.env`, `.env.*`, `*.pem`, `id_rsa*` are one high finding for the whole file (rule "sensitive-file"). No secret value is ever included beyond the 4-char preview; tests assert the full planted values never appear in findings, rendered preview, or thrown errors.

**Tests:** planted fixtures (constructed inline in the test, never committed as realistic-looking live keys: build values by concatenation) for each rule; false-positive handling: a sha256 hex in a lockfile-like line is medium not high, ordinary prose clean; `.env` wholesale flag; redactSecrets removes values; preview blocked flips off after marking the offending item excluded; approvedPayload throws while blocked and never contains planted values; deterministic ordering.

- [ ] Failing tests, implement, green, typecheck.
- [ ] Commit: `feat: add secret detection, redaction, and transmission preview (refs #8)`

### Task 13: AI-assisted interviews (#2)

**Files:**
- Create: `src/ai/interviewer.ts`, `test/ai-interview.test.ts`
- Modify: `src/cli.ts` (`interview --ai --provider --model --base-url --max-followups --yes`), `src/interview.ts` (hook points), `schemas/v2/interview.schema.json` (optional per-question `origin`), `src/types.ts` (`InterviewQuestion.origin?: { type: "ai"; provider: string; model: string; promptVersion: string }`), `README.md`

**Interfaces (produces):**
```ts
// src/ai/interviewer.ts
export const PROMPT_VERSION = "interview-v1";
export interface AiInterviewOptions { provider: AiProvider; report: ReadinessReport; evidence: Array<{ file: string; excerpt: string }>; maxQuestions?: number; maxFollowups?: number; }
export async function generateQuestions(options: AiInterviewOptions): Promise<InterviewQuestion[]>; // asks provider for JSON array [{question, category, reason, sourceFinding?}]; invalid JSON -> one retry then ProviderError; each result gets id `ai-<n>`, origin stamped; drops questions duplicating existing ids/questions case-insensitively
export async function generateFollowup(provider: AiProvider, question: InterviewQuestion, answer: string): Promise<InterviewQuestion | undefined>; // called when trimmed answer < 60 chars or provider-flagged vague; undefined when model returns NONE
export function detectContradictions(provider: AiProvider, answers: Array<{ question: string; answer: string }>): Promise<string[]>; // list of contradiction descriptions; recorded, never auto-resolved
```

CLI flow for `interview --ai`: resolve settings, create provider; evidence = up to 8 files cited by non-pass findings, excerpted through Task 12 `buildTransmissionPreview` honoring scope; render preview and require confirmation (`--yes` or interactive y/N; refuse in non-TTY without `--yes`); blocked preview aborts with exit 1 listing redactable items. Generated questions append to the deterministic set (bounded by `--max-followups`, default 2, and maxQuestions 5); follow-ups asked inline after vague answers; contradictions appended to the record as unanswered question entries with category "contradiction" and origin stamped. Sessions (Task 6) capture everything, so provider failure mid-interview keeps answers; record provenance in interview v2. Deterministic interview without `--ai` untouched and no provider is ever constructed.

**Tests (fake provider only):** generateQuestions parses, stamps origin/promptVersion, dedupes against existing questions, retries once on invalid JSON then errors; vague answer triggers exactly one follow-up and long answers none; contradiction list lands in record with category contradiction; provider throwing after first answer leaves an open resumable session (drive via conductInterview with injected provider and supplied answers); cancellation (simulated SIGINT handler function) saves session; assert the outbound request content contains no text from files excluded by scope (fake provider records requests).

- [ ] Failing tests, implement, green, typecheck.
- [ ] Commit: `feat: add AI-assisted adaptive interviews (refs #2)`

### Task 14: AI-assisted compilation proposals (#3)

**Files:**
- Create: `src/ai/compiler.ts`, `test/ai-compile.test.ts`
- Modify: `src/cli.ts` (`compile --ai` + provider flags + `--yes`), `README.md`

**Interfaces (produces):**
```ts
// src/ai/compiler.ts
export const COMPILE_PROMPT_VERSION = "compile-v1";
export interface ProposalResult { directory: string; files: string[]; conflicts: number; }
export async function compileWithAi(options: { provider: AiProvider; context: KnowledgeContext; outputDirectory: string; }): Promise<ProposalResult>;
```

Behavior: groups context entries by category; prompts provider per group for (a) consolidated summary, (b) conflicting claims, (c) suggested documentation updates for AGENTS.md, ADRs, runbooks, ownership. Writes `.loreline/proposals/<ISO-stamp>/proposal.md` containing three explicitly separated sections per topic: "Quoted facts" (verbatim answers with source file + interviewee), "Inferred summary" (model output, labeled AI-generated with provider/model/prompt version), "Unresolved and conflicting" (all detected conflicts and unanswered questions); plus `suggestions/<target>.md` proposal files (never patches applied to real docs, never touching files outside the proposals directory). Provenance line on every generated section. Deterministic `compile` path untouched; `--ai` runs deterministic compile first, then proposals. Transmission preview + confirmation identical to Task 13 (context entries are the payload; secrets scan applies).

**Tests (fake provider):** two conflicting interviews produce a proposal flagging the conflict in the unresolved section while both quoted answers appear under quoted facts; incomplete records (unanswered questions) surface under unresolved; no file outside `.loreline/proposals/` is created or modified (snapshot dir listing before/after); provenance lines include provider, model, COMPILE_PROMPT_VERSION; proposal directory returned matches files written.

- [ ] Failing tests, implement, green, typecheck.
- [ ] Commit: `feat: add AI compilation proposals with provenance (refs #3)`

### Task 15: Evaluation suite (#13)

**Files:**
- Create: `test/evals/eval-helpers.ts`, `test/evals/interview-quality.eval.test.ts`, `test/evals/context-quality.eval.test.ts`, `test/fixtures/eval-repo/` (small synthetic repo: README.md, src/main.txt, secrets-excluded/creds.txt with planted fake token built by string concat at fixture-write time in helper, loreline.yaml excluding `secrets-excluded`), `docs/evaluations.md`
- Modify: `package.json` (script `"eval": "node --import tsx --test test/evals/*.eval.test.ts"`; main `npm test` glob already picks them up since they live under test/**: keep them deterministic), `README.md`

Deterministic checks (fake provider, run in CI): question non-duplication (generated set has no case-insensitive duplicate questions); readiness-gap coverage (every non-pass finding id appears as some question's sourceFinding); grounding (every AI question's sourceFinding exists in the report; questions referencing unknown findings are dropped by Task 13 dedupe, asserted here end-to-end); excluded-content leakage (fake provider's recorded requests never contain text from `secrets-excluded/`, hard failure); secret leakage (planted token never appears in requests, artifacts, or proposals, hard failure); contradiction preservation (contradictory fixture answers surface in the record and in compile proposals). Each eval writes a JSON result line `{ eval, provider, model, promptVersion, pass, details }` to `test/evals/results/` (gitignored) via helper `recordEvalResult`. Model-graded evals: helper `maybeRealProvider()` returns undefined unless `LORELINE_EVAL_PROVIDER` env set; when undefined, the model-graded test calls `t.skip()`. `docs/evaluations.md` documents thresholds: leakage failures block release; how to run model-graded evals locally.

- [ ] Write evals (they are the tests), make green, typecheck; add `.gitignore` entry `test/evals/results/`.
- [ ] Commit: `feat: add evaluation suite for question and context quality (refs #13)`

### Task 16: Import and export adapters (#14)

**Files:**
- Create: `src/adapters/types.ts`, `src/adapters/markdown.ts`, `schemas/v1/imports.schema.json`, `test/adapters.test.ts`
- Modify: `src/cli.ts` (`import`, `export` commands), `src/knowledge.ts` (compile includes imported entries), `src/validation.ts` (kind "imports"), `package.json`, `README.md`

**Interfaces (produces):**
```ts
// src/adapters/types.ts
export interface ImportedDocument { sourceId: string; adapter: string; path: string; title: string; content: string; author?: string; updatedAt?: string; link?: string; fingerprint: string; importedAt: string; }
export interface ImportLog { schemaVersion: 1; project: string; documents: ImportedDocument[]; } // .loreline/imports.json
export interface ImportPlan { newDocuments: string[]; changed: string[]; unchanged: string[]; conflicts: Array<{ path: string; reason: string }>; }
export interface KnowledgeAdapter { readonly name: string; plan(source: string, existing: ImportLog | undefined): Promise<ImportPlan>; import(source: string, existing: ImportLog | undefined): Promise<ImportedDocument[]>; export(context: KnowledgeContext, destination: string, options: { force: boolean }): Promise<string[]>; }
export function getAdapter(name: string): KnowledgeAdapter; // "markdown" only; unknown -> error listing available
```

markdown adapter: import walks a folder for `.md`/`.markdown`, preserves title (H1 or frontmatter), author/updated from frontmatter, relative path as sourceId, sha256 fingerprint; unchanged fingerprints are skipped (reported unchanged); changed files re-imported keeping `importedAt` fresh; conflict = same sourceId with different content imported previously AND modified locally in `.loreline/imports.json` (fingerprint mismatch both ways) -> listed, not overwritten. export writes one Markdown file per category into destination (`<category>.md`, entries with provenance lines); refuses to overwrite existing files unless `--force`; always prints the file list and requires `--yes` to write anything (dry-run is the default: `import` without `--yes` prints the ImportPlan only, satisfying "never publish without explicit confirmation" and "dry-run support"). CLI: `loreline import --adapter markdown --source <dir> [--yes]`, `loreline export --adapter markdown --dest <dir> [--yes] [--force]`. Compile: imported documents surface in context as additional `sources` entries only (not answers) plus a `## Imported references` section in context.md listing title/link/provenance; context v2 schema gains optional `imports` array (strict). Each adapter's permissions/data handling documented in README adapters section.

**Tests:** plan on fresh folder = all new; re-plan after import = all unchanged; edit a source file -> changed; tampered log fingerprint -> conflict listed and import leaves it untouched; export dry-run writes nothing, `--yes` writes category files with provenance, existing file without `--force` errors; unknown adapter error lists "markdown"; imports.json round-trips validation.

- [ ] Failing tests, implement, green, typecheck.
- [ ] Commit: `feat: add markdown import and export adapters (refs #14)`

### Task 17: Knowledge risk dashboard and handoff plan (#15)

**Files:**
- Create: `src/handoff.ts`, `test/handoff.test.ts`
- Modify: `src/cli.ts` (`handoff` command), `README.md`

**Interfaces (produces):**
```ts
// src/handoff.ts
export interface HandoffRisk { id: string; title: string; severity: number; factors: string[]; recommendedTopics: string[]; suggestedValidators: string[]; area?: string; }
export interface HandoffPlan { schemaVersion: 1; generatedAt: string; project: string; departing?: string; departureDate?: string; risks: HandoffRisk[]; openQuestions: Array<{ question: string; sourceFile: string }>; verificationSummary?: { valid: boolean; issues: number }; }
export async function buildHandoffPlan(options: { config: LorelineConfig; outputDirectory: string; report?: ReadinessReport; history?: HistoryInsights; departing?: string; departureDate?: string; redactNames?: boolean }): Promise<HandoffPlan>;
export function renderHandoffPlan(plan: HandoffPlan): string; // handoff.md for managers
```

Severity model (explainable, every factor echoed as a human sentence in `factors`): missing/partial readiness findings contribute finding weight (missing full, partial half); an area with topShare > 0.8 and >= 5 commits adds 15 ("single-person dependency: ..."), doubled when `departing` matches that top contributor case-insensitively; stale citations or failed verification add 10; disputed or stale approvals add 10 per affected category; unanswered interview questions add 5 per category with gaps. Risks sorted by severity desc, capped at 20. `recommendedTopics` maps the risk to interview categories (reuse FINDING_QUESTIONS categories; concentration risks recommend "ownership" and the affected area). `suggestedValidators` = second-largest contributor for the area when history is available, else the configured project owner. Departure timeline: with `--date`, risks gain factor "days until departure: N" and severity +10 when under 30 days. `--redact-names` replaces contributor names with "Contributor 1..N" consistently. No performance wording anywhere; methodology sentence from history is quoted in the Markdown footer. Inputs are whatever artifacts exist in `.loreline/` (readiness.json, verification.json, reviews.json, context.json), all optional: with nothing available the command errors "run loreline scan first". Outputs `.loreline/handoff.md` and `.loreline/handoff.json` (add "handoff" artifact kind, `schemas/v1/handoff.schema.json`, strict, registered in validation + package.json exports; include this schema file in this task).

CLI: `loreline handoff [--departing <name>] [--date <YYYY-MM-DD>] [--redact-names] [--json]`.

**Tests:** synthetic inputs (write temp `.loreline` artifacts) produce ranked risks with expected ordering (concentration + departing person outranks a plain missing finding); every risk has >= 1 factor sentence and factors mention no performance terms (assert banned words absent: "performance", "productivity", "output"); redaction is consistent (same contributor same alias, no real name in md/json); missing artifacts degrade gracefully; handoff.json validates.

- [ ] Failing tests, implement, green, typecheck.
- [ ] Commit: `feat: add knowledge risk dashboard and handoff plan (refs #15)`

---

## Final integration steps

- [ ] Run full `npm test`, `npm run typecheck`, `npm run build`, and `node dist/cli.js scan --path .` smoke test.
- [ ] Update README Status section to reflect shipped features; ensure schema list covers every exported schema.
- [ ] Review `git log` for one commit per task; push branch and open PRs per milestone (or a single stacked PR series) referencing the issues.

## Self-review notes

- Spec coverage: #16 T1, #17 T2, #9 T3, #10 policy T4, #12 T5, #11 T6, #6 T7, #7 T8, #4 T9, #5 T10, #1 T11, #8 T12, #2 T13, #3 T14, #13 T15, #14 T16, #15 T17. Interactive picker for #6 is minimal (numbered list) by design; richer TUI deferred.
- Type consistency: `Citation` (T5) reused in T7 scope assertions, T10, T17; `AiProvider` (T11) consumed by T13, T14, T15; `HistoryInsights` (T9) consumed by T17; session (T6) consumed by T13. Task authors must import, not redeclare.
- Schema version map after all tasks: config [1,2], readiness [1,2], interview [1,2], context [1,2], verification [1], session [1], reviews [1], imports [1], handoff [1].
