import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { checkCitation } from "./citations.js";
import type {
  InterviewRecord,
  KnowledgeContext,
  LorelineConfig,
  ReadinessReport,
  VerificationIssue,
  VerificationReport,
} from "./types.js";
import { validateArtifact } from "./validation.js";

interface InterviewSource {
  file: string;
  record: InterviewRecord;
}

interface InterviewLoadResult {
  sources: InterviewSource[];
  issues: VerificationIssue[];
}

async function loadInterviewSet(outputDirectory: string): Promise<InterviewLoadResult> {
  const directory = path.join(outputDirectory, "interviews");
  let files: string[];
  try {
    files = (await readdir(directory))
      .filter((file) => file.endsWith(".json"))
      .sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { sources: [], issues: [] };
    }
    throw error;
  }

  const results = await Promise.all(
    files.map(async (file) => {
      const absolute = path.join(directory, file);
      const relative = path.join("interviews", file).split(path.sep).join("/");
      try {
        const value: unknown = JSON.parse(await readFile(absolute, "utf8"));
        return {
          source: {
            file: relative,
            record: await validateArtifact<InterviewRecord>("interview", value, absolute),
          },
        };
      } catch (error) {
        return {
          issue: {
            file: relative,
            severity: "error" as const,
            message: error instanceof Error ? error.message : String(error),
          },
        };
      }
    }),
  );
  return {
    sources: results.flatMap((result) => result.source ? [result.source] : []),
    issues: results.flatMap((result) => result.issue ? [result.issue] : []),
  };
}

export async function loadInterviews(outputDirectory: string): Promise<InterviewSource[]> {
  const result = await loadInterviewSet(outputDirectory);
  if (result.issues.length > 0) {
    throw new Error(
      `Unable to load interview records:\n${result.issues.map((issue) => `- ${issue.file}: ${issue.message}`).join("\n")}`,
    );
  }
  return result.sources;
}

export async function compileKnowledge(
  config: LorelineConfig,
  outputDirectory: string,
): Promise<{ markdownPath: string; jsonPath: string; records: number; answers: number }> {
  const sources = await loadInterviews(outputDirectory);
  if (sources.length === 0) {
    throw new Error("No interview records found. Run \"loreline interview\" first.");
  }

  const markdownPath = path.join(outputDirectory, "context.md");
  const jsonPath = path.join(outputDirectory, "context.json");
  const context = buildContext(config, sources);
  await validateArtifact<KnowledgeContext>("context", context, jsonPath);
  await mkdir(outputDirectory, { recursive: true });
  await Promise.all([
    writeFile(markdownPath, renderContext(context)),
    writeFile(jsonPath, `${JSON.stringify(context, null, 2)}\n`),
  ]);
  return {
    markdownPath,
    jsonPath,
    records: sources.length,
    answers: sources.reduce(
      (count, source) => count + source.record.answers.filter((answer) => answer.answer.trim()).length,
      0,
    ),
  };
}

export async function verifyKnowledge(
  config: LorelineConfig,
  outputDirectory: string,
  maxAgeDays: number,
  root: string,
  now = new Date(),
): Promise<VerificationReport> {
  const issues: VerificationIssue[] = [];
  const loaded = await loadInterviewSet(outputDirectory);
  const sources = loaded.sources;
  issues.push(...loaded.issues);
  issues.push(...(await checkReadinessCitations(root, outputDirectory)));

  if (sources.length === 0 && issues.length === 0) {
    issues.push({
      file: "interviews",
      severity: "error",
      message: "No structured interview records found.",
    });
  }

  const oldestAllowed = now.getTime() - maxAgeDays * 24 * 60 * 60 * 1000;
  for (const source of sources) {
    if (source.record.project !== config.project.name) {
      issues.push({
        file: source.file,
        severity: "error",
        message: `Project is "${source.record.project}", expected "${config.project.name}".`,
      });
    }
    if (new Date(source.record.generatedAt).getTime() < oldestAllowed) {
      issues.push({
        file: source.file,
        severity: "warning",
        message: `Knowledge is older than ${maxAgeDays} days and should be reverified.`,
      });
    }
    const unanswered = new Set([
      ...source.record.unanswered,
      ...source.record.answers.filter((answer) => !answer.answer.trim()).map((answer) => answer.id),
    ]);
    if (unanswered.size > 0) {
      issues.push({
        file: source.file,
        severity: "warning",
        message: `${unanswered.size} interview question(s) remain unanswered.`,
      });
    }
  }

  return {
    schemaVersion: 1,
    generatedAt: now.toISOString(),
    project: config.project.name,
    recordsChecked: sources.length,
    valid: issues.length === 0,
    issues,
  };
}

