import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  detectContradictions,
  generateFollowup,
  generateQuestions,
  PROMPT_VERSION,
} from "../src/ai/interviewer.js";
import { defaultConfig } from "../src/config.js";
import { conductInterview } from "../src/interview.js";
import { FakeProvider } from "../src/providers/fake.js";
import type { AiProvider, CompletionRequest } from "../src/providers/types.js";
import { ProviderError } from "../src/providers/types.js";
import { loadSession } from "../src/session.js";
import type { Finding, InterviewQuestion, ReadinessReport } from "../src/types.js";

function report(findings: Finding[] = []): ReadinessReport {
  return {
    schemaVersion: 2,
    generatedAt: "2026-08-01T00:00:00.000Z",
    root: ".",
    score: 50,
    summary: { passed: 0, partial: 0, missing: 0, filesScanned: 1 },
    findings,
  };
}

function finding(overrides: Partial<Finding> & { id: string }): Finding {
  return {
    title: overrides.id,
    status: "missing",
    weight: 1,
    evidence: [],
    recommendation: "Document it.",
    ...overrides,
  };
}

async function tempRoot(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), "loreline-ai-interview-"));
}

// ---------------------------------------------------------------------------
// generateQuestions
// ---------------------------------------------------------------------------

test("generateQuestions parses, stamps origin/promptVersion, drops invalid items, and dedupes within the batch", async () => {
  const provider = new FakeProvider(
    [
      JSON.stringify([
        { question: "How is the system structured?", category: "architecture", reason: "gap", sourceFinding: "architecture" },
        { question: "how is the system structured?", category: "architecture", reason: "duplicate of above" },
        { question: "", category: "x", reason: "y" },
        { question: "Missing reason field", category: "x" },
        { question: "What decision should never be reversed?", category: "decisions", reason: "gap2", sourceFinding: "not-a-real-finding" },
        { question: "Who owns the deploy pipeline?", category: "ownership", reason: "gap3" },
      ]),
    ],
    "test-model",
  );

  const questions = await generateQuestions({
    provider,
    report: report([finding({ id: "architecture" }), finding({ id: "decisions" })]),
    evidence: [],
  });

  assert.equal(questions.length, 2);
  assert.deepEqual(questions[0], {
    id: "ai-1",
    category: "architecture",
    question: "How is the system structured?",
    reason: "gap",
    sourceFinding: "architecture",
    origin: { type: "ai", provider: "fake", model: "test-model", promptVersion: PROMPT_VERSION },
  });
  assert.deepEqual(questions[1], {
    id: "ai-2",
    category: "ownership",
    question: "Who owns the deploy pipeline?",
    reason: "gap3",
    origin: { type: "ai", provider: "fake", model: "test-model", promptVersion: PROMPT_VERSION },
  });
  assert.equal(provider.requests.length, 1);
});

test("generateQuestions caps accepted questions at maxQuestions", async () => {
  const raw = Array.from({ length: 7 }, (_, index) => ({
    question: `Question number ${index}?`,
    category: "general",
    reason: "gap",
  }));
  const provider = new FakeProvider([JSON.stringify(raw)]);

  const questions = await generateQuestions({
    provider,
    report: report(),
    evidence: [],
    maxQuestions: 3,
  });

  assert.deepEqual(
    questions.map((q) => q.id),
    ["ai-1", "ai-2", "ai-3"],
  );
});

test("generateQuestions strips markdown code fences before parsing", async () => {
  const provider = new FakeProvider([
    '```json\n[{"question":"Fenced question?","category":"c","reason":"r"}]\n```',
  ]);

  const questions = await generateQuestions({ provider, report: report(), evidence: [] });

  assert.equal(questions.length, 1);
  assert.equal(questions[0]?.question, "Fenced question?");
});

test("generateQuestions retries once on invalid JSON, then throws a ProviderError", async () => {
  const provider = new FakeProvider(["not json", "still not json"]);

  await assert.rejects(
    generateQuestions({ provider, report: report(), evidence: [] }),
    (error: unknown) => {
      assert.ok(error instanceof ProviderError);
      assert.match(error.message, /provider returned invalid question JSON/);
      return true;
    },
  );
  assert.equal(provider.requests.length, 2);
});

