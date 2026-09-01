import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { defaultConfig } from "../src/config.js";
import { compileKnowledge } from "../src/knowledge.js";
import { getAdapter, loadImportLog, saveImportLog, type ImportLog } from "../src/adapters/types.js";
import { plannedExportPaths } from "../src/adapters/markdown.js";
import type { InterviewRecord, KnowledgeContext } from "../src/types.js";
import { validateArtifact } from "../src/validation.js";

async function sourceFixture(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "loreline-import-source-"));
  for (const [relativePath, content] of Object.entries(files)) {
    const absolute = path.join(root, relativePath);
    await mkdir(path.dirname(absolute), { recursive: true });
    await writeFile(absolute, content);
  }
  return root;
}

function sampleContext(overrides: Partial<KnowledgeContext> = {}): KnowledgeContext {
  return {
    schemaVersion: 2,
    generatedAt: "2026-09-01T00:00:00.000Z",
    project: "example",
    owner: "platform-team",
    entries: [
      {
        id: "system-shape",
        category: "architecture",
        question: "How does the system work?",
        answer: "Requests enter through the API and are processed by workers.",
        source: { file: "interviews/alex.json", interviewee: "Alex", generatedAt: "2026-08-01T00:00:00.000Z" },
      },
      {
        id: "ownership",
        category: "risk",
        question: "Who owns this service?",
        answer: "The platform team owns it.",
        source: { file: "interviews/alex.json", interviewee: "Alex", generatedAt: "2026-08-01T00:00:00.000Z" },
        review: {
          status: "approved",
          owner: "Jamie",
          reviewedAt: "2026-08-05T00:00:00.000Z",
          stale: false,
          conflicting: false,
        },
      },
    ],
    unresolved: [],
    sources: [{ file: "interviews/alex.json", interviewee: "Alex", generatedAt: "2026-08-01T00:00:00.000Z" }],
    ...overrides,
  };
}

test("plan on a fresh source folder reports every markdown file as new", async () => {
  const source = await sourceFixture({
    "overview.md": "# Overview\n\nThis system handles payments.\n",
    "notes/glossary.md": "# Glossary\n\nSome terms.\n",
  });
  try {
    const adapter = getAdapter("markdown");
    const plan = await adapter.plan(source, undefined);
    assert.deepEqual(plan.newDocuments, ["notes/glossary.md", "overview.md"]);
    assert.deepEqual(plan.changed, []);
    assert.deepEqual(plan.unchanged, []);
    assert.deepEqual(plan.conflicts, []);
  } finally {
    await rm(source, { recursive: true });
  }
});

test("re-planning after import reports every document as unchanged", async () => {
  const source = await sourceFixture({
    "overview.md": "# Overview\n\nThis system handles payments.\n",
  });
  try {
    const adapter = getAdapter("markdown");
    const documents = await adapter.import(source, undefined);
    const log: ImportLog = { schemaVersion: 1, project: "example", documents };

    const plan = await adapter.plan(source, log);
    assert.deepEqual(plan.newDocuments, []);
    assert.deepEqual(plan.changed, []);
    assert.deepEqual(plan.unchanged, ["overview.md"]);
    assert.deepEqual(plan.conflicts, []);
  } finally {
    await rm(source, { recursive: true });
  }
});

test("re-importing an unchanged document returns it deep-equal to the original, including importedAt", async () => {
  const source = await sourceFixture({
    "overview.md": "# Overview\n\nThis system handles payments.\n",
  });
  try {
    const adapter = getAdapter("markdown");
    const documents = await adapter.import(source, undefined);
    const log: ImportLog = { schemaVersion: 1, project: "example", documents };

    const reimported = await adapter.import(source, log);
    assert.equal(reimported.length, 1);
    assert.deepEqual(reimported[0], documents[0]);
  } finally {
    await rm(source, { recursive: true });
  }
});

test("editing a source file after import is reported as changed", async () => {
  const source = await sourceFixture({
    "overview.md": "# Overview\n\nThis system handles payments.\n",
  });
  try {
    const adapter = getAdapter("markdown");
    const documents = await adapter.import(source, undefined);
    const log: ImportLog = { schemaVersion: 1, project: "example", documents };

    await writeFile(
      path.join(source, "overview.md"),
      "# Overview\n\nThis system handles payments and refunds.\n",
    );

    const plan = await adapter.plan(source, log);
    assert.deepEqual(plan.newDocuments, []);
    assert.deepEqual(plan.changed, ["overview.md"]);
    assert.deepEqual(plan.unchanged, []);
    assert.deepEqual(plan.conflicts, []);

    const reimported = await adapter.import(source, log);
    const updated = reimported.find((doc) => doc.sourceId === "overview.md");
    assert.match(updated?.content ?? "", /refunds/);
    assert.notEqual(updated?.importedAt, documents[0]?.importedAt);
  } finally {
    await rm(source, { recursive: true });
  }
});

