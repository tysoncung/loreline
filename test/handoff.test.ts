import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { defaultConfig } from "../src/config.js";
import { buildHandoffPlan, renderHandoffPlan, writeHandoffPlan } from "../src/handoff.js";
import type { HandoffPlan } from "../src/handoff.js";
import type { HistoryInsights } from "../src/history.js";
import type { LorelineConfig } from "../src/types.js";
import { validateArtifact } from "../src/validation.js";

const BANNED_WORDS = ["performance", "productivity", "output"];

function config(root: string): LorelineConfig {
  const cfg = defaultConfig(root);
  cfg.project.name = "example";
  cfg.project.owner = "Morgan Lee";
  return cfg;
}

const READINESS = {
  schemaVersion: 2,
  generatedAt: "2026-08-01T00:00:00.000Z",
  root: ".",
  score: 40,
  summary: { passed: 5, partial: 1, missing: 2, filesScanned: 12 },
  findings: [
    {
      id: "operations",
      title: "Operations and troubleshooting",
      status: "missing",
      weight: 15,
      evidence: [],
      recommendation: "Add runbooks covering deployment, common failures, diagnostics, and recovery.",
    },
    {
      id: "ownership",
      title: "Explicit ownership",
      status: "missing",
      weight: 15,
      evidence: [],
      recommendation: "Document maintainers and subject-matter experts using CODEOWNERS or ownership metadata.",
    },
    {
      id: "verification",
      title: "Automated verification",
      status: "partial",
      weight: 15,
      evidence: [],
      recommendation: "Provide a documented, automated test or verification command.",
    },
    {
      id: "project-overview",
      title: "Project overview",
      status: "pass",
      weight: 15,
      evidence: [],
      recommendation: "Add a README explaining the project's purpose, users, boundaries, and setup.",
    },
  ],
  history: {
    available: true,
    analyzedCommits: 40,
    excludedIdentities: [],
    methodology:
      "Counts each commit once per area (the first path segment of files it touched, or \"(root)\" " +
      "for files at the repository root) per contributor, from up to the most recent commits analyzed. " +
      "This is a familiarity signal derived from commit-touch frequency, not a measure of code ownership, " +
      "current expertise, or contribution quality, and it excludes bot identities and any configured exclusions.",
    areas: [
      {
        area: "payments",
        commits: 20,
        lastChangeAt: "2026-07-01T00:00:00.000Z",
        contributors: [
          { name: "Jamie Diaz", commits: 18, share: 0.9, lastCommitAt: "2026-07-01T00:00:00.000Z" },
          { name: "Riley Chen", commits: 2, share: 0.1, lastCommitAt: "2026-06-01T00:00:00.000Z" },
        ],
        topShare: 0.9,
      },
      {
        area: "docs",
        commits: 6,
        lastChangeAt: "2026-05-01T00:00:00.000Z",
        contributors: [{ name: "Riley Chen", commits: 6, share: 1, lastCommitAt: "2026-05-01T00:00:00.000Z" }],
        topShare: 1,
      },
    ],
  },
};

const VERIFICATION = {
  schemaVersion: 1,
  generatedAt: "2026-08-02T00:00:00.000Z",
  project: "example",
  recordsChecked: 1,
  valid: false,
  issues: [
    {
      file: "src/payments.ts",
      severity: "warning",
      message:
        'Cited evidence changed since the readiness scan for "Automated verification": `src/payments.ts`.',
    },
  ],
};

const CONTEXT = {
  schemaVersion: 2,
  generatedAt: "2026-08-03T00:00:00.000Z",
  project: "example",
  owner: "Morgan Lee",
  entries: [
    {
      id: "area-ownership",
      category: "ownership",
      question: "Who owns each major component, and who is the backup when they are unavailable?",
      answer: "Jamie Diaz owns payments.",
      source: { file: "interviews/x.json", interviewee: "Jamie Diaz", generatedAt: "2026-08-01T00:00:00.000Z" },
      review: {
        status: "disputed",
        owner: "Riley Chen",
        reviewedAt: "2026-08-02T00:00:00.000Z",
        reason: "Ownership changed since this was answered.",
        stale: false,
        conflicting: false,
      },
    },
  ],
  unresolved: [
    {
      id: "failure-playbook",
      question: "Describe the most common failure modes, warning signs, and recovery steps.",
      sourceFile: "interviews/x.json",
    },
  ],
  sources: [{ file: "interviews/x.json", interviewee: "Jamie Diaz", generatedAt: "2026-08-01T00:00:00.000Z" }],
};

