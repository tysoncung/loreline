import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { defaultConfig } from "../src/config.js";
import { buildInterviewQuestions } from "../src/interview.js";
import { scanRepository } from "../src/scanner.js";
import { globToRegExp, inScope } from "../src/scope.js";
import type { InterviewRecord, ReadinessReport } from "../src/types.js";
import { validateArtifact } from "../src/validation.js";

test("globToRegExp: ** crosses directories, * and ? never cross a path separator", () => {
  assert.ok(globToRegExp("**/*.md").test("a/b/c.md"));
  assert.ok(globToRegExp("**/*.md").test("c.md"));
  assert.ok(!globToRegExp("*.md").test("a/b.md"));
  assert.ok(globToRegExp("*.md").test("b.md"));
  assert.ok(globToRegExp("src/**").test("src/x/y"));
  assert.ok(globToRegExp("src/**").test("src/x"));
  assert.ok(globToRegExp("a?c").test("abc"));
  assert.ok(!globToRegExp("a?c").test("ac"));
  assert.ok(!globToRegExp("a?c").test("a/c"));
});

test("inScope: empty include means everything is included, and exclude wins over include", () => {
  assert.equal(inScope("src/index.ts", { include: [], exclude: [] }), true);
  assert.equal(inScope("src/index.ts", { include: ["src/**"], exclude: [] }), true);
  assert.equal(inScope("docs/readme.md", { include: ["src/**"], exclude: [] }), false);
  assert.equal(
    inScope("src/index.ts", { include: ["src/**"], exclude: ["src/index.ts"] }),
    false,
  );
  assert.equal(inScope("src/index.ts", { include: [], exclude: ["src/**"] }), false);
});

test("scan honors a CLI --exclude glob: excluded files never appear in filesScanned, evidence, or citations", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "loreline-scope-"));
  try {
    await mkdir(path.join(root, "docs"), { recursive: true });
    await writeFile(path.join(root, "README.md"), "# Example\n");
    await writeFile(path.join(root, "docs", "architecture.md"), "# Architecture\n");

    const config = defaultConfig(root);
    const report = await scanRepository(root, config, { include: [], exclude: ["docs/**"] });

    assert.deepEqual(report.scope, {
      include: config.scan.include,
      exclude: [...config.scan.exclude, "docs/**"],
    });
    assert.equal(report.summary.filesScanned, 1);

    const evidence = report.findings.flatMap((finding) => finding.evidence);
    assert.ok(!evidence.some((file) => file.startsWith("docs/")));

    const citedFiles = report.findings.flatMap((finding) =>
      (finding.citations ?? []).map((citation) => citation.file),
    );
    assert.ok(!citedFiles.some((file) => file.startsWith("docs/")));
  } finally {
    await rm(root, { recursive: true });
  }
});

test("scan honors a CLI --include glob by replacing config includes, so it genuinely narrows the scan", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "loreline-scope-"));
  try {
    await mkdir(path.join(root, "src"), { recursive: true });
    await mkdir(path.join(root, "docs"), { recursive: true });
    await writeFile(path.join(root, "README.md"), "# Example\n");
    await writeFile(path.join(root, "src", "index.ts"), "export {};\n");
    await writeFile(path.join(root, "docs", "architecture.md"), "# Architecture\n");

    const config = defaultConfig(root);
    const report = await scanRepository(root, config, { include: ["src/**"], exclude: [] });

    assert.deepEqual(report.scope, {
      include: ["src/**"],
      exclude: config.scan.exclude,
    });
    assert.equal(report.summary.filesScanned, 1);

    const evidence = report.findings.flatMap((finding) => finding.evidence);
    assert.ok(!evidence.some((file) => file.startsWith("docs/")));
    assert.ok(!evidence.includes("README.md"));
  } finally {
    await rm(root, { recursive: true });
  }
});

test("scan without scope flags omits the scope field, matching today's behavior", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "loreline-scope-"));
  try {
    await writeFile(path.join(root, "README.md"), "# Example\n");
    const report = await scanRepository(root, defaultConfig(root));
    assert.equal(report.scope, undefined);
    assert.ok(!("scope" in report));
  } finally {
    await rm(root, { recursive: true });
  }
});

function readinessWithFindings(): ReadinessReport {
  return {
    schemaVersion: 2,
    generatedAt: new Date().toISOString(),
    root: ".",
    score: 0,
    summary: { passed: 0, partial: 0, missing: 2, filesScanned: 0 },
    findings: [
      {
        id: "architecture",
        title: "Architecture",
        status: "missing",
        weight: 1,
        evidence: [],
        recommendation: "Document it.",
      },
      {
        id: "operations",
        title: "Operations",
        status: "missing",
        weight: 1,
        evidence: [],
        recommendation: "Document it.",
      },
    ],
  };
}

test("buildInterviewQuestions filters targeted questions by finding id and all questions by category", () => {
  const report = readinessWithFindings();

  const byFinding = buildInterviewQuestions(report, { findings: ["architecture"] });
  assert.ok(byFinding.some((question) => question.sourceFinding === "architecture"));
  assert.ok(!byFinding.some((question) => question.sourceFinding === "operations"));
  assert.ok(byFinding.some((question) => question.sourceFinding === undefined));

  const byCategory = buildInterviewQuestions(report, { categories: ["risk"] });
  assert.ok(byCategory.length > 0);
  assert.ok(byCategory.every((question) => question.category === "risk"));

  const both = buildInterviewQuestions(report, {
    findings: ["architecture"],
    categories: ["architecture"],
  });
  assert.deepEqual(both.map((question) => question.id), ["system-shape"]);
});

test("an interview record with scope validates against v2, and a v1-shaped record without scope still validates via v1", async () => {
  const withScope: InterviewRecord = {
    schemaVersion: 2,
    generatedAt: "2026-09-01T00:00:00.000Z",
    project: "example",
    interviewee: "Alex",
    interviewer: "Loreline",
    sourceReport: ".loreline/readiness.json",
    answers: [],
    unanswered: [],
    scope: { categories: ["risk"], findings: ["architecture"] },
  };
  const validated = await validateArtifact<InterviewRecord>("interview", withScope, "in-memory.json");
  assert.deepEqual(validated, withScope);

  const v1Record = {
    schemaVersion: 1,
    generatedAt: "2026-09-01T00:00:00.000Z",
    project: "example",
    interviewee: "Alex",
    interviewer: "Loreline",
    sourceReport: ".loreline/readiness.json",
    answers: [],
    unanswered: [],
  };
  const validatedV1 = await validateArtifact("interview", v1Record, "in-memory-v1.json");
  assert.deepEqual(validatedV1, v1Record);
});
