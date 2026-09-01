import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { defaultConfig } from "../src/config.js";
import { buildInterviewQuestions } from "../src/interview.js";
import { scanRepository } from "../src/scanner.js";

test("scores a repository and identifies missing knowledge", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "loreline-test-"));
  try {
    await writeFile(path.join(root, "README.md"), "# Example\n");
    await writeFile(
      path.join(root, "package.json"),
      JSON.stringify({ scripts: { test: "node --test" } }),
    );

    const report = await scanRepository(root, defaultConfig(root));

    assert.equal(report.score, 30);
    assert.equal(report.summary.passed, 2);
    assert.equal(report.summary.missing, 5);
    assert.equal(report.findings.find((finding) => finding.id === "project-overview")?.status, "pass");
    assert.equal(report.findings.find((finding) => finding.id === "architecture")?.status, "missing");
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
    assert.equal(report.score, 100);
    assert.equal(report.summary.passed, 7);
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
