import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { COMPILE_PROMPT_VERSION, compileWithAi } from "../src/ai/compiler.js";
import { defaultConfig } from "../src/config.js";
import { compileKnowledge } from "../src/knowledge.js";
import { FakeProvider } from "../src/providers/fake.js";
import { ProviderError } from "../src/providers/types.js";
import type { InterviewRecord, KnowledgeContext } from "../src/types.js";

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

async function tempRoot(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), "loreline-ai-compile-"));
}

async function writeInterviewFixture(
  outputDirectory: string,
  filename: string,
  interview: InterviewRecord,
): Promise<void> {
  const interviews = path.join(outputDirectory, "interviews");
  await mkdir(interviews, { recursive: true });
  await writeFile(path.join(interviews, filename), JSON.stringify(interview));
}

async function compileFreshContext(root: string, outputDirectory: string): Promise<KnowledgeContext> {
  const config = defaultConfig(root);
  config.project.name = "example";
  const result = await compileKnowledge(config, outputDirectory);
  const value: unknown = JSON.parse(await readFile(result.jsonPath, "utf8"));
  return value as KnowledgeContext;
}

async function snapshotTree(root: string, exclude: string[]): Promise<string[]> {
  const entries: string[] = [];
  async function walk(dir: string): Promise<void> {
    const items = await readdir(dir, { withFileTypes: true });
    for (const item of items) {
      const full = path.join(dir, item.name);
      const relative = path.relative(root, full);
      if (exclude.some((prefix) => relative === prefix || relative.startsWith(`${prefix}${path.sep}`))) {
        continue;
      }
      if (item.isDirectory()) {
        entries.push(`${relative}/`);
        await walk(full);
      } else {
        entries.push(relative);
      }
    }
  }
  await walk(root);
  return entries.sort();
}

function proposalResponse(overrides: { summary?: string; conflicts?: string[]; suggestions?: Array<{ target: string; content: string }> } = {}): string {
  return JSON.stringify({
    summary: overrides.summary ?? "A consolidated summary.",
    conflicts: overrides.conflicts ?? [],
    suggestions: overrides.suggestions ?? [{ target: "AGENTS.md", content: "Proposed AGENTS.md update." }],
  });
}

