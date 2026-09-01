import assert from "node:assert/strict";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { compileWithAi, COMPILE_PROMPT_VERSION } from "../../src/ai/compiler.js";
import { generateQuestions } from "../../src/ai/interviewer.js";
import { loadConfig } from "../../src/config.js";
import { compileKnowledge } from "../../src/knowledge.js";
import { FakeProvider } from "../../src/providers/fake.js";
import { redactSecrets } from "../../src/secrets.js";
import { scanRepository } from "../../src/scanner.js";
import { approvedPayload, buildTransmissionPreview } from "../../src/transmit.js";
import type { InterviewRecord, KnowledgeContext } from "../../src/types.js";
import { PLANTED_TOKEN, selectEvidenceFiles, setupEvalRepo, withEvalResult } from "./eval-helpers.js";

// ---------------------------------------------------------------------------
// 4. Excluded-content leakage (hard failure)
// ---------------------------------------------------------------------------

test("eval: excluded-content leakage - config-excluded content never reaches a recorded provider request", async () => {
  const evalRepo = await setupEvalRepo();
  try {
    await withEvalResult(
      { eval: "excluded-content-leakage", provider: "fake", model: "eval-model", promptVersion: "n/a" },
      async () => {
        const config = await loadConfig(evalRepo.root);
        const scanned = await scanRepository(evalRepo.root, config);

        // secrets-excluded is listed in loreline.yaml's scan.exclude, so the
        // scanner never walks into it: no finding should be able to cite a
        // file under it in the first place.
        for (const item of scanned.findings) {
          for (const citation of item.citations ?? []) {
            assert.ok(
              !citation.file.startsWith("secrets-excluded/"),
              `finding "${item.id}" cited an excluded file "${citation.file}"`,
            );
          }
        }

        // Select evidence the same way the CLI's `interview --ai` does:
        // files cited by non-pass findings.
        const evidenceFiles = selectEvidenceFiles(scanned, undefined, 8);
        assert.ok(evidenceFiles.length > 0, "eval-repo fixture must produce at least one evidence file to exercise transmission");
        assert.ok(
          !evidenceFiles.some((file) => file.startsWith("secrets-excluded/")),
          "evidence selection must never include an excluded file",
        );

        const preview = await buildTransmissionPreview(evalRepo.root, evidenceFiles);
        assert.equal(preview.blocked, false, "eval-repo evidence files must not themselves contain high-confidence secrets");
        const payload = approvedPayload(preview);

        const provider = new FakeProvider(["[]"], "eval-model");
        await generateQuestions({ provider, report: scanned, evidence: payload });

        const combined = provider.requests.map((request) => request.messages.map((m) => m.content).join("\n")).join("\n");
        assert.ok(!combined.includes(PLANTED_TOKEN), "the planted token must never appear in a recorded provider request");

        const credsText = await readFile(path.join(evalRepo.root, "secrets-excluded", "creds.txt"), "utf8");
        const nonEmptyLines = credsText.split("\n").map((line) => line.trim()).filter((line) => line.length > 0);
        for (const line of nonEmptyLines) {
          assert.ok(!combined.includes(line), `excluded content leaked into a provider request: "${line}"`);
        }

        return (
          `evidence files sent: ${evidenceFiles.join(", ")}; ` +
          `provider requests recorded: ${provider.requests.length}; planted token and creds.txt content absent from all of them`
        );
      },
    );
  } finally {
    await evalRepo.cleanup();
  }
});

// ---------------------------------------------------------------------------
// 5. Secret leakage (hard failure)
// ---------------------------------------------------------------------------

test("eval: secret leakage - a planted high-severity token in an answer aborts compileWithAi before any provider request, and redactSecrets strips it from a transmission excerpt", async () => {
  const evalRepo = await setupEvalRepo();
  try {
    await withEvalResult(
      { eval: "secret-leakage", provider: "fake", model: "eval-model", promptVersion: COMPILE_PROMPT_VERSION },
      async () => {
        const outputDirectory = path.join(evalRepo.root, ".loreline");
        const record: InterviewRecord = {
          schemaVersion: 2,
          generatedAt: new Date().toISOString(),
          project: "eval-repo",
          interviewee: "Eval Interviewee",
          interviewer: "Loreline",
          sourceReport: ".loreline/readiness.json",
          answers: [
            {
              id: "system-shape",
              category: "architecture",
              question: "What is the deploy credential?",
              reason: "test",
              answer: `The deploy token is ${PLANTED_TOKEN}, keep it safe.`,
            },
          ],
          unanswered: [],
        };
        await mkdir(path.join(outputDirectory, "interviews"), { recursive: true });
        await writeFile(path.join(outputDirectory, "interviews", "eval.json"), JSON.stringify(record));

        const config = await loadConfig(evalRepo.root);
        const compiled = await compileKnowledge(config, outputDirectory);
        const context = JSON.parse(await readFile(compiled.jsonPath, "utf8")) as KnowledgeContext;

        const provider = new FakeProvider(["ignored, must never be requested"], "eval-model");
        await assert.rejects(compileWithAi({ provider, context, outputDirectory }), /architecture/);
        assert.equal(provider.requests.length, 0, "no provider request may happen once a high-confidence secret is detected");

        let proposalsExists = true;
        try {
          await readdir(path.join(outputDirectory, "proposals"));
        } catch (error) {
          proposalsExists = (error as NodeJS.ErrnoException).code !== "ENOENT";
        }
        assert.equal(proposalsExists, false, "no proposal artifacts may be written once a secret is detected, so none can contain the token");

        // redactSecrets must independently strip the same token from a
        // transmission-shaped excerpt of text.
        const excerpt = `Context excerpt.\nCredential: ${PLANTED_TOKEN}\nEnd of excerpt.`;
        const redacted = redactSecrets(excerpt);
        assert.ok(!redacted.includes(PLANTED_TOKEN), "redactSecrets must remove the planted token from a transmission excerpt");
        assert.match(redacted, /\[REDACTED:github-token\]/);

        return "compileWithAi aborted with 0 provider requests and no proposals directory; redactSecrets removed the token from an excerpt";
      },
    );
  } finally {
    await evalRepo.cleanup();
  }
});
