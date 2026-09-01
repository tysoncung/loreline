import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { defaultConfig } from "../src/config.js";
import type { HistoryInsights } from "../src/history.js";
import { buildInterviewQuestions } from "../src/interview.js";
import { scanRepository } from "../src/scanner.js";

// scanRepository is called without an injected history in these fixtures
// (temp directories that are not git repositories), so knowledge-concentration
// always lands on "partial" (unavailable history) and contributes weight 10
// at half credit. Total weight is 110 (the previous 100 plus this finding).

test("scores a repository and identifies missing knowledge", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "loreline-test-"));
  try {
    await writeFile(path.join(root, "README.md"), "# Example\n");
    await writeFile(
      path.join(root, "package.json"),
      JSON.stringify({ scripts: { test: "node --test" } }),
    );

    const report = await scanRepository(root, defaultConfig(root));

    assert.equal(report.score, 32);
    assert.equal(report.summary.passed, 2);
    assert.equal(report.summary.partial, 1);
    assert.equal(report.summary.missing, 5);
    assert.equal(report.findings.find((finding) => finding.id === "project-overview")?.status, "pass");
    assert.equal(report.findings.find((finding) => finding.id === "architecture")?.status, "missing");
    assert.equal(report.findings.find((finding) => finding.id === "knowledge-concentration")?.status, "partial");
    assert.equal(report.findings.length, 8);
    assert.equal(report.history, undefined);
  } finally {
    await rm(root, { recursive: true });
  }
});

test("recognizes a repository with complete knowledge surfaces", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "loreline-test-"));
  try {
    await mkdir(path.join(root, ".github"));
    await mkdir(path.join(root, "docs", "decisions"), { recursive: true });
    await Promise.all([
      writeFile(path.join(root, "README.md"), "# Example\n"),
      writeFile(path.join(root, "AGENTS.md"), "# Agent instructions\n"),
      writeFile(path.join(root, ".github", "CODEOWNERS"), "* @owner\n"),
      writeFile(path.join(root, "docs", "architecture.md"), "# Architecture\n"),
      writeFile(path.join(root, "docs", "decisions", "0001-choice.md"), "# Choice\n"),
      writeFile(path.join(root, "docs", "runbook.md"), "# Runbook\n"),
      writeFile(path.join(root, "package.json"), JSON.stringify({ scripts: { test: "node --test" } })),
    ]);

    const report = await scanRepository(root, defaultConfig(root));
    assert.equal(report.score, 95);
    assert.equal(report.summary.passed, 7);
    assert.equal(report.summary.partial, 1);
  } finally {
    await rm(root, { recursive: true });
  }
});

function syntheticHistory(areas: HistoryInsights["areas"], analyzedCommits = 20): HistoryInsights {
  return {
    available: true,
    analyzedCommits,
    excludedIdentities: [],
    methodology: "test methodology",
    areas,
  };
}

test("knowledge-concentration passes when no qualifying area has a dominant contributor", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "loreline-history-finding-"));
  try {
    await writeFile(path.join(root, "README.md"), "# Example\n");
    const history = syntheticHistory([
      {
        area: "alpha",
        commits: 10,
        lastChangeAt: "2026-01-01T00:00:00Z",
        topShare: 0.6,
        contributors: [
          { name: "A", commits: 6, share: 0.6, lastCommitAt: "2026-01-01T00:00:00Z" },
          { name: "B", commits: 4, share: 0.4, lastCommitAt: "2026-01-01T00:00:00Z" },
        ],
      },
    ]);

    const report = await scanRepository(root, defaultConfig(root), undefined, { history });
    const found = report.findings.find((finding) => finding.id === "knowledge-concentration");

    assert.equal(found?.status, "pass");
    assert.deepEqual(found?.evidence, []);
    assert.equal(found?.citations, undefined);
    assert.deepEqual(report.history, history);
  } finally {
    await rm(root, { recursive: true });
  }
});

test("knowledge-concentration is partial when some but not most qualifying areas are dominated", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "loreline-history-finding-"));
  try {
    await writeFile(path.join(root, "README.md"), "# Example\n");
    const history = syntheticHistory([
      {
        area: "alpha",
        commits: 10,
        lastChangeAt: "2026-01-01T00:00:00Z",
        topShare: 0.9,
        contributors: [
          { name: "A", commits: 9, share: 0.9, lastCommitAt: "2026-01-01T00:00:00Z" },
          { name: "B", commits: 1, share: 0.1, lastCommitAt: "2026-01-01T00:00:00Z" },
        ],
      },
      {
        area: "beta",
        commits: 8,
        lastChangeAt: "2026-01-01T00:00:00Z",
        topShare: 0.5,
        contributors: [
          { name: "C", commits: 4, share: 0.5, lastCommitAt: "2026-01-01T00:00:00Z" },
          { name: "D", commits: 4, share: 0.5, lastCommitAt: "2026-01-01T00:00:00Z" },
        ],
      },
    ]);

    const report = await scanRepository(root, defaultConfig(root), undefined, { history });
    const found = report.findings.find((finding) => finding.id === "knowledge-concentration");

    assert.equal(found?.status, "partial");
    assert.deepEqual(found?.evidence, ["alpha: A authored 90% of 10 commits"]);
  } finally {
    await rm(root, { recursive: true });
  }
});

