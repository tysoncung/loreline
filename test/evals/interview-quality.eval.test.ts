import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { compileWithAi, COMPILE_PROMPT_VERSION } from "../../src/ai/compiler.js";
import { generateQuestions, PROMPT_VERSION } from "../../src/ai/interviewer.js";
import { loadConfig } from "../../src/config.js";
import { buildInterviewQuestions, conductInterview, writeInterview } from "../../src/interview.js";
import { compileKnowledge } from "../../src/knowledge.js";
import { FakeProvider } from "../../src/providers/fake.js";
import { scanRepository } from "../../src/scanner.js";
import type { Finding, KnowledgeContext, ReadinessReport } from "../../src/types.js";
import { maybeRealProvider, recordEvalResult, setupEvalRepo, withEvalResult } from "./eval-helpers.js";

function report(findings: Finding[] = []): ReadinessReport {
  return {
    schemaVersion: 2,
    generatedAt: "2026-09-01T00:00:00.000Z",
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

// ---------------------------------------------------------------------------
// 1. Question non-duplication
// ---------------------------------------------------------------------------

test("eval: question non-duplication - a case-variant and an exact duplicate collapse to one accepted question", async () => {
  const provider = new FakeProvider(
    [
      JSON.stringify([
        { question: "Who owns the deploy pipeline?", category: "ownership", reason: "gap" },
        { question: "who owns the deploy pipeline?", category: "ownership", reason: "duplicate, different case" },
        { question: "Who owns the deploy pipeline?", category: "ownership", reason: "exact duplicate" },
      ]),
    ],
    "eval-model",
  );

  await withEvalResult(
    {
      eval: "question-non-duplication",
      provider: provider.name,
      model: provider.model,
      promptVersion: PROMPT_VERSION,
    },
    async () => {
      const questions = await generateQuestions({ provider, report: report(), evidence: [] });
      const normalized = questions.map((question) => question.question.trim().toLowerCase());
      const distinct = new Set(normalized);

      assert.equal(questions.length, 1, `expected exactly one accepted question from 3 scripted duplicates, got ${questions.length}`);
      assert.equal(distinct.size, normalized.length, "accepted question set must have no case-insensitive duplicate texts");

      return `accepted ${questions.length} question(s) from 3 scripted duplicates (exact + case-variant): "${questions[0]?.question}"`;
    },
  );
});

// ---------------------------------------------------------------------------
// 2. Readiness-gap coverage
// ---------------------------------------------------------------------------

// Mirrors the finding ids that src/interview.ts's private FINDING_QUESTIONS
// map to a deterministic question today. FINDING_QUESTIONS is not exported,
// so this is a maintained snapshot rather than an import: if a mapping is
// removed, the hard assertion below fails; if a new finding id is ever added
// to the scanner without a matching question, it lands in "unmapped" in
// `details` (documented, not a hard failure) rather than crashing on an
// unrecognized id.
const KNOWN_MAPPED_FINDING_IDS = new Set([
  "project-overview",
  "ai-guidance",
  "ownership",
  "architecture",
  "decisions",
  "operations",
  "verification",
  "knowledge-concentration",
]);

test("eval: readiness-gap coverage - every known-mapped non-pass finding id appears as a question's sourceFinding", async () => {
  const evalRepo = await setupEvalRepo();
  try {
    await withEvalResult(
      { eval: "readiness-gap-coverage", provider: "n/a", model: "n/a", promptVersion: "n/a" },
      async () => {
        const config = await loadConfig(evalRepo.root);
        const scanned = await scanRepository(evalRepo.root, config);
        const nonPassFindings = scanned.findings.filter((item) => item.status !== "pass");
        assert.ok(nonPassFindings.length > 0, "eval-repo fixture must produce at least one non-pass finding");

        const questions = buildInterviewQuestions(scanned);
        const covered = new Set(
          questions.map((question) => question.sourceFinding).filter((id): id is string => id !== undefined),
        );

        const expectedMapped = nonPassFindings.filter((item) => KNOWN_MAPPED_FINDING_IDS.has(item.id));
        const unmapped = nonPassFindings.filter((item) => !KNOWN_MAPPED_FINDING_IDS.has(item.id));

        for (const item of expectedMapped) {
          assert.ok(
            covered.has(item.id),
            `expected buildInterviewQuestions to produce a question with sourceFinding "${item.id}"`,
          );
        }

        return (
          `non-pass findings: ${nonPassFindings.map((f) => f.id).join(", ")}; ` +
          `covered: ${[...covered].join(", ") || "none"}; ` +
          `finding ids with no known FINDING_QUESTIONS mapping: ${unmapped.map((f) => f.id).join(", ") || "none"}`
        );
      },
    );
  } finally {
    await evalRepo.cleanup();
  }
});

// ---------------------------------------------------------------------------
// 3. Grounding (deterministic end-to-end check)
// ---------------------------------------------------------------------------

test("eval: grounding - a question referencing an unknown finding is dropped; every accepted sourceFinding exists in the report", async () => {
  const rpt = report([finding({ id: "architecture" })]);
  const provider = new FakeProvider(
    [
      JSON.stringify([
        { question: "How do requests flow through the system?", category: "architecture", reason: "gap", sourceFinding: "architecture" },
        { question: "Ungrounded question?", category: "architecture", reason: "gap", sourceFinding: "nonexistent-finding" },
      ]),
    ],
    "eval-model",
  );

  await withEvalResult(
    { eval: "grounding", provider: provider.name, model: provider.model, promptVersion: PROMPT_VERSION },
    async () => {
      const questions = await generateQuestions({ provider, report: rpt, evidence: [] });
      const findingIds = new Set(rpt.findings.map((item) => item.id));

      assert.equal(questions.length, 1, "the question citing an unknown finding must be dropped");
      assert.equal(questions[0]?.sourceFinding, "architecture");
      for (const question of questions) {
        if (question.sourceFinding !== undefined) {
          assert.ok(findingIds.has(question.sourceFinding), `sourceFinding "${question.sourceFinding}" is not present in the report`);
        }
      }

      return '1 question accepted (grounded in "architecture"), 1 dropped (unknown sourceFinding "nonexistent-finding")';
    },
  );
});

// ---------------------------------------------------------------------------
// 6. Contradiction preservation
// ---------------------------------------------------------------------------

test("eval: contradiction preservation - contradictory answers surface in the interview record and in compile proposals", async () => {
  const evalRepo = await setupEvalRepo();
  try {
    await withEvalResult(
      { eval: "contradiction-preservation", provider: "fake", model: "eval-model", promptVersion: `${PROMPT_VERSION},${COMPILE_PROMPT_VERSION}` },
      async () => {
        const config = await loadConfig(evalRepo.root);
        const outputDirectory = path.join(evalRepo.root, ".loreline");
        const rpt = report();
        // scope.categories: ["risk"] narrows the deterministic question set to
        // exactly one BASE_QUESTIONS entry ("fragile-areas"), so both
        // interviewees answer the same question id with contradicting text.
        const scope = { categories: ["risk"] };

        const alex = await conductInterview({
          config,
          report: rpt,
          reportPath: ".loreline/readiness.json",
          interviewee: "Alex",
          interviewer: "Loreline",
          outputDirectory,
          scope,
          answersPath: await writeAnswers(evalRepo.root, "alex-answers.json", {
            "fragile-areas":
              "The payment retry logic is the most fragile part of the system and needs extra care during any change.",
          }),
        });
        await writeInterview(alex, outputDirectory);

        const bailey = await conductInterview({
          config,
          report: rpt,
          reportPath: ".loreline/readiness.json",
          interviewee: "Bailey",
          interviewer: "Loreline",
          outputDirectory,
          scope,
          answersPath: await writeAnswers(evalRepo.root, "bailey-answers.json", {
            "fragile-areas":
              "Nothing in the payment retry logic is fragile; it is the most stable, well-tested part of the codebase.",
          }),
        });
        await writeInterview(bailey, outputDirectory);

        // A third interview, driven with a fake provider, exercises
        // detectContradictions landing inside a single interview record.
        const contradictionProvider = new FakeProvider(
          ["[]", JSON.stringify(["The fragile-areas answer conflicts with a claim made elsewhere in the interview."])],
          "eval-model",
        );
        const casey = await conductInterview({
          config,
          report: rpt,
          reportPath: ".loreline/readiness.json",
          interviewee: "Casey",
          interviewer: "Loreline",
          outputDirectory,
          scope,
          answersPath: await writeAnswers(evalRepo.root, "casey-answers.json", {
            "fragile-areas": "This part of the system is fragile due to legacy retry logic nobody fully trusts anymore.",
          }),
          ai: { provider: contradictionProvider, maxFollowups: 0, evidence: [] },
        });

        const contradictionEntry = casey.answers.find((entry) => entry.id.startsWith("contradiction-"));
        assert.ok(contradictionEntry, "expected a contradiction- entry in the interview record");
        assert.equal(contradictionEntry?.category, "contradiction");
        assert.equal(contradictionEntry?.answer, "");
        assert.ok(casey.unanswered.includes(contradictionEntry!.id));

        // Alex's and Bailey's records disagree on "fragile-areas"; compileKnowledge
        // + compileWithAi must always surface that deterministically, independent
        // of what the model itself reports.
        const compiled = await compileKnowledge(config, outputDirectory);
        const context = JSON.parse(await readFile(compiled.jsonPath, "utf8")) as KnowledgeContext;
        const compileProvider = new FakeProvider(
          [JSON.stringify({ summary: "Consolidated summary.", conflicts: [], suggestions: [] })],
          "eval-model",
        );
        const result = await compileWithAi({ provider: compileProvider, context, outputDirectory });
        const proposal = await readFile(path.join(result.directory, "proposal.md"), "utf8");

        assert.match(proposal, /### Unresolved and conflicting/);
        const unresolvedSection = proposal.split("### Unresolved and conflicting")[1] ?? "";
        assert.match(unresolvedSection, /fragile-areas/);
        assert.match(unresolvedSection, /most fragile part of the system/);
        assert.match(unresolvedSection, /most stable, well-tested part/);
        assert.ok(result.conflicts >= 1, "compileWithAi must report at least one conflict");

        return (
          `interview record: contradiction entry "${contradictionEntry?.id}" (category contradiction, unanswered); ` +
          `compile proposal: "fragile-areas" conflict listed under Unresolved and conflicting (${result.conflicts} total conflict(s))`
        );
      },
    );
  } finally {
    await evalRepo.cleanup();
  }
});

async function writeAnswers(root: string, filename: string, answers: Record<string, string>): Promise<string> {
  const answersPath = path.join(root, filename);
  await writeFile(answersPath, JSON.stringify(answers));
  return answersPath;
}

// ---------------------------------------------------------------------------
// Model-graded grounding spot-check (skipped unless LORELINE_EVAL_PROVIDER is set)
// ---------------------------------------------------------------------------

test("eval (model-graded): grounding spot-check against a real provider", async (t) => {
  const provider = maybeRealProvider();
  if (!provider) {
    t.skip("set LORELINE_EVAL_PROVIDER=openai|anthropic|ollama (plus the provider's API key) to run this eval locally");
    return;
  }

  const evalRepo = await setupEvalRepo();
  try {
    const config = await loadConfig(evalRepo.root);
    const scanned = await scanRepository(evalRepo.root, config);
    const evidence = [{ file: "README.md", excerpt: await readFile(path.join(evalRepo.root, "README.md"), "utf8") }];

    let pass = false;
    let details = "";
    try {
      const questions = await generateQuestions({ provider, report: scanned, evidence, maxQuestions: 5 });
      const findingIds = new Set(scanned.findings.map((item) => item.id));
      const grounded = questions.filter(
        (question) => question.sourceFinding === undefined || findingIds.has(question.sourceFinding),
      );
      assert.equal(grounded.length, questions.length, "every accepted question's sourceFinding must exist in the report");
      pass = true;
      details = `provider ${provider.name}/${provider.model} returned ${questions.length} question(s), all grounded`;
    } catch (error) {
      details = error instanceof Error ? error.message : String(error);
      throw error;
    } finally {
      await recordEvalResult({
        eval: "grounding-spot-check-model-graded",
        provider: provider.name,
        model: provider.model,
        promptVersion: PROMPT_VERSION,
        pass,
        details,
      });
    }
  } finally {
    await evalRepo.cleanup();
  }
});