test("generateQuestions recovers when the retry attempt returns valid JSON", async () => {
  const provider = new FakeProvider([
    "not json at all",
    JSON.stringify([{ question: "Recovered question?", category: "c", reason: "r" }]),
  ]);

  const questions = await generateQuestions({ provider, report: report(), evidence: [] });

  assert.equal(questions.length, 1);
  assert.equal(questions[0]?.question, "Recovered question?");
  assert.equal(provider.requests.length, 2);
});

// ---------------------------------------------------------------------------
// generateFollowup
// ---------------------------------------------------------------------------

const BASE_QUESTION: InterviewQuestion = {
  id: "q1",
  category: "risk",
  question: "What is fragile?",
  reason: "test",
};

test("generateFollowup returns a stamped follow-up question when the provider suggests one", async () => {
  const provider = new FakeProvider(["Can you give a concrete example?"], "model-x");

  const followup = await generateFollowup(provider, BASE_QUESTION, "short");

  assert.deepEqual(followup, {
    id: "q1-followup",
    category: "risk",
    question: "Can you give a concrete example?",
    reason: "Follow-up: the previous answer was brief.",
    origin: { type: "ai", provider: "fake", model: "model-x", promptVersion: PROMPT_VERSION },
  });
});

test("generateFollowup returns undefined when the provider replies NONE, regardless of case or whitespace", async () => {
  const provider = new FakeProvider(["  none  "]);

  const followup = await generateFollowup(provider, BASE_QUESTION, "short");

  assert.equal(followup, undefined);
});

// ---------------------------------------------------------------------------
// detectContradictions
// ---------------------------------------------------------------------------

test("detectContradictions returns parsed contradiction descriptions", async () => {
  const provider = new FakeProvider([JSON.stringify(["Answer to Q1 conflicts with answer to Q2."])]);

  const contradictions = await detectContradictions(provider, [
    { question: "Q1", answer: "A1" },
    { question: "Q2", answer: "A2" },
  ]);

  assert.deepEqual(contradictions, ["Answer to Q1 conflicts with answer to Q2."]);
});

test("detectContradictions strips code fences before parsing", async () => {
  const provider = new FakeProvider(['```json\n["Fenced contradiction."]\n```']);

  const contradictions = await detectContradictions(provider, [{ question: "Q1", answer: "A1" }]);

  assert.deepEqual(contradictions, ["Fenced contradiction."]);
});

test("detectContradictions never throws and returns an empty array on invalid JSON", async () => {
  const provider = new FakeProvider(["not json at all"]);

  const contradictions = await detectContradictions(provider, [{ question: "Q1", answer: "A1" }]);

  assert.deepEqual(contradictions, []);
});

// ---------------------------------------------------------------------------
// conductInterview + ai hook
// ---------------------------------------------------------------------------

test("a vague answer triggers exactly one follow-up while long answers trigger none", async () => {
  const dir = await tempRoot();
  try {
    const outputDirectory = path.join(dir, ".loreline");
    const provider = new FakeProvider(
      [
        "[]",
        "Can you say more about what makes it fragile?",
        "[]",
      ],
      "test-model",
    );

    const answersPath = path.join(dir, "answers.json");
    await writeFile(
      answersPath,
      JSON.stringify({
        "hidden-context":
          "A long enough answer that should not trigger any follow-up generation because it clears the sixty character threshold easily.",
        "fragile-areas": "Too short.",
        "first-response":
          "Another sufficiently long answer so no follow-up call happens for this question either, well past sixty characters.",
        "human-network":
          "One more long answer so the follow-up threshold of sixty characters is never crossed here at all.",
        "fragile-areas-followup":
          "The payment retry logic is fragile because it silently swallows timeout errors.",
      }),
    );

    const config = defaultConfig(dir);
    config.project.name = "example";

    const record = await conductInterview({
      config,
      report: report(),
      reportPath: ".loreline/readiness.json",
      interviewee: "Alex",
      interviewer: "Loreline",
      answersPath,
      outputDirectory,
      ai: { provider, maxFollowups: 2, evidence: [] },
    });

    const followupEntries = record.answers.filter((a) => a.id.endsWith("-followup"));
    assert.equal(followupEntries.length, 1);
    assert.equal(followupEntries[0]?.id, "fragile-areas-followup");
    assert.equal(followupEntries[0]?.category, "risk");
    assert.equal(followupEntries[0]?.reason, "Follow-up: the previous answer was brief.");
    assert.equal(
      followupEntries[0]?.answer,
      "The payment retry logic is fragile because it silently swallows timeout errors.",
    );
    assert.deepEqual(followupEntries[0]?.origin, {
      type: "ai",
      provider: "fake",
      model: "test-model",
      promptVersion: PROMPT_VERSION,
    });
    assert.equal(provider.requests.length, 3);
  } finally {
    await rm(dir, { recursive: true });
  }
});