test("knowledge-concentration is missing when more than half of qualifying areas are dominated", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "loreline-history-finding-"));
  try {
    await writeFile(path.join(root, "README.md"), "# Example\n");
    const history = syntheticHistory([
      {
        area: "alpha",
        commits: 10,
        lastChangeAt: "2026-01-01T00:00:00Z",
        topShare: 0.9,
        contributors: [{ name: "A", commits: 9, share: 0.9, lastCommitAt: "2026-01-01T00:00:00Z" }],
      },
      {
        area: "beta",
        commits: 6,
        lastChangeAt: "2026-01-01T00:00:00Z",
        topShare: 1,
        contributors: [{ name: "B", commits: 6, share: 1, lastCommitAt: "2026-01-01T00:00:00Z" }],
      },
      {
        area: "gamma",
        commits: 5,
        lastChangeAt: "2026-01-01T00:00:00Z",
        topShare: 0.5,
        contributors: [
          { name: "E", commits: 2, share: 0.4, lastCommitAt: "2026-01-01T00:00:00Z" },
          { name: "F", commits: 3, share: 0.6, lastCommitAt: "2026-01-01T00:00:00Z" },
        ],
      },
    ]);

    const report = await scanRepository(root, defaultConfig(root), undefined, { history });
    const found = report.findings.find((finding) => finding.id === "knowledge-concentration");

    assert.equal(found?.status, "missing");
    assert.deepEqual(found?.evidence, [
      "alpha: A authored 90% of 10 commits",
      "beta: B authored 100% of 6 commits",
    ]);
  } finally {
    await rm(root, { recursive: true });
  }
});

test("knowledge-concentration stays partial with empty evidence when history is unavailable, and the report omits history", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "loreline-history-finding-"));
  try {
    await writeFile(path.join(root, "README.md"), "# Example\n");
    const history: HistoryInsights = {
      available: false,
      analyzedCommits: 0,
      excludedIdentities: [],
      methodology: "test methodology",
      areas: [],
    };

    const report = await scanRepository(root, defaultConfig(root), undefined, { history });
    const found = report.findings.find((finding) => finding.id === "knowledge-concentration");

    assert.equal(found?.status, "partial");
    assert.deepEqual(found?.evidence, []);
    assert.equal(report.history, undefined);
  } finally {
    await rm(root, { recursive: true });
  }
});

test("knowledge-concentration stays partial with empty evidence when history has too few analyzed commits", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "loreline-history-finding-"));
  try {
    await writeFile(path.join(root, "README.md"), "# Example\n");
    const history = syntheticHistory(
      [
        {
          area: "alpha",
          commits: 5,
          lastChangeAt: "2026-01-01T00:00:00Z",
          topShare: 1,
          contributors: [{ name: "A", commits: 5, share: 1, lastCommitAt: "2026-01-01T00:00:00Z" }],
        },
      ],
      5,
    );

    const report = await scanRepository(root, defaultConfig(root), undefined, { history });
    const found = report.findings.find((finding) => finding.id === "knowledge-concentration");

    assert.equal(found?.status, "partial");
    assert.deepEqual(found?.evidence, []);
    // available is still true (only analyzedCommits is under the floor), so
    // the top-level history summary is still embedded in the report.
    assert.deepEqual(report.history, history);
  } finally {
    await rm(root, { recursive: true });
  }
});

test("builds targeted questions from readiness gaps", () => {
  const report = {
    schemaVersion: 1 as const,
    generatedAt: new Date().toISOString(),
    root: "/example",
    score: 0,
    summary: { passed: 0, partial: 0, missing: 1, filesScanned: 0 },
    findings: [
      {
        id: "architecture",
        title: "Architecture",
        status: "missing" as const,
        weight: 1,
        evidence: [],
        recommendation: "Document it.",
      },
    ],
  };

  const questions = buildInterviewQuestions(report);
  assert.equal(questions[0]?.sourceFinding, "architecture");
  assert.ok(questions.length > 1);
});