test("a tampered log fingerprint is reported as a conflict and left untouched by import", async () => {
  const source = await sourceFixture({
    "overview.md": "# Overview\n\nThis system handles payments.\n",
  });
  try {
    const adapter = getAdapter("markdown");
    const documents = await adapter.import(source, undefined);
    const original = documents[0];
    assert.ok(original);

    // Simulate a hand-edited log: the fingerprint no longer matches the
    // stored content's own recomputed sha256, even though the source file on
    // disk has not changed.
    const tampered: ImportLog = {
      schemaVersion: 1,
      project: "example",
      documents: [{ ...original, fingerprint: "0".repeat(64) }],
    };

    const plan = await adapter.plan(source, tampered);
    assert.deepEqual(plan.newDocuments, []);
    assert.deepEqual(plan.changed, []);
    assert.deepEqual(plan.unchanged, []);
    assert.equal(plan.conflicts.length, 1);
    assert.equal(plan.conflicts[0]?.path, "overview.md");
    assert.match(plan.conflicts[0]?.reason ?? "", /hand-edited|tampered/);

    const result = await adapter.import(source, tampered);
    assert.equal(result.length, 1);
    assert.deepEqual(result[0], tampered.documents[0]);
  } finally {
    await rm(source, { recursive: true });
  }
});

test("export dry-run preview reports the file list without writing anything", async () => {
  const destination = path.join(await mkdtemp(path.join(tmpdir(), "loreline-export-")), "nested", "dest");
  try {
    const context = sampleContext();
    const planned = plannedExportPaths(context, destination);
    assert.deepEqual(
      planned.slice().sort(),
      [path.join(destination, "architecture.md"), path.join(destination, "risk.md")].sort(),
    );

    await assert.rejects(readdir(destination), (error: unknown) => {
      assert.equal((error as NodeJS.ErrnoException).code, "ENOENT");
      return true;
    });
  } finally {
    await rm(path.dirname(path.dirname(destination)), { recursive: true });
  }
});

test("export --yes writes one category file per category with provenance", async () => {
  const destination = path.join(await mkdtemp(path.join(tmpdir(), "loreline-export-")), "dest");
  try {
    const adapter = getAdapter("markdown");
    const context = sampleContext();
    const files = await adapter.export(context, destination, { force: false });

    assert.equal(files.length, 2);
    const risk = await readFile(path.join(destination, "risk.md"), "utf8");
    assert.match(risk, /Who owns this service\?/);
    assert.match(risk, /The platform team owns it\./);
    assert.match(risk, /_Source: Alex, 2026-08-01T00:00:00\.000Z, `interviews\/alex\.json`_/);
    assert.match(risk, /_Review: approved by Jamie on 2026-08-05T00:00:00\.000Z_/);
  } finally {
    await rm(destination, { recursive: true });
  }
});

test("export without --force refuses to overwrite an existing destination file", async () => {
  const destination = path.join(await mkdtemp(path.join(tmpdir(), "loreline-export-")), "dest");
  try {
    const adapter = getAdapter("markdown");
    const context = sampleContext();
    await adapter.export(context, destination, { force: false });

    await assert.rejects(
      adapter.export(context, destination, { force: false }),
      /architecture\.md.*--force|--force.*architecture\.md/s,
    );

    const secondAttempt = await adapter.export(context, destination, { force: true });
    assert.equal(secondAttempt.length, 2);
  } finally {
    await rm(destination, { recursive: true });
  }
});

test("export disambiguates two categories that slugify to the same file name", async () => {
  const destination = path.join(await mkdtemp(path.join(tmpdir(), "loreline-export-")), "dest");
  try {
    const context = sampleContext({
      entries: [
        {
          id: "risk-bang",
          category: "Risk!",
          question: "What could go wrong (bang)?",
          answer: "Answer from the Risk! category.",
          source: { file: "interviews/alex.json", interviewee: "Alex", generatedAt: "2026-08-01T00:00:00.000Z" },
        },
        {
          id: "risk-lower",
          category: "risk",
          question: "What could go wrong (lower)?",
          answer: "Answer from the risk category.",
          source: { file: "interviews/alex.json", interviewee: "Alex", generatedAt: "2026-08-01T00:00:00.000Z" },
        },
      ],
    });

    const planned = plannedExportPaths(context, destination);
    assert.equal(planned.length, 2);
    assert.equal(new Set(planned).size, 2, "planned file paths must be distinct");

    const adapter = getAdapter("markdown");
    const files = await adapter.export(context, destination, { force: false });
    assert.equal(files.length, 2);
    assert.equal(new Set(files).size, 2, "written file paths must be distinct");

    // The dry-run preview must match exactly what --yes actually writes.
    assert.deepEqual(planned.slice().sort(), files.slice().sort());

    const contents = await Promise.all(files.map((file) => readFile(file, "utf8")));
    const bangFile = contents.find((text) => text.includes("What could go wrong (bang)?"));
    const lowerFile = contents.find((text) => text.includes("What could go wrong (lower)?"));
    assert.ok(bangFile, "expected a file containing the Risk! category's entry");
    assert.ok(lowerFile, "expected a file containing the risk category's entry");
    assert.notEqual(bangFile, lowerFile);
    assert.doesNotMatch(bangFile ?? "", /What could go wrong \(lower\)\?/);
    assert.doesNotMatch(lowerFile ?? "", /What could go wrong \(bang\)\?/);
  } finally {
    await rm(destination, { recursive: true });
  }
});