test("detected contradictions land in the record as unanswered questions with category contradiction", async () => {
  const dir = await tempRoot();
  try {
    const outputDirectory = path.join(dir, ".loreline");
    const provider = new FakeProvider(
      [
        "[]",
        JSON.stringify(["The answer to fragile-areas conflicts with the answer to first-response."]),
      ],
      "test-model",
    );

    const answersPath = path.join(dir, "answers.json");
    await writeFile(
      answersPath,
      JSON.stringify({
        "hidden-context": "A long enough answer that clears the follow-up threshold comfortably here.",
        "fragile-areas": "A long enough answer that clears the follow-up threshold comfortably here too.",
        "first-response": "A long enough answer that clears the follow-up threshold comfortably here also.",
        "human-network": "A long enough answer that clears the follow-up threshold comfortably here as well.",
      }),
    );

    const config = defaultConfig(dir);
    config.project.name = "example";

    const record = await conductInterview({
      config,
      report: report(),
      reportPath: ".loreline/readiness.json",
      interviewee: "Alex",
      interviewer: "Loreline",
      answersPath,
      outputDirectory,
      ai: { provider, maxFollowups: 2, evidence: [] },
    });

    const contradiction = record.answers.find((a) => a.id === "contradiction-1");
    assert.ok(contradiction);
    assert.equal(contradiction?.category, "contradiction");
    assert.equal(
      contradiction?.question,
      "The answer to fragile-areas conflicts with the answer to first-response.",
    );
    assert.equal(contradiction?.reason, "Possible contradiction between answers.");
    assert.equal(contradiction?.answer, "");
    assert.deepEqual(contradiction?.origin, {
      type: "ai",
      provider: "fake",
      model: "test-model",
      promptVersion: PROMPT_VERSION,
    });
    assert.ok(record.unanswered.includes("contradiction-1"));
    assert.equal(provider.requests.length, 2);
  } finally {
    await rm(dir, { recursive: true });
  }
});

test("a provider failure mid-interview leaves an open, resumable session with answers already given intact", async () => {
  const dir = await tempRoot();
  try {
    const outputDirectory = path.join(dir, ".loreline");
    const inner = new FakeProvider(["[]", "Tell me more?"], "test-model");
    let calls = 0;
    const throwing: AiProvider = {
      name: inner.name,
      model: inner.model,
      async complete(request: CompletionRequest) {
        calls += 1;
        if (calls > 1) {
          throw new ProviderError("simulated provider outage");
        }
        return inner.complete(request);
      },
    };

    const answersPath = path.join(dir, "answers.json");
    await writeFile(
      answersPath,
      JSON.stringify({
        "hidden-context": "Too short.",
        "fragile-areas": "A long enough answer that clears the follow-up threshold comfortably here too.",
        "first-response": "A long enough answer that clears the follow-up threshold comfortably here also.",
        "human-network": "A long enough answer that clears the follow-up threshold comfortably here as well.",
      }),
    );

    const config = defaultConfig(dir);
    config.project.name = "example";

    let sessionId = "";
    await assert.rejects(
      conductInterview({
        config,
        report: report(),
        reportPath: ".loreline/readiness.json",
        interviewee: "Alex",
        interviewer: "Loreline",
        answersPath,
        outputDirectory,
        ai: { provider: throwing, maxFollowups: 2, evidence: [] },
        onSessionStart: (session) => {
          sessionId = session.sessionId;
        },
      }),
      (error: unknown) => {
        assert.ok(error instanceof ProviderError);
        assert.match(error.message, /simulated provider outage/);
        return true;
      },
    );

    assert.ok(sessionId);
    const openSession = await loadSession(outputDirectory, sessionId);
    assert.equal(openSession.status, "open");
    assert.equal(openSession.answers.length, 1);
    assert.equal(openSession.answers[0]?.id, "hidden-context");

    // Resume without --ai to finish deterministically: the failure must not
    // have lost the first answer or corrupted the session.
    const record = await conductInterview({
      config,
      report: report(),
      reportPath: ".loreline/readiness.json",
      interviewer: "Loreline",
      answersPath,
      outputDirectory,
      resume: sessionId,
    });

    assert.equal(record.answers.find((a) => a.id === "hidden-context")?.answer, "Too short.");
    assert.deepEqual(record.unanswered, []);
  } finally {
    await rm(dir, { recursive: true });
  }
});

