import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type {
  InterviewRecord,
  LorelineConfig,
  VerificationIssue,
  VerificationReport,
} from "./types.js";

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
          source: { file: relative, record: validateInterview(value, absolute) },
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
): Promise<{ markdownPath: string; records: number; answers: number }> {
  const sources = await loadInterviews(outputDirectory);
  if (sources.length === 0) {
    throw new Error("No interview records found. Run \"loreline interview\" first.");
  }

  const markdownPath = path.join(outputDirectory, "context.md");
  await mkdir(outputDirectory, { recursive: true });
  await writeFile(markdownPath, renderContext(config, sources));
  return {
    markdownPath,
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
  now = new Date(),
): Promise<VerificationReport> {
  const issues: VerificationIssue[] = [];
  const loaded = await loadInterviewSet(outputDirectory);
  const sources = loaded.sources;
  issues.push(...loaded.issues);

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

export async function writeVerificationReport(
  report: VerificationReport,
  outputDirectory: string,
): Promise<string> {
  await mkdir(outputDirectory, { recursive: true });
  const reportPath = path.join(outputDirectory, "verification.json");
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  return reportPath;
}

function validateInterview(value: unknown, file: string): InterviewRecord {
  if (
    typeof value !== "object" ||
    value === null ||
    !("schemaVersion" in value) ||
    !("generatedAt" in value) ||
    !("project" in value) ||
    !("interviewee" in value) ||
    !("interviewer" in value) ||
    !("sourceReport" in value) ||
    !("answers" in value) ||
    !("unanswered" in value)
  ) {
    throw new Error(`Invalid interview record: ${file}`);
  }

  const record = value as Partial<InterviewRecord>;
  if (
    record.schemaVersion !== 1 ||
    typeof record.generatedAt !== "string" ||
    Number.isNaN(Date.parse(record.generatedAt)) ||
    typeof record.project !== "string" ||
    typeof record.interviewee !== "string" ||
    typeof record.interviewer !== "string" ||
    typeof record.sourceReport !== "string" ||
    !Array.isArray(record.answers) ||
    !record.answers.every(isInterviewAnswer) ||
    !Array.isArray(record.unanswered) ||
    !record.unanswered.every((item) => typeof item === "string")
  ) {
    throw new Error(`Invalid interview record fields: ${file}`);
  }
  return record as InterviewRecord;
}

function isInterviewAnswer(value: unknown): value is InterviewRecord["answers"][number] {
  return (
    typeof value === "object" &&
    value !== null &&
    "id" in value &&
    typeof value.id === "string" &&
    "category" in value &&
    typeof value.category === "string" &&
    "question" in value &&
    typeof value.question === "string" &&
    "reason" in value &&
    typeof value.reason === "string" &&
    "answer" in value &&
    typeof value.answer === "string"
  );
}

function renderContext(config: LorelineConfig, sources: InterviewSource[]): string {
  const answered = sources.flatMap((source) =>
    source.record.answers
      .filter((answer) => answer.answer.trim())
      .map((answer) => ({ ...answer, source })),
  );
  const categories = new Map<string, typeof answered>();
  for (const answer of answered) {
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

_Source: ${entry.source.record.interviewee}, ${entry.source.record.generatedAt}, \`${entry.source.file}\`_
`,
        )
        .join("\n");
      return `## ${title}

${content}`;
    })
    .join("\n");

  const unresolved = sources.flatMap((source) =>
    source.record.answers
      .filter((answer) => !answer.answer.trim())
      .map((answer) => `- ${answer.question} (\`${source.file}\`)`),
  );

  return `# ${config.project.name} Knowledge Context

> Compiled by Loreline from ${sources.length} structured interview record(s).
> Treat this as reviewable source material, not an independently verified statement of fact.

**Owner:** ${config.project.owner}
**Compiled:** ${new Date().toISOString()}

${sections}

## Unresolved Questions

${unresolved.length > 0 ? unresolved.join("\n") : "No unanswered interview questions."}

## Sources

${sources.map((source) => `- \`${source.file}\` (${source.record.interviewee}, ${source.record.generatedAt})`).join("\n")}
`;
}