async function fullFixture(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "loreline-handoff-"));
  const outputDirectory = path.join(root, ".loreline");
  await mkdir(outputDirectory, { recursive: true });
  await writeFile(path.join(outputDirectory, "readiness.json"), JSON.stringify(READINESS));
  await writeFile(path.join(outputDirectory, "verification.json"), JSON.stringify(VERIFICATION));
  await writeFile(path.join(outputDirectory, "context.json"), JSON.stringify(CONTEXT));
  return root;
}

function assertNoBannedWords(text: string): void {
  for (const word of BANNED_WORDS) {
    assert.ok(!text.toLowerCase().includes(word), `banned word "${word}" found in: ${text}`);
  }
}

test("ranks a concentration risk for a departing top contributor above a plain missing finding", async () => {
  const root = await fullFixture();
  try {
    const outputDirectory = path.join(root, ".loreline");
    const plan = await buildHandoffPlan({
      config: config(root),
      outputDirectory,
      departing: "jamie diaz",
    });

    assert.ok(plan.risks.length > 0);
    const top = plan.risks[0];
    assert.equal(top?.id, "concentration-payments");
    const operationsIndex = plan.risks.findIndex((risk) => risk.id === "operations");
    assert.ok(operationsIndex > 0, "concentration-payments must outrank the plain missing 'operations' finding");
    assert.ok((top?.severity ?? 0) > (plan.risks[operationsIndex]?.severity ?? 0));
  } finally {
    await rm(root, { recursive: true });
  }
});

test("every risk carries at least one factor sentence and no banned words appear anywhere", async () => {
  const root = await fullFixture();
  try {
    const outputDirectory = path.join(root, ".loreline");
    const plan = await buildHandoffPlan({
      config: config(root),
      outputDirectory,
      departing: "Jamie Diaz",
      departureDate: "2026-09-15",
    });

    assert.ok(plan.risks.length > 0);
    for (const risk of plan.risks) {
      assert.ok(risk.factors.length >= 1, `risk ${risk.id} has no factors`);
    }

    assertNoBannedWords(JSON.stringify(plan));
    assertNoBannedWords(renderHandoffPlan(plan));
  } finally {
    await rm(root, { recursive: true });
  }
});

test("stale/disputed knowledge and failed verification boost matching risks with a named factor", async () => {
  const root = await fullFixture();
  try {
    const outputDirectory = path.join(root, ".loreline");
    const plan = await buildHandoffPlan({ config: config(root), outputDirectory });

    const ownershipRisk = plan.risks.find((risk) => risk.id === "ownership");
    assert.ok(ownershipRisk);
    assert.equal(ownershipRisk?.severity, 25); // 15 (missing) + 10 (disputed review)
    assert.ok(ownershipRisk?.factors.some((factor) => factor.includes("Riley Chen")));

    const verificationRisk = plan.risks.find((risk) => risk.id === "verification");
    assert.ok(verificationRisk);
    assert.equal(verificationRisk?.severity, 27.5); // 7.5 (partial) + 10 (stale citation) + 10 (failed verification)
  } finally {
    await rm(root, { recursive: true });
  }
});

test("--date adds a days-until-departure factor to every risk and +10 severity when under 30 days", async () => {
  const root = await fullFixture();
  try {
    const outputDirectory = path.join(root, ".loreline");
    const near = await buildHandoffPlan({ config: config(root), outputDirectory, departureDate: "2026-09-15" });
    for (const risk of near.risks) {
      assert.ok(risk.factors.some((factor) => /^days until departure: -?\d+$/.test(factor)));
    }
    const operationsNear = near.risks.find((risk) => risk.id === "operations");
    assert.equal(operationsNear?.severity, 25); // 15 base + 10 (under 30 days)

    const far = await buildHandoffPlan({ config: config(root), outputDirectory, departureDate: "2099-01-01" });
    const operationsFar = far.risks.find((risk) => risk.id === "operations");
    assert.equal(operationsFar?.severity, 15); // no +10, far in the future
  } finally {
    await rm(root, { recursive: true });
  }
});

test("rejects a malformed --date", async () => {
  const root = await fullFixture();
  try {
    const outputDirectory = path.join(root, ".loreline");
    await assert.rejects(
      buildHandoffPlan({ config: config(root), outputDirectory, departureDate: "09/15/2026" }),
    );
  } finally {
    await rm(root, { recursive: true });
  }
});