test("getAdapter rejects an unknown adapter name and lists the available ones", () => {
  assert.throws(() => getAdapter("notion"), /unknown adapter "notion" \(available: markdown\)/);
});

test("imports.json round-trips through schema validation", async () => {
  const log: ImportLog = {
    schemaVersion: 1,
    project: "example",
    documents: [
      {
        sourceId: "overview.md",
        adapter: "markdown",
        path: "overview.md",
        title: "Overview",
        content: "# Overview\n\nThis system handles payments.\n",
        author: "Alex",
        updatedAt: "2026-08-01T00:00:00.000Z",
        link: "https://example.com/overview",
        fingerprint: "a".repeat(64),
        importedAt: "2026-08-01T00:00:00.000Z",
      },
    ],
  };

  const validated = await validateArtifact<ImportLog>("imports", log, "imports.json");
  assert.deepEqual(validated, log);

  const roundTripped: unknown = JSON.parse(JSON.stringify(log));
  const revalidated = await validateArtifact<ImportLog>("imports", roundTripped, "imports.json");
  assert.deepEqual(revalidated, log);
});

test("saveImportLog and loadImportLog round trip through .loreline/imports.json", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "loreline-imports-"));
  try {
    const outputDirectory = path.join(root, ".loreline");
    const log: ImportLog = {
      schemaVersion: 1,
      project: "example",
      documents: [
        {
          sourceId: "overview.md",
          adapter: "markdown",
          path: "overview.md",
          title: "Overview",
          content: "# Overview\n",
          fingerprint: "a".repeat(64),
          importedAt: "2026-08-01T00:00:00.000Z",
        },
      ],
    };

    const importsPath = await saveImportLog(outputDirectory, log);
    const loaded = await loadImportLog(outputDirectory);
    assert.equal(importsPath, path.join(outputDirectory, "imports.json"));
    assert.deepEqual(loaded, log);
  } finally {
    await rm(root, { recursive: true });
  }
});

test("loadImportLog returns undefined when imports.json does not exist", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "loreline-imports-"));
  try {
    const loaded = await loadImportLog(path.join(root, ".loreline"));
    assert.equal(loaded, undefined);
  } finally {
    await rm(root, { recursive: true });
  }
});

function record(overrides: Partial<InterviewRecord> = {}): InterviewRecord {
  return {
    schemaVersion: 1,
    generatedAt: "2026-08-01T00:00:00.000Z",
    project: "example",
    interviewee: "Alex",
    interviewer: "Loreline",
    sourceReport: ".loreline/readiness.json",
    answers: [
      {
        id: "system-shape",
        category: "architecture",
        question: "How does the system work?",
        reason: "Architecture is missing.",
        answer: "Requests enter through the API and are processed by workers.",
      },
    ],
    unanswered: [],
    ...overrides,
  };
}

test("compile embeds imported document metadata (not content) and renders an Imported references section", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "loreline-compile-imports-"));
  try {
    const interviews = path.join(root, ".loreline", "interviews");
    await mkdir(interviews, { recursive: true });
    await writeFile(path.join(interviews, "interview.json"), JSON.stringify(record()));

    const importLog: ImportLog = {
      schemaVersion: 1,
      project: "example",
      documents: [
        {
          sourceId: "runbook.md",
          adapter: "markdown",
          path: "runbook.md",
          title: "Incident Runbook",
          content: "# Incident Runbook\n\nSecret internal steps that must not leak into context.md.\n",
          fingerprint: "a".repeat(64),
          importedAt: "2026-08-10T00:00:00.000Z",
        },
      ],
    };
    await saveImportLog(path.join(root, ".loreline"), importLog);

    const config = defaultConfig(root);
    config.project.name = "example";
    const result = await compileKnowledge(config, path.join(root, ".loreline"));
    const context = JSON.parse(await readFile(result.jsonPath, "utf8")) as KnowledgeContext;

    assert.equal(context.imports?.length, 1);
    assert.equal(context.imports?.[0]?.title, "Incident Runbook");
    assert.equal(context.imports?.[0]?.sourceId, "runbook.md");
    assert.equal((context.imports?.[0] as { content?: string }).content, undefined);

    const markdown = await readFile(result.markdownPath, "utf8");
    assert.match(markdown, /## Imported references/);
    assert.match(markdown, /Incident Runbook/);
    assert.doesNotMatch(markdown, /Secret internal steps/);
  } finally {
    await rm(root, { recursive: true });
  }
});
