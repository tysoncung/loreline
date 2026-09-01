import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { defaultConfig } from "../src/config.js";
import { compileKnowledge, verifyKnowledge } from "../src/knowledge.js";
import {
  applyReview,
  effectiveReview,
  fingerprintAnswer,
  loadReviews,
  recordReview,
  saveReviews,
  type ReviewLog,
} from "../src/review.js";
import type { InterviewRecord, KnowledgeContext } from "../src/types.js";

const ANSWER = "Requests enter through the API and are processed by workers.";

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
        answer: ANSWER,
      },
    ],
    unanswered: [],
    ...overrides,
  };
}

async function fixture(interview: InterviewRecord): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "loreline-review-"));
  const interviews = path.join(root, ".loreline", "interviews");
  await mkdir(interviews, { recursive: true });
  await writeFile(path.join(interviews, "interview.json"), JSON.stringify(interview));
  return root;
}

test("saveReviews and loadReviews round trip through a validated reviews.json", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "loreline-reviews-"));
  try {
    const outputDirectory = path.join(root, ".loreline");
    const log: ReviewLog = { schemaVersion: 1, project: "example", entries: [] };
    recordReview(log, {
      entryId: "system-shape",
      answerFingerprint: fingerprintAnswer(ANSWER),
      status: "approved",
      owner: "Jamie",
      reviewers: ["Jamie"],
      reviewedAt: "2026-08-05T00:00:00.000Z",
    });

    const reviewsPath = await saveReviews(outputDirectory, log);
    const raw = JSON.parse(await readFile(reviewsPath, "utf8")) as ReviewLog;
    assert.equal(raw.entries.length, 1);
    assert.equal(raw.entries[0]?.owner, "Jamie");

    const loaded = await loadReviews(outputDirectory);
    assert.ok(loaded);
    assert.equal(loaded?.entries.length, 1);
    assert.equal(loaded?.entries[0]?.status, "approved");
  } finally {
    await rm(root, { recursive: true });
  }
});

test("loadReviews returns undefined when reviews.json does not exist", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "loreline-reviews-"));
  try {
    const loaded = await loadReviews(path.join(root, ".loreline"));
    assert.equal(loaded, undefined);
  } finally {
    await rm(root, { recursive: true });
  }
});

test("recordReview refuses an empty or AI owner", () => {
  const log: ReviewLog = { schemaVersion: 1, project: "example", entries: [] };
  assert.throws(() =>
    recordReview(log, {
      entryId: "system-shape",
      answerFingerprint: "abc",
      status: "approved",
      owner: "   ",
      reviewers: [],
      reviewedAt: "2026-08-05T00:00:00.000Z",
    }),
  );
  assert.throws(() =>
    recordReview(log, {
      entryId: "system-shape",
      answerFingerprint: "abc",
      status: "approved",
      owner: "ai",
      reviewers: [],
      reviewedAt: "2026-08-05T00:00:00.000Z",
    }),
  );
  assert.equal(log.entries.length, 0);
});

test("effectiveReview picks the latest current review and flags staleness and conflicts", () => {
  const log: ReviewLog = { schemaVersion: 1, project: "example", entries: [] };
  const fpOld = fingerprintAnswer("an outdated answer");
  const fpNew = fingerprintAnswer(ANSWER);

  recordReview(log, {
    entryId: "system-shape",
    answerFingerprint: fpOld,
    status: "approved",
    owner: "Jamie",
    reviewers: [],
    reviewedAt: "2026-08-01T00:00:00.000Z",
  });

  const stale = effectiveReview(log, "system-shape", fpNew);
  assert.equal(stale.stale, true);
  assert.equal(stale.conflicting, false);
  assert.equal(stale.entry, undefined);

  recordReview(log, {
    entryId: "system-shape",
    answerFingerprint: fpNew,
    status: "approved",
    owner: "Jamie",
    reviewers: [],
    reviewedAt: "2026-08-10T00:00:00.000Z",
  });
  recordReview(log, {
    entryId: "system-shape",
    answerFingerprint: fpNew,
    status: "disputed",
    owner: "Riley",
    reviewers: [],
    reason: "No longer accurate.",
    reviewedAt: "2026-08-12T00:00:00.000Z",
  });

  const conflicting = effectiveReview(log, "system-shape", fpNew);
  assert.equal(conflicting.stale, false);
  assert.equal(conflicting.conflicting, true);
  assert.equal(conflicting.entry?.owner, "Riley");
  assert.equal(conflicting.entry?.status, "disputed");

  const unrelated = effectiveReview(log, "other-entry", fpNew);
  assert.equal(unrelated.stale, false);
  assert.equal(unrelated.conflicting, false);
  assert.equal(unrelated.entry, undefined);
});

