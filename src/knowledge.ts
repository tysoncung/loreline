import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { loadImportLog, type ImportLog } from "./adapters/types.js";
import { checkCitation } from "./citations.js";
import { effectiveReview, fingerprintAnswer, loadReviews, type ReviewEntry, type ReviewLog } from "./review.js";
import type {
  InterviewRecord,
  KnowledgeContext,
  KnowledgeContextImport,
  KnowledgeEntry,
  KnowledgeEntryReview,
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

  const reviewLog = await loadReviews(outputDirectory);
  const importLog = await loadImportLog(outputDirectory);
  const markdownPath = path.join(outputDirectory, "context.md");
  const jsonPath = path.join(outputDirectory, "context.json");
  const context = buildContext(config, sources, reviewLog, importLog);
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
  options: { requireApproval?: boolean } = {},
): Promise<VerificationReport> {
  const issues: VerificationIssue[] = [];
  const loaded = await loadInterviewSet(outputDirectory);
  const sources = loaded.sources;
  issues.push(...loaded.issues);
  issues.push(...(await checkReadinessCitations(root, outputDirectory)));
  if (options.requireApproval) {
    issues.push(...(await checkApprovals(outputDirectory, now)));
  }

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

// Enforces the human-approval policy for --require-approval: every compiled
// entry needs a current (non-stale) approved review. A stale approval (the
// answer changed since it was reviewed) is downgraded to a warning rather
// than an error, since it was reviewed once and just needs a fresh look. An
// approved-and-current review with a past-due dueDate also warns.
async function checkApprovals(outputDirectory: string, now: Date): Promise<VerificationIssue[]> {
  const contextPath = path.join(outputDirectory, "context.json");
  let context: KnowledgeContext;
  try {
    const value: unknown = JSON.parse(await readFile(contextPath, "utf8"));
    context = await validateArtifact<KnowledgeContext>("context", value, contextPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [
        {
          file: "context.json",
          severity: "error",
          message: "No compiled knowledge context found. Run \"loreline compile\" first.",
        },
      ];
    }
    return [
      {
        file: "context.json",
        severity: "error",
        message: error instanceof Error ? error.message : String(error),
      },
    ];
  }

  const issues: VerificationIssue[] = [];
  for (const entry of context.entries) {
    const review = entry.review;
    if (review?.stale) {
      issues.push({
        file: entry.id,
        severity: "warning",
        message: `Approval for "${entry.question}" is stale: the answer changed since it was reviewed.`,
      });
      continue;
    }
    if (!review || review.status !== "approved") {
      issues.push({
        file: entry.id,
        severity: "error",
        message: `"${entry.question}" has no current approved review. Run "loreline review --entry ${entry.id} --approve --owner <name>".`,
      });
      continue;
    }
    if (review.dueDate && new Date(review.dueDate).getTime() < now.getTime()) {
      issues.push({
        file: entry.id,
        severity: "warning",
        message: `Review for "${entry.question}" is overdue (due ${review.dueDate}).`,
      });
    }
  }
  return issues;
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

// Resolves the review metadata to attach to one compiled entry. When the
// entry's current answer has a matching (current) review, that review's
// details are surfaced directly. When reviews exist for the entryId but none
// match the current answer fingerprint, the entry is stale: the most recent
// review on record is still surfaced (so readers know who last looked at it
// and why it needs a fresh look), but marked `stale: true`. AI-origin answers
// are never auto-approved here: a review only ever comes from entries
// recorded through `recordReview`/`applyReview`, driven by the review CLI
// command, never fabricated during compilation.
function resolveEntryReview(
  reviewLog: ReviewLog | undefined,
  entryId: string,
  answer: string,
): KnowledgeEntryReview | undefined {
  const fingerprint = fingerprintAnswer(answer);
  const effective = effectiveReview(reviewLog, entryId, fingerprint);
  if (effective.entry) {
    return toReviewSummary(effective.entry, false, effective.conflicting);
  }
  if (!effective.stale) {
    return undefined;
  }

  const priorReviews = (reviewLog?.entries ?? []).filter((review) => review.entryId === entryId);
  if (priorReviews.length === 0) {
    return undefined;
  }
  const latestPrior = priorReviews.reduce((best, review) =>
    new Date(review.reviewedAt).getTime() >= new Date(best.reviewedAt).getTime() ? review : best,
  );
  return toReviewSummary(latestPrior, true, false);
}

function toReviewSummary(
  review: ReviewEntry,
  stale: boolean,
  conflicting: boolean,
): KnowledgeEntryReview {
  return {
    status: review.status,
    owner: review.owner,
    reviewedAt: review.reviewedAt,
    ...(review.dueDate ? { dueDate: review.dueDate } : {}),
    ...(review.reason ? { reason: review.reason } : {}),
    stale,
    conflicting,
  };
}

function buildContext(
  config: LorelineConfig,
  sources: InterviewSource[],
  reviewLog: ReviewLog | undefined,
  importLog: ImportLog | undefined,
): KnowledgeContext {
  const entries: KnowledgeEntry[] = sources.flatMap((source) =>
    source.record.answers
      .filter((answer) => answer.answer.trim())
      .map((answer) => {
        const review = resolveEntryReview(reviewLog, answer.id, answer.answer);
        return {
          id: answer.id,
          category: answer.category,
          question: answer.question,
          answer: answer.answer,
          source: {
            file: source.file,
            interviewee: source.record.interviewee,
            generatedAt: source.record.generatedAt,
          },
          ...(review ? { review } : {}),
        };
      }),
  );
  const imports: KnowledgeContextImport[] = (importLog?.documents ?? []).map((doc) => ({
    sourceId: doc.sourceId,
    adapter: doc.adapter,
    title: doc.title,
    path: doc.path,
    fingerprint: doc.fingerprint,
    importedAt: doc.importedAt,
    ...(doc.author ? { author: doc.author } : {}),
    ...(doc.updatedAt ? { updatedAt: doc.updatedAt } : {}),
    ...(doc.link ? { link: doc.link } : {}),
  }));
  return {
    schemaVersion: 2,
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
    ...(imports.length > 0 ? { imports } : {}),
  };
}

// Renders the "_Review: ..._" line(s) shown beneath a compiled entry. A
// conflicting review renders both the CONFLICTING fact and the latest
// approved/disputed line; a stale review renders only the stale notice,
// since the underlying approval no longer speaks to the current answer.
function renderReviewLines(review: KnowledgeEntryReview | undefined): string[] {
  if (!review) {
    return [];
  }
  const lines: string[] = [];
  if (review.conflicting) {
    lines.push("_Review: CONFLICTING - approved and disputed for the same answer_");
  }
  if (review.stale) {
    lines.push("_Review: stale (answer changed since review)_");
  } else if (review.status === "approved") {
    lines.push(`_Review: approved by ${review.owner} on ${review.reviewedAt}_`);
  } else {
    lines.push(`_Review: DISPUTED by ${review.owner}: ${review.reason ?? "no reason given"}_`);
  }
  return lines;
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
        .map((entry) => {
          const reviewLines = renderReviewLines(entry.review);
          const reviewSection = reviewLines.length > 0 ? `${reviewLines.join("\n")}\n` : "";
          return `### ${entry.question}

${entry.answer}

_Source: ${entry.source.interviewee}, ${entry.source.generatedAt}, \`${entry.source.file}\`_
${reviewSection}`;
        })
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

## Imported references

${context.imports && context.imports.length > 0
    ? context.imports
        .map((doc) => `- ${doc.title} (${doc.adapter}) - \`${doc.link ?? doc.path}\`, imported ${doc.importedAt}`)
        .join("\n")
    : "No imported references."}
`;
}