test("--redact-names replaces contributor and review-owner names consistently and never in md/json, while leaving the config owner intact", async () => {
  const root = await fullFixture();
  try {
    const outputDirectory = path.join(root, ".loreline");
    const plan = await buildHandoffPlan({
      config: config(root),
      outputDirectory,
      departing: "jamie diaz",
      redactNames: true,
    });

    const json = JSON.stringify(plan);
    const markdown = renderHandoffPlan(plan);
    for (const text of [json, markdown]) {
      assert.ok(!text.includes("Jamie Diaz"));
      assert.ok(!text.includes("Riley Chen"));
      assert.ok(text.includes("Morgan Lee"), "config project owner must not be redacted");
    }

    // Riley Chen appears as the docs area's top contributor, as payments'
    // second contributor (a suggested validator), and as the disputed
    // review's owner: all three must resolve to the same alias.
    const docsRisk = plan.risks.find((risk) => risk.id === "concentration-docs");
    const paymentsRisk = plan.risks.find((risk) => risk.id === "concentration-payments");
    const ownershipRisk = plan.risks.find((risk) => risk.id === "ownership");
    assert.ok(docsRisk && paymentsRisk && ownershipRisk);

    const rileyAliasInDocs = docsRisk?.factors.find((f) => /Contributor \d+/.test(f))?.match(/Contributor \d+/)?.[0];
    assert.ok(rileyAliasInDocs);
    assert.ok(paymentsRisk?.suggestedValidators.includes(rileyAliasInDocs as string));
    assert.ok(ownershipRisk?.factors.some((f) => f.includes(rileyAliasInDocs as string)));

    // Jamie Diaz was named as the departing top contributor for payments.
    assert.equal(plan.departing, "Contributor 1");
    assert.ok(paymentsRisk?.factors.some((f) => f.startsWith("Contributor 1 ") || f.includes("Contributor 1")));
  } finally {
    await rm(root, { recursive: true });
  }
});

test("degrades gracefully when only readiness.json exists", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "loreline-handoff-"));
  try {
    const outputDirectory = path.join(root, ".loreline");
    await mkdir(outputDirectory, { recursive: true });
    await writeFile(path.join(outputDirectory, "readiness.json"), JSON.stringify(READINESS));

    const plan = await buildHandoffPlan({ config: config(root), outputDirectory });
    assert.equal(plan.verificationSummary, undefined);
    assert.deepEqual(plan.openQuestions, []);
    assert.ok(plan.risks.length > 0);
    assert.equal(plan.methodology, READINESS.history.methodology);
  } finally {
    await rm(root, { recursive: true });
  }
});

test("errors with a scan-first message when no readiness report exists anywhere", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "loreline-handoff-"));
  try {
    const outputDirectory = path.join(root, ".loreline");
    await assert.rejects(
      buildHandoffPlan({ config: config(root), outputDirectory }),
      /run loreline scan first/,
    );
  } finally {
    await rm(root, { recursive: true });
  }
});

test("writeHandoffPlan writes a validated handoff.json and a rendered handoff.md", async () => {
  const root = await fullFixture();
  try {
    const outputDirectory = path.join(root, ".loreline");
    const plan = await buildHandoffPlan({ config: config(root), outputDirectory });
    const result = await writeHandoffPlan(plan, outputDirectory);

    const raw = JSON.parse(await readFile(result.jsonPath, "utf8")) as HandoffPlan;
    const validated = await validateArtifact<HandoffPlan>("handoff", raw, result.jsonPath);
    assert.equal(validated.schemaVersion, 1);

    const markdown = await readFile(result.markdownPath, "utf8");
    assert.match(markdown, /^# Handoff Plan/);
    assert.match(markdown, /## Risks/);
    assert.match(markdown, /## Open questions/);
    assert.match(markdown, /## Verification/);
  } finally {
    await rm(root, { recursive: true });
  }
});

test("a report and history passed directly via options are used instead of re-reading disk, and re-run git is never required", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "loreline-handoff-"));
  try {
    const outputDirectory = path.join(root, ".loreline");
    // No readiness.json (v1, no embedded history) is written to disk at all;
    // the report and a separately supplied HistoryInsights are passed in.
    const v1Report = {
      schemaVersion: 1 as const,
      generatedAt: "2026-08-01T00:00:00.000Z",
      root: ".",
      score: 50,
      summary: { passed: 6, partial: 0, missing: 1, filesScanned: 5 },
      findings: [
        {
          id: "operations",
          title: "Operations and troubleshooting",
          status: "missing" as const,
          weight: 15,
          evidence: [],
          recommendation: "Add runbooks.",
        },
      ],
    };
    const plan = await buildHandoffPlan({
      config: config(root),
      outputDirectory,
      report: v1Report,
      history: READINESS.history as HistoryInsights,
    });
    assert.ok(plan.risks.some((risk) => risk.id === "concentration-payments"));
    assert.equal(plan.methodology, READINESS.history.methodology);
  } finally {
    await rm(root, { recursive: true });
  }
});