test("compile merges a matching current review into the compiled entry", async () => {
  const root = await fixture(record());
  try {
    const outputDirectory = path.join(root, ".loreline");
    const config = defaultConfig(root);
    config.project.name = "example";
    const log: ReviewLog = { schemaVersion: 1, project: "example", entries: [] };
    recordReview(log, {
      entryId: "system-shape",
      answerFingerprint: fingerprintAnswer(ANSWER),
      status: "approved",
      owner: "Jamie",
      reviewers: ["Jamie"],
      reviewedAt: "2026-08-05T00:00:00.000Z",
    });
    await saveReviews(outputDirectory, log);

    const result = await compileKnowledge(config, outputDirectory);
    const context = JSON.parse(await readFile(result.jsonPath, "utf8")) as KnowledgeContext;
    const entry = context.entries.find((item) => item.id === "system-shape");

    assert.equal(context.schemaVersion, 2);
    assert.equal(entry?.review?.status, "approved");
    assert.equal(entry?.review?.owner, "Jamie");
    assert.equal(entry?.review?.stale, false);
    assert.equal(entry?.review?.conflicting, false);

    const markdown = await readFile(result.markdownPath, "utf8");
    assert.match(markdown, /_Review: approved by Jamie on 2026-08-05T00:00:00\.000Z_/);
  } finally {
    await rm(root, { recursive: true });
  }
});

test("compile flags a review as stale once the answer changes and reports conflicts", async () => {
  const root = await fixture(record());
  try {
    const outputDirectory = path.join(root, ".loreline");
    const config = defaultConfig(root);
    config.project.name = "example";
    const log: ReviewLog = { schemaVersion: 1, project: "example", entries: [] };
    recordReview(log, {
      entryId: "system-shape",
      answerFingerprint: fingerprintAnswer("an outdated answer"),
      status: "approved",
      owner: "Jamie",
      reviewers: [],
      reviewedAt: "2026-08-01T00:00:00.000Z",
    });
    await saveReviews(outputDirectory, log);

    const result = await compileKnowledge(config, outputDirectory);
    const context = JSON.parse(await readFile(result.jsonPath, "utf8")) as KnowledgeContext;
    const entry = context.entries.find((item) => item.id === "system-shape");
    assert.equal(entry?.review?.stale, true);

    const markdown = await readFile(result.markdownPath, "utf8");
    assert.match(markdown, /_Review: stale \(answer changed since review\)_/);
  } finally {
    await rm(root, { recursive: true });
  }
});

test("compile renders both facts when a current review is conflicting", async () => {
  const root = await fixture(record());
  try {
    const outputDirectory = path.join(root, ".loreline");
    const config = defaultConfig(root);
    config.project.name = "example";
    const log: ReviewLog = { schemaVersion: 1, project: "example", entries: [] };
    recordReview(log, {
      entryId: "system-shape",
      answerFingerprint: fingerprintAnswer(ANSWER),
      status: "approved",
      owner: "Jamie",
      reviewers: [],
      reviewedAt: "2026-08-05T00:00:00.000Z",
    });
    recordReview(log, {
      entryId: "system-shape",
      answerFingerprint: fingerprintAnswer(ANSWER),
      status: "disputed",
      owner: "Riley",
      reviewers: [],
      reason: "This needs a second look.",
      reviewedAt: "2026-08-06T00:00:00.000Z",
    });
    await saveReviews(outputDirectory, log);

    const result = await compileKnowledge(config, outputDirectory);
    const context = JSON.parse(await readFile(result.jsonPath, "utf8")) as KnowledgeContext;
    const entry = context.entries.find((item) => item.id === "system-shape");
    assert.equal(entry?.review?.conflicting, true);
    assert.equal(entry?.review?.status, "disputed");

    const markdown = await readFile(result.markdownPath, "utf8");
    assert.match(markdown, /_Review: CONFLICTING - approved and disputed for the same answer_/);
    assert.match(markdown, /_Review: DISPUTED by Riley: This needs a second look\._/);
  } finally {
    await rm(root, { recursive: true });
  }
});

test("verify --require-approval errors when context.json has not been compiled", async () => {
  const root = await fixture(record());
  try {
    const outputDirectory = path.join(root, ".loreline");
    const config = defaultConfig(root);
    config.project.name = "example";
    const report = await verifyKnowledge(
      config,
      outputDirectory,
      180,
      root,
      new Date("2026-09-01T00:00:00.000Z"),
      { requireApproval: true },
    );

    assert.equal(report.valid, false);
    assert.ok(
      report.issues.some(
        (issue) => issue.severity === "error" && /loreline compile/.test(issue.message),
      ),
    );
  } finally {
    await rm(root, { recursive: true });
  }
});