async function checkReadinessCitations(
  root: string,
  outputDirectory: string,
): Promise<VerificationIssue[]> {
  const loaded = await loadReadinessReport(outputDirectory);
  if (loaded.issue) {
    return [loaded.issue];
  }
  if (!loaded.report) {
    return [];
  }

  const issues: VerificationIssue[] = [];
  for (const findingEntry of loaded.report.findings) {
    for (const citation of findingEntry.citations ?? []) {
      try {
        const state = await checkCitation(root, citation);
        if (state === "changed") {
          issues.push({
            file: citation.file,
            severity: "warning",
            message: `Cited evidence changed since the readiness scan for "${findingEntry.title}": \`${citation.file}\`.`,
          });
        } else if (state === "missing") {
          issues.push({
            file: citation.file,
            severity: "warning",
            message: `Cited evidence missing since the readiness scan for "${findingEntry.title}": \`${citation.file}\`.`,
          });
        }
      } catch (error) {
        issues.push({
          file: citation.file,
          severity: "error",
          message: `Unable to check cited evidence \`${citation.file}\`: ${
            error instanceof Error ? error.message : String(error)
          }`,
        });
      }
    }
  }
  return issues;
}

interface ReadinessLoadResult {
  report: ReadinessReport | null;
  issue?: VerificationIssue;
}

async function loadReadinessReport(outputDirectory: string): Promise<ReadinessLoadResult> {
  const reportPath = path.join(outputDirectory, "readiness.json");
  try {
    const value: unknown = JSON.parse(await readFile(reportPath, "utf8"));
    const report = await validateArtifact<ReadinessReport>("readiness", value, reportPath);
    return { report };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { report: null };
    }
    return {
      report: null,
      issue: {
        file: "readiness.json",
        severity: "error",
        message: error instanceof Error ? error.message : String(error),
      },
    };
  }
}

export async function writeVerificationReport(
  report: VerificationReport,
  outputDirectory: string,
): Promise<string> {
  await mkdir(outputDirectory, { recursive: true });
  const reportPath = path.join(outputDirectory, "verification.json");
  await validateArtifact<VerificationReport>("verification", report, reportPath);
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  return reportPath;
}

function buildContext(config: LorelineConfig, sources: InterviewSource[]): KnowledgeContext {
  const entries = sources.flatMap((source) =>
    source.record.answers
      .filter((answer) => answer.answer.trim())
      .map((answer) => ({
        id: answer.id,
        category: answer.category,
        question: answer.question,
        answer: answer.answer,
        source: {
          file: source.file,
          interviewee: source.record.interviewee,
          generatedAt: source.record.generatedAt,
        },
      })),
  );
  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    project: config.project.name,
    owner: config.project.owner,
    entries,
    unresolved: sources.flatMap((source) =>
      source.record.answers
        .filter((answer) => !answer.answer.trim())
        .map((answer) => ({
          id: answer.id,
          question: answer.question,
          sourceFile: source.file,
        })),
    ),
    sources: sources.map((source) => ({
      file: source.file,
      interviewee: source.record.interviewee,
      generatedAt: source.record.generatedAt,
    })),
  };
}

function renderContext(context: KnowledgeContext): string {
  const categories = new Map<string, KnowledgeContext["entries"]>();
  for (const answer of context.entries) {
    const entries = categories.get(answer.category) ?? [];
    entries.push(answer);
    categories.set(answer.category, entries);
  }

  const sections = [...categories.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([category, entries]) => {
      const title = category
        .split("-")
        .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
        .join(" ");
      const content = entries
        .map(
          (entry) => `### ${entry.question}

${entry.answer}

_Source: ${entry.source.interviewee}, ${entry.source.generatedAt}, \`${entry.source.file}\`_
`,
        )
        .join("\n");
      return `## ${title}

${content}`;
    })
    .join("\n");

  return `# ${context.project} Knowledge Context

> Compiled by Loreline from ${context.sources.length} structured interview record(s).
> Treat this as reviewable source material, not an independently verified statement of fact.

**Owner:** ${context.owner}
**Compiled:** ${context.generatedAt}

${sections}

## Unresolved Questions

${context.unresolved.length > 0
    ? context.unresolved.map((item) => `- ${item.question} (\`${item.sourceFile}\`)`).join("\n")
    : "No unanswered interview questions."}

## Sources

${context.sources.map((source) => `- \`${source.file}\` (${source.interviewee}, ${source.generatedAt})`).join("\n")}
`;
}
