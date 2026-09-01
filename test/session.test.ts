import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { defaultConfig } from "../src/config.js";
import { conductInterview, ensureUniqueSessionId } from "../src/interview.js";
import {
  createSession,
  loadSession,
  recordAnswer,
  saveSession,
  toInterviewRecord,
} from "../src/session.js";
import type { InterviewQuestion, ReadinessReport } from "../src/types.js";
import { validateArtifact } from "../src/validation.js";

const QUESTIONS: InterviewQuestion[] = [
  { id: "q1", category: "purpose", question: "What problem does this solve?", reason: "test" },
  { id: "q2", category: "risk", question: "What is fragile?", reason: "test" },
];

function report(): ReadinessReport {
  return {
    schemaVersion: 2,
    generatedAt: "2026-08-01T00:00:00.000Z",
    root: ".",
    score: 50,
    summary: { passed: 0, partial: 0, missing: 0, filesScanned: 1 },
    findings: [],
  };
}

async function tempRoot(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), "loreline-session-"));
}

test("createSession + saveSession + loadSession round trip validates", async () => {
  const dir = await tempRoot();
  try {
    const session = createSession({
      project: "example",
      interviewee: "Alex Chen",
      interviewer: "Loreline",
      sourceReport: ".loreline/readiness.json",
      questions: QUESTIONS,
    });
    assert.match(session.sessionId, /^\d{14}-alex-chen$/);
    assert.equal(session.status, "open");
    assert.deepEqual(session.answers, []);

    const outputDirectory = path.join(dir, ".loreline");
    const savedPath = await saveSession(outputDirectory, session);
    assert.ok(savedPath.endsWith(`${session.sessionId}.json`));

    const loaded = await loadSession(outputDirectory, session.sessionId);
    assert.deepEqual(loaded, session);
  } finally {
    await rm(dir, { recursive: true });
  }
});

test("loadSession reports a missing session and lists available ids", async () => {
  const dir = await tempRoot();
  try {
    const outputDirectory = path.join(dir, ".loreline");
    const session = createSession({
      project: "example",
      interviewee: "Alex",
      interviewer: "Loreline",
      sourceReport: ".loreline/readiness.json",
      questions: QUESTIONS,
    });
    await saveSession(outputDirectory, session);

    await assert.rejects(
      loadSession(outputDirectory, "does-not-exist"),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /Session "does-not-exist" not found/);
        assert.ok(error.message.includes(session.sessionId));
        return true;
      },
    );
  } finally {
    await rm(dir, { recursive: true });
  }
});

test("recordAnswer throws when re-answered without revise, and archives the prior value with revise", () => {
  const session = createSession({
    project: "example",
    interviewee: "Alex",
    interviewer: "Loreline",
    sourceReport: ".loreline/readiness.json",
    questions: QUESTIONS,
  });

  recordAnswer(session, "q1", "First answer", "Alex");
  assert.throws(
    () => recordAnswer(session, "q1", "Second answer", "Alex"),
    /already answered; pass --revise/,
  );

  recordAnswer(session, "q1", "Revised answer", "Alex", { revise: true });
  const entry = session.answers.find((a) => a.id === "q1");
  assert.ok(entry);
  assert.equal(entry.answer, "Revised answer");
  assert.equal(entry.revisions.length, 1);
  assert.equal(entry.revisions[0]?.answer, "First answer");
  assert.notEqual(entry.revisions[0]?.answeredAt, undefined);
  assert.notEqual(entry.revisions[0]?.author, undefined);
});

test("a completed session produces an interview record that passes schema validation", async () => {
  const session = createSession({
    project: "example",
    interviewee: "Alex",
    interviewer: "Loreline",
    sourceReport: ".loreline/readiness.json",
    questions: QUESTIONS,
  });
  recordAnswer(session, "q1", "Answer one", "Alex");
  recordAnswer(session, "q2", "Answer two", "Alex");
  session.status = "completed";

  const record = toInterviewRecord(session);
  assert.equal(record.answers.length, 2);
  assert.deepEqual(record.unanswered, []);

  const validated = await validateArtifact("interview", record, "in-memory-record.json");
  assert.deepEqual(validated, record);
});

test("resuming answers only unanswered questions when supplied answers cover both", async () => {
  const dir = await tempRoot();
  try {
    const outputDirectory = path.join(dir, ".loreline");
    const session = createSession({
      project: "example",
      interviewee: "Alex",
      interviewer: "Loreline",
      sourceReport: ".loreline/readiness.json",
      questions: QUESTIONS,
    });
    recordAnswer(session, "q1", "Answered already", "Alex");
    await saveSession(outputDirectory, session);

    const answersPath = path.join(dir, "answers.json");
    await writeFile(
      answersPath,
      JSON.stringify({ q1: "Should be ignored", q2: "Answered on resume" }),
    );

    const config = defaultConfig(dir);
    config.project.name = "example";

    const record = await conductInterview({
      config,
      report: report(),
      reportPath: ".loreline/readiness.json",
      interviewer: "Loreline",
      answersPath,
      outputDirectory,
      resume: session.sessionId,
    });

    assert.equal(record.answers.find((a) => a.id === "q1")?.answer, "Answered already");
    assert.equal(record.answers.find((a) => a.id === "q2")?.answer, "Answered on resume");
    assert.deepEqual(record.unanswered, []);

    const finalSession = await loadSession(outputDirectory, session.sessionId);
    assert.equal(finalSession.status, "completed");
  } finally {
    await rm(dir, { recursive: true });
  }
});