test("verify --require-approval errors on an unapproved entry and warns on an overdue one", async () => {
  const root = await fixture(record());
  try {
    const outputDirectory = path.join(root, ".loreline");
    const config = defaultConfig(root);
    config.project.name = "example";
    await compileKnowledge(config, outputDirectory);

    const unapproved = await verifyKnowledge(
      config,
      outputDirectory,
      180,
      root,
      new Date("2026-09-01T00:00:00.000Z"),
      { requireApproval: true },
    );
    assert.equal(unapproved.valid, false);
    assert.ok(
      unapproved.issues.some(
        (issue) => issue.severity === "error" && /no current approved review/.test(issue.message),
      ),
    );

    const log: ReviewLog = { schemaVersion: 1, project: "example", entries: [] };
    recordReview(log, {
      entryId: "system-shape",
      answerFingerprint: fingerprintAnswer(ANSWER),
      status: "approved",
      owner: "Jamie",
      reviewers: [],
      reviewedAt: "2026-08-01T00:00:00.000Z",
      dueDate: "2026-08-15",
    });
    await saveReviews(outputDirectory, log);
    await compileKnowledge(config, outputDirectory);

    const overdue = await verifyKnowledge(
      config,
      outputDirectory,
      180,
      root,
      new Date("2026-09-01T00:00:00.000Z"),
      { requireApproval: true },
    );
    assert.equal(overdue.valid, false);
    assert.ok(
      overdue.issues.some((issue) => issue.severity === "warning" && /overdue/.test(issue.message)),
    );

    const beforeDue = await verifyKnowledge(
      config,
      outputDirectory,
      180,
      root,
      new Date("2026-08-10T00:00:00.000Z"),
      { requireApproval: true },
    );
    assert.equal(beforeDue.valid, true);
    assert.deepEqual(beforeDue.issues, []);
  } finally {
    await rm(root, { recursive: true });
  }
});

test("verify --require-approval warns on a stale approval instead of erroring", async () => {
  const root = await fixture(record());
  try {
    const outputDirectory = path.join(root, ".loreline");
    const config = defaultConfig(root);
    config.project.name = "example";
    const log: ReviewLog = { schemaVersion: 1, project: "example", entries: [] };
    recordReview(log, {
      entryId: "system-shape",
      answerFingerprint: fingerprintAnswer("an outdated answer"),
      status: "approved",
      owner: "Jamie",
      reviewers: [],
      reviewedAt: "2026-08-01T00:00:00.000Z",
    });
    await saveReviews(outputDirectory, log);
    await compileKnowledge(config, outputDirectory);

    const report = await verifyKnowledge(
      config,
      outputDirectory,
      180,
      root,
      new Date("2026-09-01T00:00:00.000Z"),
      { requireApproval: true },
    );
    assert.equal(report.valid, false);
    assert.ok(report.issues.some((issue) => issue.severity === "warning" && /stale/.test(issue.message)));
    assert.ok(!report.issues.some((issue) => issue.severity === "error"));
  } finally {
    await rm(root, { recursive: true });
  }
});

test("verify without --require-approval ignores review state entirely", async () => {
  const root = await fixture(record());
  try {
    const outputDirectory = path.join(root, ".loreline");
    const config = defaultConfig(root);
    config.project.name = "example";
    await compileKnowledge(config, outputDirectory);

    const report = await verifyKnowledge(
      config,
      outputDirectory,
      180,
      root,
      new Date("2026-09-01T00:00:00.000Z"),
    );
    assert.equal(report.valid, true);
    assert.deepEqual(report.issues, []);
  } finally {
    await rm(root, { recursive: true });
  }
});

test("applyReview rejects an unknown entry id", async () => {
  const root = await fixture(record());
  try {
    const outputDirectory = path.join(root, ".loreline");
    const config = defaultConfig(root);
    config.project.name = "example";
    await compileKnowledge(config, outputDirectory);

    await assert.rejects(
      applyReview(outputDirectory, {
        entryId: "does-not-exist",
        status: "approved",
        owner: "Jamie",
        reviewers: [],
      }),
      /Unknown entry id/,
    );
  } finally {
    await rm(root, { recursive: true });
  }
});

test("applyReview errors before context.json has been compiled", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "loreline-review-"));
  try {
    await assert.rejects(
      applyReview(path.join(root, ".loreline"), {
        entryId: "system-shape",
        status: "approved",
        owner: "Jamie",
        reviewers: [],
      }),
      /loreline compile/,
    );
  } finally {
    await rm(root, { recursive: true });
  }
});

test("applyReview records a review that compile then merges back in", async () => {
  const root = await fixture(record());
  try {
    const outputDirectory = path.join(root, ".loreline");
    const config = defaultConfig(root);
    config.project.name = "example";
    await compileKnowledge(config, outputDirectory);

    const result = await applyReview(outputDirectory, {
      entryId: "system-shape",
      status: "approved",
      owner: "Jamie",
      reviewers: ["Jamie"],
      reviewedAt: "2026-08-05T00:00:00.000Z",
    });
    assert.equal(result.entriesReviewed, 1);

    const recompiled = await compileKnowledge(config, outputDirectory);
    const context = JSON.parse(await readFile(recompiled.jsonPath, "utf8")) as KnowledgeContext;
    const entry = context.entries.find((item) => item.id === "system-shape");
    assert.equal(entry?.review?.status, "approved");
    assert.equal(entry?.review?.owner, "Jamie");
  } finally {
    await rm(root, { recursive: true });
  }
});
