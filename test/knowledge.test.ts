import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { defaultConfig } from "../src/config.js";
import { compileKnowledge, verifyKnowledge } from "../src/knowledge.js";
import type { InterviewRecord } from "../src/types.js";

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

async function fixture(interview: InterviewRecord): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "loreline-knowledge-"));
  const interviews = path.join(root, ".loreline", "interviews");
  await mkdir(interviews, { recursive: true });
  await writeFile(path.join(interviews, "interview.json"), JSON.stringify(interview));
  return root;
}

test("compiles answers with provenance into AI context", async () => {
  const root = await fixture(record());
  try {
    const config = defaultConfig(root);
    config.project.name = "example";
    const result = await compileKnowledge(config, path.join(root, ".loreline"));
    const context = await readFile(result.markdownPath, "utf8");

    assert.equal(result.records, 1);
    assert.equal(result.answers, 1);
    assert.match(context, /## Architecture/);
    assert.match(context, /Requests enter through the API/);
    assert.match(context, /Source: Alex/);
  } finally {
    await rm(root, { recursive: true });
  }
});

test("verifies complete and current knowledge records", async () => {
  const root = await fixture(record());
  try {
    const config = defaultConfig(root);
    config.project.name = "example";
    const report = await verifyKnowledge(
      config,
      path.join(root, ".loreline"),
      180,
      new Date("2026-09-01T00:00:00.000Z"),
    );

    assert.equal(report.valid, true);
    assert.equal(report.recordsChecked, 1);
    assert.deepEqual(report.issues, []);
  } finally {
    await rm(root, { recursive: true });
  }
});

test("reports stale, incomplete, and mismatched knowledge", async () => {
  const root = await fixture(
    record({
      generatedAt: "2025-01-01T00:00:00.000Z",
      project: "other",
      unanswered: ["system-shape"],
    }),
  );
  try {
    const config = defaultConfig(root);
    config.project.name = "example";
    const report = await verifyKnowledge(
      config,
      path.join(root, ".loreline"),
      180,
      new Date("2026-09-01T00:00:00.000Z"),
    );

    assert.equal(report.valid, false);
    assert.equal(report.issues.length, 3);
    assert.ok(report.issues.some((issue) => issue.message.includes("expected \"example\"")));
    assert.ok(report.issues.some((issue) => issue.message.includes("older than 180 days")));
    assert.ok(report.issues.some((issue) => issue.message.includes("remain unanswered")));
  } finally {
    await rm(root, { recursive: true });
  }
});

test("reports malformed records by file while verifying valid records", async () => {
  const root = await fixture(record());
  try {
    await writeFile(path.join(root, ".loreline", "interviews", "broken.json"), "{");
    const config = defaultConfig(root);
    config.project.name = "example";
    const report = await verifyKnowledge(
      config,
      path.join(root, ".loreline"),
      180,
      new Date("2026-09-01T00:00:00.000Z"),
    );

    assert.equal(report.valid, false);
    assert.equal(report.recordsChecked, 1);
    assert.equal(report.issues[0]?.file, "interviews/broken.json");
  } finally {
    await rm(root, { recursive: true });
  }
});

test("treats whitespace-only answers as unanswered", async () => {
  const whitespaceRecord = record();
  whitespaceRecord.answers[0]!.answer = "   ";
  const root = await fixture(whitespaceRecord);
  try {
    const config = defaultConfig(root);
    config.project.name = "example";
    const report = await verifyKnowledge(
      config,
      path.join(root, ".loreline"),
      180,
      new Date("2026-09-01T00:00:00.000Z"),
    );

    assert.equal(report.valid, false);
    assert.match(report.issues[0]?.message ?? "", /remain unanswered/);
  } finally {
    await rm(root, { recursive: true });
  }
});