test("a session interrupted after two answers resumes to a completed record with every answer", async () => {
  const dir = await tempRoot();
  try {
    const outputDirectory = path.join(dir, ".loreline");
    const questions: InterviewQuestion[] = [
      { id: "q1", category: "purpose", question: "Q1?", reason: "test" },
      { id: "q2", category: "risk", question: "Q2?", reason: "test" },
      { id: "q3", category: "ownership", question: "Q3?", reason: "test" },
    ];
    const session = createSession({
      project: "example",
      interviewee: "Alex",
      interviewer: "Loreline",
      sourceReport: ".loreline/readiness.json",
      questions,
    });
    // Simulate an interview interrupted after two answers by saving mid-way.
    recordAnswer(session, "q1", "First", "Alex");
    await saveSession(outputDirectory, session);
    recordAnswer(session, "q2", "Second", "Alex");
    await saveSession(outputDirectory, session);
    // q3 was never reached before the interruption.

    const answersPath = path.join(dir, "answers.json");
    await writeFile(answersPath, JSON.stringify({ q3: "Third" }));

    const config = defaultConfig(dir);
    config.project.name = "example";

    const record = await conductInterview({
      config,
      report: report(),
      reportPath: ".loreline/readiness.json",
      interviewer: "Loreline",
      answersPath,
      outputDirectory,
      resume: session.sessionId,
    });

    assert.deepEqual(
      record.answers.map((a) => a.answer),
      ["First", "Second", "Third"],
    );
    assert.deepEqual(record.unanswered, []);
    await validateArtifact("interview", record, "resumed-record.json");

    const finalSession = await loadSession(outputDirectory, session.sessionId);
    assert.equal(finalSession.status, "completed");
    assert.equal(finalSession.answers.length, 3);
  } finally {
    await rm(dir, { recursive: true });
  }
});

test("ensureUniqueSessionId returns the id unchanged when free, and appends -2/-3 once taken", async () => {
  const dir = await tempRoot();
  try {
    const outputDirectory = path.join(dir, ".loreline");

    assert.equal(
      await ensureUniqueSessionId(outputDirectory, "20260901090000-alex"),
      "20260901090000-alex",
    );

    await mkdir(path.join(outputDirectory, "sessions"), { recursive: true });
    await writeFile(path.join(outputDirectory, "sessions", "20260901090000-alex.json"), "{}");
    assert.equal(
      await ensureUniqueSessionId(outputDirectory, "20260901090000-alex"),
      "20260901090000-alex-2",
    );

    await writeFile(path.join(outputDirectory, "sessions", "20260901090000-alex-2.json"), "{}");
    assert.equal(
      await ensureUniqueSessionId(outputDirectory, "20260901090000-alex"),
      "20260901090000-alex-3",
    );
  } finally {
    await rm(dir, { recursive: true });
  }
});

test("two sessions created for the same interviewee in the same second get distinct ids and neither overwrites the other", async () => {
  const dir = await tempRoot();
  try {
    const outputDirectory = path.join(dir, ".loreline");
    const config = defaultConfig(dir);
    config.project.name = "example";

    const answersPathA = path.join(dir, "answers-a.json");
    await writeFile(answersPathA, JSON.stringify({ "hidden-context": "Session A answer" }));
    const answersPathB = path.join(dir, "answers-b.json");
    await writeFile(answersPathB, JSON.stringify({ "hidden-context": "Session B answer" }));

    // Two independent "new interview" runs for the same interviewee, started
    // back to back (in practice within the same second): each calls
    // createSession internally, which without disambiguation would produce
    // the same sessionId and the second save would clobber the first.
    const recordA = await conductInterview({
      config,
      report: report(),
      reportPath: ".loreline/readiness.json",
      interviewee: "Alex",
      interviewer: "Loreline",
      answersPath: answersPathA,
      outputDirectory,
    });
    const recordB = await conductInterview({
      config,
      report: report(),
      reportPath: ".loreline/readiness.json",
      interviewee: "Alex",
      interviewer: "Loreline",
      answersPath: answersPathB,
      outputDirectory,
    });

    const sessionFiles = (await readdir(path.join(outputDirectory, "sessions"))).sort();
    assert.equal(
      sessionFiles.length,
      2,
      `expected two distinct session files, found: ${sessionFiles.join(", ")}`,
    );

    const sessions = await Promise.all(
      sessionFiles.map(async (file) =>
        JSON.parse(await readFile(path.join(outputDirectory, "sessions", file), "utf8")),
      ),
    );
    assert.notEqual(sessions[0].sessionId, sessions[1].sessionId);

    const answerOf = (session: { answers: Array<{ id: string; answer: string }> }): string | undefined =>
      session.answers.find((entry) => entry.id === "hidden-context")?.answer;
    const persistedAnswers = [answerOf(sessions[0]), answerOf(sessions[1])].sort();
    assert.deepEqual(persistedAnswers, ["Session A answer", "Session B answer"]);

    assert.equal(
      recordA.answers.find((a) => a.id === "hidden-context")?.answer,
      "Session A answer",
    );
    assert.equal(
      recordB.answers.find((a) => a.id === "hidden-context")?.answer,
      "Session B answer",
    );
  } finally {
    await rm(dir, { recursive: true });
  }
});
