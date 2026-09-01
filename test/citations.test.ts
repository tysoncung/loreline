import assert from "node:assert/strict";
import { appendFile, mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { defaultConfig } from "../src/config.js";
import { checkCitation, citeFile } from "../src/citations.js";
import { verifyKnowledge } from "../src/knowledge.js";
import { scanRepository, writeReport } from "../src/scanner.js";
import type { InterviewRecord } from "../src/types.js";

test("citeFile produces a 64-char hex fingerprint and the relative path", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "loreline-cite-"));
  try {
    await writeFile(path.join(root, "README.md"), "# Example\n");
    const citation = await citeFile(root, "README.md");

    assert.equal(citation.file, "README.md");
    assert.equal(citation.kind, "evidence");
    assert.match(citation.fingerprint, /^[0-9a-f]{64}$/);
  } finally {
    await rm(root, { recursive: true });
  }
});

test("checkCitation returns intact for unchanged evidence and changed after a byte is appended", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "loreline-cite-"));
  try {
    await writeFile(path.join(root, "notes.md"), "content\n");
    const citation = await citeFile(root, "notes.md");

    assert.equal(await checkCitation(root, citation), "intact");

    await appendFile(path.join(root, "notes.md"), "x");
    assert.equal(await checkCitation(root, citation), "changed");
  } finally {
    await rm(root, { recursive: true });
  }
});

test("checkCitation returns missing after the cited file is deleted", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "loreline-cite-"));
  try {
    await writeFile(path.join(root, "notes.md"), "content\n");
    const citation = await citeFile(root, "notes.md");

    await rm(path.join(root, "notes.md"));
    assert.equal(await checkCitation(root, citation), "missing");
  } finally {
    await rm(root, { recursive: true });
  }
});

test("checkCitation returns missing at the old path after the cited file moves", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "loreline-cite-"));
  try {
    await writeFile(path.join(root, "old.md"), "content\n");
    const citation = await citeFile(root, "old.md");

    await rename(path.join(root, "old.md"), path.join(root, "new.md"));
    assert.equal(await checkCitation(root, citation), "missing");
  } finally {
    await rm(root, { recursive: true });
  }
});

test("scanning a repository cites evidence files that all exist on disk", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "loreline-cite-scan-"));
  try {
    await writeFile(path.join(root, "README.md"), "# Example\n");
    await writeFile(
      path.join(root, "package.json"),
      JSON.stringify({ scripts: { test: "node --test" } }),
    );

    const report = await scanRepository(root, defaultConfig(root));
    assert.equal(report.schemaVersion, 2);

    const citedFindings = report.findings.filter((finding) => (finding.citations?.length ?? 0) > 0);
    assert.ok(citedFindings.length > 0);
    for (const finding of citedFindings) {
      for (const citation of finding.citations ?? []) {
        assert.equal(citation.kind, "evidence");
        assert.match(citation.fingerprint, /^[0-9a-f]{64}$/);
        assert.equal(await checkCitation(root, citation), "intact");
      }
    }
  } finally {
    await rm(root, { recursive: true });
  }
});

test("verifyKnowledge reports stale evidence when a cited file changes after scanning", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "loreline-cite-verify-"));
  try {
    await writeFile(path.join(root, "README.md"), "# Example\n");
    await writeFile(
      path.join(root, "package.json"),
      JSON.stringify({ scripts: { test: "node --test" } }),
    );

    const config = defaultConfig(root);
    const outputDirectory = path.join(root, ".loreline");
    const report = await scanRepository(root, config);
    await writeReport(report, outputDirectory);

    const interviewsDirectory = path.join(outputDirectory, "interviews");
    await mkdir(interviewsDirectory, { recursive: true });
    const interview: InterviewRecord = {
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      project: config.project.name,
      interviewee: "Alex",
      interviewer: "Loreline",
      sourceReport: ".loreline/readiness.json",
      answers: [],
      unanswered: [],
    };
    await writeFile(path.join(interviewsDirectory, "interview.json"), JSON.stringify(interview));

    // Doctor the evidence after the scan captured its fingerprint.
    await appendFile(path.join(root, "README.md"), "doctored\n");

    const result = await verifyKnowledge(config, outputDirectory, 180, root, new Date());
    assert.equal(result.valid, false);
    assert.ok(result.issues.some((issue) => issue.message.includes("evidence changed")));
  } finally {
    await rm(root, { recursive: true });
  }
});

test("verifyKnowledge reports missing evidence when a cited file is deleted after scanning", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "loreline-cite-verify-"));
  try {
    await writeFile(path.join(root, "README.md"), "# Example\n");
    await writeFile(
      path.join(root, "package.json"),
      JSON.stringify({ scripts: { test: "node --test" } }),
    );

    const config = defaultConfig(root);
    const outputDirectory = path.join(root, ".loreline");
    const report = await scanRepository(root, config);
    await writeReport(report, outputDirectory);

    const interviewsDirectory = path.join(outputDirectory, "interviews");
    await mkdir(interviewsDirectory, { recursive: true });
    const interview: InterviewRecord = {
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      project: config.project.name,
      interviewee: "Alex",
      interviewer: "Loreline",
      sourceReport: ".loreline/readiness.json",
      answers: [],
      unanswered: [],
    };
    await writeFile(path.join(interviewsDirectory, "interview.json"), JSON.stringify(interview));

    await rm(path.join(root, "README.md"));

    const result = await verifyKnowledge(config, outputDirectory, 180, root, new Date());
    assert.equal(result.valid, false);
    assert.ok(result.issues.some((issue) => issue.message.includes("evidence missing")));
  } finally {
    await rm(root, { recursive: true });
  }
});
