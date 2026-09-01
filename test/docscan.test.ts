import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { defaultConfig } from "../src/config.js";
import { scanDocuments } from "../src/docscan.js";

const FIXTURE_ROOT = path.join(import.meta.dirname, "fixtures", "docs-collection");

// Copies the committed fixture into a fresh temp directory (byte-for-byte,
// via read+write) so every copied file's mtime is "now" at copy time. That
// makes the mtime-fallback branch of doc-freshness deterministic: any
// document without a frontmatter date is fresh because it was just written.
async function copyFixture(destRoot: string): Promise<void> {
  await copyDir(FIXTURE_ROOT, destRoot);
}

async function copyDir(source: string, dest: string): Promise<void> {
  await mkdir(dest, { recursive: true });
  const entries = await readdir(source, { withFileTypes: true });
  for (const entry of entries) {
    const from = path.join(source, entry.name);
    const to = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      await copyDir(from, to);
    } else {
      await writeFile(to, await readFile(from));
    }
  }
}

// The fixture (test/fixtures/docs-collection/) has 5 readable documents:
//   README.md               - H1, links to guides/onboarding.md and
//                              policies/security-policy.md
//   guides/onboarding.md    - frontmatter title + owner + updated 2026-08-01
//   policies/security-policy.md - H1 ("Security Policy"), no frontmatter
//   notes/orphan.txt        - plain text, no heading, not linked from anywhere
//   glossary.md             - H1 "Glossary"
// Plus one file written directly into the temp copy: binary.md, containing
// bytes that are not valid UTF-8 (0xff is not a legal standalone UTF-8 lead
// byte). It is not part of the committed fixture so git stays clean.
//
// Coverage math (denominator is always 5: the readable documents; binary.md
// is excluded from every percentage as unreadable):
//   doc-purpose:  README, onboarding, security-policy, glossary all open
//                 with an H1 or frontmatter title; orphan.txt has neither.
//                 4/5 = 80%  -> pass (>= 80%)
//   doc-ownership: only onboarding.md has frontmatter owner/author.
//                 1/5 = 20%  -> missing (< 50%)
//   doc-freshness: onboarding.md is fresh via its frontmatter `updated`
//                 date (2026-08-01, ~31 days before "now"); every other
//                 document is fresh via mtime (copied moments ago).
//                 5/5 = 100% -> pass (>= 80%)
//   doc-structure: README.md exists at the fixture root -> pass
//   doc-linkage:  referenced = README.md (root entry point, counted by
//                 default) + guides/onboarding.md + policies/security-policy.md
//                 (both linked from README.md) = 3. orphan.txt and
//                 glossary.md are never linked -> orphans.
//                 3/5 = 60%  -> pass (>= 60%)
//   doc-terminology: glossary.md matches /glossary/i in its filename -> pass
//   doc-operations: policies/security-policy.md matches /policy/i in its
//                 filename and has body content beyond its heading -> pass
//                 (>= 1 matching document with content)
//
// Weights: purpose 15, ownership 15, freshness 15, structure 10, linkage 15,
// terminology 10, operations 20 (sums to 100).
// Earned = 15 (purpose) + 0 (ownership) + 15 (freshness) + 10 (structure)
//        + 15 (linkage) + 10 (terminology) + 20 (operations) = 85.
// Score = round(85 / 100 * 100) = 85.

async function withDocsFixture(
  run: (root: string) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(path.join(tmpdir(), "loreline-docscan-"));
  try {
    await copyFixture(root);
    await writeFile(path.join(root, "binary.md"), Buffer.from([0xff, 0xfe, 0xfd, 0x00, 0x01, 0x02]));
    await run(root);
  } finally {
    await rm(root, { recursive: true });
  }
}

test("scans a document collection and reports mode documents", async () => {
  await withDocsFixture(async (root) => {
    const report = await scanDocuments(root, defaultConfig(root));
    assert.equal(report.schemaVersion, 2);
    assert.equal(report.mode, "documents");
  });
});

test("flags the invalid-UTF-8 file as unreadable and excludes it from filesScanned", async () => {
  await withDocsFixture(async (root) => {
    const report = await scanDocuments(root, defaultConfig(root));
    assert.deepEqual(report.unreadable, ["binary.md"]);
    assert.equal(report.summary.filesScanned, 5);
  });
});