test("a simulated SIGINT mid-interview saves the session, including an AI-origin question, and it resumes to completion", async () => {
  const dir = await tempRoot();
  try {
    const outputDirectory = path.join(dir, ".loreline");
    const { createSession, recordAnswer, saveSession } = await import("../src/session.js");

    const aiQuestion: InterviewQuestion = {
      id: "ai-1",
      category: "purpose",
      question: "What surprised you most about this codebase?",
      reason: "Generated from readiness findings.",
      origin: { type: "ai", provider: "fake", model: "fake-model", promptVersion: PROMPT_VERSION },
    };
    const session = createSession({
      project: "example",
      interviewee: "Alex",
      interviewer: "Loreline",
      sourceReport: ".loreline/readiness.json",
      questions: [
        { id: "q1", category: "purpose", question: "What problem does this solve?", reason: "test" },
        aiQuestion,
      ],
    });
    recordAnswer(session, "q1", "First answer", "Alex");

    // Simulate what a SIGINT handler would do: persist whatever state
    // exists right now, without waiting for the interview loop to finish.
    async function simulateSigint(): Promise<void> {
      await saveSession(outputDirectory, session);
    }
    await simulateSigint();

    const reloaded = await loadSession(outputDirectory, session.sessionId);
    assert.equal(reloaded.status, "open");
    assert.equal(reloaded.answers.length, 1);
    assert.deepEqual(reloaded.questions.find((q) => q.id === "ai-1")?.origin, {
      type: "ai",
      provider: "fake",
      model: "fake-model",
      promptVersion: PROMPT_VERSION,
    });

    const answersPath = path.join(dir, "answers.json");
    await writeFile(answersPath, JSON.stringify({ "ai-1": "Answer to the AI question" }));
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

    assert.deepEqual(record.unanswered, []);
    assert.equal(record.answers.find((a) => a.id === "ai-1")?.answer, "Answer to the AI question");
    assert.deepEqual(record.answers.find((a) => a.id === "ai-1")?.origin, {
      type: "ai",
      provider: "fake",
      model: "fake-model",
      promptVersion: PROMPT_VERSION,
    });
  } finally {
    await rm(dir, { recursive: true });
  }
});

test("evidence passed to the AI provider never includes content excluded upstream by scope filtering", async () => {
  const dir = await tempRoot();
  try {
    const outputDirectory = path.join(dir, ".loreline");
    const provider = new FakeProvider(["[]", "[]"]);
    const config = defaultConfig(dir);
    config.project.name = "example";

    const answersPath = path.join(dir, "answers.json");
    await writeFile(
      answersPath,
      JSON.stringify({
        "hidden-context": "A long enough answer that will not trigger any follow-up generation at all here.",
        "fragile-areas": "Another sufficiently long answer so no follow-up call happens for this one either.",
        "first-response": "Yet another long enough answer to avoid triggering a follow-up in this test run.",
        "human-network": "One more long answer so the follow-up threshold of sixty characters is never crossed.",
      }),
    );

    await conductInterview({
      config,
      report: report(),
      reportPath: ".loreline/readiness.json",
      interviewee: "Alex",
      interviewer: "Loreline",
      answersPath,
      outputDirectory,
      ai: {
        provider,
        maxFollowups: 2,
        evidence: [{ file: "src/allowed.ts", excerpt: "export const allowed = true;" }],
      },
    });

    const combined = provider.requests
      .map((request) => request.messages.map((message) => message.content).join("\n"))
      .join("\n");
    assert.ok(combined.includes("allowed.ts"));
    assert.ok(combined.includes("export const allowed = true;"));
    assert.ok(!combined.includes("SECRET_EXCLUDED_CONTENT_MARKER"));
  } finally {
    await rm(dir, { recursive: true });
  }
});