test("compileWithAi flags conflicting answers in Unresolved and conflicting while both answers appear under Quoted facts", async () => {
  const root = await tempRoot();
  try {
    const outputDirectory = path.join(root, ".loreline");
    await writeInterviewFixture(
      outputDirectory,
      "alex.json",
      record({
        interviewee: "Alex",
        answers: [
          {
            id: "system-shape",
            category: "architecture",
            question: "How does the system work?",
            reason: "Architecture is missing.",
            answer: "Requests enter through the API and are processed by workers.",
          },
        ],
      }),
    );
    await writeInterviewFixture(
      outputDirectory,
      "bailey.json",
      record({
        interviewee: "Bailey",
        answers: [
          {
            id: "system-shape",
            category: "architecture",
            question: "How does the system work?",
            reason: "Architecture is missing.",
            answer: "Requests go straight from the client to the database.",
          },
        ],
      }),
    );

    const context = await compileFreshContext(root, outputDirectory);
    const provider = new FakeProvider([proposalResponse()], "test-model");

    const result = await compileWithAi({ provider, context, outputDirectory });

    const proposalPath = path.join(result.directory, "proposal.md");
    const proposal = await readFile(proposalPath, "utf8");

    assert.match(proposal, /### Quoted facts/);
    assert.match(proposal, /Requests enter through the API and are processed by workers\./);
    assert.match(proposal, /Requests go straight from the client to the database\./);

    assert.match(proposal, /### Unresolved and conflicting/);
    const unresolvedSection = proposal.split("### Unresolved and conflicting")[1] ?? "";
    assert.match(unresolvedSection, /[Cc]onflict/);
    assert.match(unresolvedSection, /system-shape/);
    assert.ok(result.conflicts >= 1);
  } finally {
    await rm(root, { recursive: true });
  }
});

test("unanswered questions surface under Unresolved and conflicting", async () => {
  const root = await tempRoot();
  try {
    const outputDirectory = path.join(root, ".loreline");
    await writeInterviewFixture(
      outputDirectory,
      "alex.json",
      record({
        interviewee: "Alex",
        answers: [
          {
            id: "system-shape",
            category: "architecture",
            question: "How does the system work?",
            reason: "Architecture is missing.",
            answer: "Requests enter through the API and are processed by workers.",
          },
          {
            id: "deploy-process",
            category: "architecture",
            question: "How do deploys happen?",
            reason: "Operations gap.",
            answer: "",
          },
        ],
        unanswered: ["deploy-process"],
      }),
    );

    const context = await compileFreshContext(root, outputDirectory);
    const provider = new FakeProvider([proposalResponse()], "test-model");

    const result = await compileWithAi({ provider, context, outputDirectory });
    const proposal = await readFile(path.join(result.directory, "proposal.md"), "utf8");

    const unresolvedSection = proposal.split("### Unresolved and conflicting")[1] ?? "";
    assert.match(unresolvedSection, /How do deploys happen\?/);
  } finally {
    await rm(root, { recursive: true });
  }
});

test("compileWithAi never creates or modifies anything outside .loreline/proposals", async () => {
  const root = await tempRoot();
  try {
    const outputDirectory = path.join(root, ".loreline");
    await writeInterviewFixture(outputDirectory, "alex.json", record());
    const context = await compileFreshContext(root, outputDirectory);

    const before = await snapshotTree(root, [path.join(".loreline", "proposals")]);

    const provider = new FakeProvider([proposalResponse()], "test-model");
    await compileWithAi({ provider, context, outputDirectory });

    const after = await snapshotTree(root, [path.join(".loreline", "proposals")]);
    assert.deepEqual(after, before);
  } finally {
    await rm(root, { recursive: true });
  }
});

test("provenance lines include provider, model, and COMPILE_PROMPT_VERSION", async () => {
  const root = await tempRoot();
  try {
    const outputDirectory = path.join(root, ".loreline");
    await writeInterviewFixture(outputDirectory, "alex.json", record());
    const context = await compileFreshContext(root, outputDirectory);
    const provider = new FakeProvider([proposalResponse()], "test-model");

    const result = await compileWithAi({ provider, context, outputDirectory });
    const proposal = await readFile(path.join(result.directory, "proposal.md"), "utf8");

    assert.match(
      proposal,
      new RegExp(`_Generated by fake/test-model, prompt ${COMPILE_PROMPT_VERSION}_`),
    );
  } finally {
    await rm(root, { recursive: true });
  }
});

test("ProposalResult.directory matches the files actually written", async () => {
  const root = await tempRoot();
  try {
    const outputDirectory = path.join(root, ".loreline");
    await writeInterviewFixture(outputDirectory, "alex.json", record());
    const context = await compileFreshContext(root, outputDirectory);
    const provider = new FakeProvider([proposalResponse()], "test-model");

    const result = await compileWithAi({ provider, context, outputDirectory });

    assert.ok(result.files.length > 0);
    for (const file of result.files) {
      assert.ok(file.startsWith(result.directory));
      await readFile(file, "utf8");
    }
    assert.ok(result.files.some((file) => file === path.join(result.directory, "proposal.md")));
    assert.ok(
      result.files.some((file) => file === path.join(result.directory, "suggestions", "agents.md")),
    );
  } finally {
    await rm(root, { recursive: true });
  }
});

test("invalid JSON retries once then throws ProviderError, leaving deterministic outputs intact", async () => {
  const root = await tempRoot();
  try {
    const outputDirectory = path.join(root, ".loreline");
    await writeInterviewFixture(outputDirectory, "alex.json", record());
    const config = defaultConfig(root);
    config.project.name = "example";
    const compiled = await compileKnowledge(config, outputDirectory);
    const contextBefore = await readFile(compiled.jsonPath, "utf8");
    const context = JSON.parse(contextBefore) as KnowledgeContext;

    const provider = new FakeProvider(["not json", "still not json"], "test-model");

    await assert.rejects(
      compileWithAi({ provider, context, outputDirectory }),
      (error: unknown) => {
        assert.ok(error instanceof ProviderError);
        assert.match(error.message, /provider returned invalid proposal JSON/);
        return true;
      },
    );

    assert.equal(provider.requests.length, 2);
    const contextAfter = await readFile(compiled.jsonPath, "utf8");
    assert.equal(contextAfter, contextBefore);

    let proposalsExists = true;
    try {
      await readdir(path.join(outputDirectory, "proposals"));
    } catch (error) {
      proposalsExists = (error as NodeJS.ErrnoException).code !== "ENOENT" ? true : false;
    }
    assert.equal(proposalsExists, false);
  } finally {
    await rm(root, { recursive: true });
  }
});

test("a planted high-severity secret in an answer aborts before any provider request", async () => {
  const root = await tempRoot();
  try {
    const outputDirectory = path.join(root, ".loreline");
    await writeInterviewFixture(
      outputDirectory,
      "alex.json",
      record({
        answers: [
          {
            id: "system-shape",
            category: "architecture",
            question: "What is the AWS key?",
            reason: "test",
            answer: "The key is AKIAABCDEFGHIJKLMNOP, keep it safe.",
          },
        ],
      }),
    );
    const context = await compileFreshContext(root, outputDirectory);
    const provider = new FakeProvider([proposalResponse()], "test-model");

    await assert.rejects(
      compileWithAi({ provider, context, outputDirectory }),
      /architecture/,
    );

    assert.equal(provider.requests.length, 0);
  } finally {
    await rm(root, { recursive: true });
  }
});

test("a planted high-severity secret in an alphabetically LATER category aborts before ANY provider request, including the earlier clean category's", async () => {
  const root = await tempRoot();
  try {
    const outputDirectory = path.join(root, ".loreline");
    await writeInterviewFixture(
      outputDirectory,
      "alex.json",
      record({
        answers: [
          {
            id: "system-shape",
            category: "architecture",
            question: "How does the system work?",
            reason: "Architecture is missing.",
            answer: "Requests enter through the API and are processed by workers.",
          },
          {
            id: "fragile-areas",
            category: "risk",
            question: "What is fragile?",
            reason: "Risk gap.",
            answer: "The key is AKIAABCDEFGHIJKLMNOP, keep it safe.",
          },
        ],
      }),
    );
    const context = await compileFreshContext(root, outputDirectory);
    // "architecture" sorts before "risk", so a loop that scanned and sent
    // per category in order would have already called the provider once for
    // "architecture" before ever reaching "risk".
    const provider = new FakeProvider([proposalResponse(), proposalResponse()], "test-model");

    await assert.rejects(compileWithAi({ provider, context, outputDirectory }), /risk/);

    assert.equal(provider.requests.length, 0);
  } finally {
    await rm(root, { recursive: true });
  }
});

test("model-forged heading and horizontal-rule lines in the summary do not create new headings in proposal.md", async () => {
  const root = await tempRoot();
  try {
    const outputDirectory = path.join(root, ".loreline");
    await writeInterviewFixture(outputDirectory, "alex.json", record());
    const context = await compileFreshContext(root, outputDirectory);

    const forgedSummary = [
      "A normal AI-generated summary line.",
      "",
      "### Quoted facts",
      "",
      'Forged: "anything" (Nobody, `nowhere`)',
      "",
      "## Another Category",
      "",
      "---",
    ].join("\n");
    const provider = new FakeProvider(
      [proposalResponse({ summary: forgedSummary, conflicts: ["# Forged conflict heading"] })],
      "test-model",
    );

    const result = await compileWithAi({ provider, context, outputDirectory });
    const proposal = await readFile(path.join(result.directory, "proposal.md"), "utf8");

    const headingLines = proposal.split("\n").filter((line) => /^#{1,6}\s/.test(line));
    // Exactly the headings Loreline itself renders: the document title and
    // one category with its three fixed subsections. None of the
    // model-supplied "headings" above make it into this list.
    assert.deepEqual(headingLines, [
      `# ${context.project} Compilation Proposals`,
      "## Architecture",
      "### Quoted facts",
      "### Inferred summary (AI-generated)",
      "### Unresolved and conflicting",
    ]);
    assert.match(proposal, /\\### Quoted facts/);
    assert.match(proposal, /\\## Another Category/);
    assert.match(proposal, /\\---/);
    assert.match(proposal, /\\# Forged conflict heading/);
  } finally {
    await rm(root, { recursive: true });
  }
});