test("doc-terminology passes when a glossary file exists", async () => {
  await withDocsFixture(async (root) => {
    const report = await scanDocuments(root, defaultConfig(root));
    const finding = report.findings.find((entry) => entry.id === "doc-terminology");
    assert.equal(finding?.status, "pass");
    assert.equal(finding?.weight, 10);
  });
});

test("doc-ownership is missing when only one of five documents declares an owner", async () => {
  await withDocsFixture(async (root) => {
    const report = await scanDocuments(root, defaultConfig(root));
    const finding = report.findings.find((entry) => entry.id === "doc-ownership");
    assert.equal(finding?.status, "missing");
    assert.equal(finding?.weight, 15);
    assert.deepEqual(
      finding?.evidence.slice().sort(),
      ["README.md", "glossary.md", "notes/orphan.txt", "policies/security-policy.md"].sort(),
    );
  });
});

test("doc-linkage lists notes/orphan.txt as an orphan and passes at 60% referenced", async () => {
  await withDocsFixture(async (root) => {
    const report = await scanDocuments(root, defaultConfig(root));
    const finding = report.findings.find((entry) => entry.id === "doc-linkage");
    assert.equal(finding?.status, "pass");
    assert.ok(finding?.evidence.includes("notes/orphan.txt"));
  });
});

test("doc-purpose passes at 80% coverage with orphan.txt as the only offender", async () => {
  await withDocsFixture(async (root) => {
    const report = await scanDocuments(root, defaultConfig(root));
    const finding = report.findings.find((entry) => entry.id === "doc-purpose");
    assert.equal(finding?.status, "pass");
    assert.deepEqual(finding?.evidence, ["notes/orphan.txt"]);
  });
});

test("doc-freshness and doc-structure and doc-operations pass for the fixture", async () => {
  await withDocsFixture(async (root) => {
    const report = await scanDocuments(root, defaultConfig(root));
    assert.equal(report.findings.find((entry) => entry.id === "doc-freshness")?.status, "pass");
    assert.equal(report.findings.find((entry) => entry.id === "doc-structure")?.status, "pass");
    const operations = report.findings.find((entry) => entry.id === "doc-operations");
    assert.equal(operations?.status, "pass");
    assert.deepEqual(operations?.evidence, ["policies/security-policy.md"]);
  });
});

test("computes an overall score matching the weighted coverage math", async () => {
  await withDocsFixture(async (root) => {
    const report = await scanDocuments(root, defaultConfig(root));
    assert.ok(typeof report.score === "number" && report.score >= 0 && report.score <= 100);
    assert.equal(report.score, 85);
    assert.equal(report.summary.passed, 6);
    assert.equal(report.summary.partial, 0);
    assert.equal(report.summary.missing, 1);
    assert.equal(typeof report.summary.filesScanned, "number");
  });
});

test("attaches citations to evidence files", async () => {
  await withDocsFixture(async (root) => {
    const report = await scanDocuments(root, defaultConfig(root));
    const withEvidence = report.findings.filter((finding) => finding.evidence.length > 0);
    assert.ok(withEvidence.length > 0);
    for (const finding of withEvidence) {
      assert.ok(finding.citations && finding.citations.length === finding.evidence.length);
    }
  });
});

test("tolerates malformed frontmatter instead of crashing", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "loreline-docscan-frontmatter-"));
  try {
    // The unterminated flow mapping on the owner line makes this an invalid
    // YAML document; the frontmatter parser must fall back to treating the
    // whole file as body content (no frontmatter) rather than throwing. The
    // H1 further down still counts for doc-purpose (it falls within the
    // fallback body's first 5 lines), but no owner is ever recognized since
    // the "owner:" line is never parsed as frontmatter.
    await writeFile(
      path.join(root, "broken.md"),
      "---\nowner: [unterminated\n---\n\n# Broken Frontmatter\n\nBody content.\n",
    );

    const report = await scanDocuments(root, defaultConfig(root));

    assert.deepEqual(report.unreadable, []);
    assert.equal(report.summary.filesScanned, 1);
    assert.equal(report.findings.find((entry) => entry.id === "doc-purpose")?.status, "pass");
    assert.equal(report.findings.find((entry) => entry.id === "doc-ownership")?.status, "missing");
  } finally {
    await rm(root, { recursive: true });
  }
});
