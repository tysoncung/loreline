import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import {
  createSession,
  loadSession,
  recordAnswer,
  saveSession,
  toInterviewRecord,
  type InterviewSession,
} from "./session.js";
import type {
  InterviewQuestion,
  InterviewRecord,
  LorelineConfig,
  ReadinessReport,
} from "./types.js";
import { validateArtifact } from "./validation.js";

const BASE_QUESTIONS: InterviewQuestion[] = [
  {
    id: "hidden-context",
    category: "tacit-knowledge",
    question: "What would surprise a capable person working on this project for the first time?",
    reason: "Surfaces assumptions that are rarely written down.",
  },
  {
    id: "fragile-areas",
    category: "risk",
    question: "Which parts are fragile, risky, or safe to change only with special care?",
    reason: "Captures operational and maintenance risk.",
  },
  {
    id: "first-response",
    category: "operations",
    question: "When something goes wrong, what do you check first and why?",
    reason: "Captures practiced diagnostic knowledge.",
  },
  {
    id: "human-network",
    category: "ownership",
    question: "Who knows the most about each major area, including external dependencies?",
    reason: "Makes the human knowledge network discoverable.",
  },
];

const FINDING_QUESTIONS: Record<string, InterviewQuestion> = {
  "project-overview": {
    id: "project-purpose",
    category: "purpose",
    question: "What problem does this project solve, for whom, and what is explicitly out of scope?",
    reason: "The repository has no complete project overview.",
    sourceFinding: "project-overview",
  },
  "ai-guidance": {
    id: "working-conventions",
    category: "workflow",
    question: "What conventions and verification steps must every contributor or AI agent follow?",
    reason: "The repository has no AI-specific working guidance.",
    sourceFinding: "ai-guidance",
  },
  ownership: {
    id: "area-ownership",
    category: "ownership",
    question: "Who owns each major component, and who is the backup when they are unavailable?",
    reason: "Ownership is not explicitly documented.",
    sourceFinding: "ownership",
  },
  architecture: {
    id: "system-shape",
    category: "architecture",
    question: "Walk through the main components and data flow. Which boundaries are intentional?",
    reason: "Architecture and boundaries are not documented.",
    sourceFinding: "architecture",
  },
  decisions: {
    id: "irreversible-decisions",
    category: "decisions",
    question: "Which decisions should not be reversed without first understanding their history?",
    reason: "Decision history is not documented.",
    sourceFinding: "decisions",
  },
  operations: {
    id: "failure-playbook",
    category: "operations",
    question: "Describe the most common failure modes, warning signs, and recovery steps.",
    reason: "Operational knowledge and troubleshooting are not documented.",
    sourceFinding: "operations",
  },
  verification: {
    id: "confidence-check",
    category: "verification",
    question: "How do you know a change is safe before releasing it, including checks that are still manual?",
    reason: "Automated verification is missing or incomplete.",
    sourceFinding: "verification",
  },
};

export function buildInterviewQuestions(report: ReadinessReport): InterviewQuestion[] {
  const targeted = report.findings
    .filter((finding) => finding.status !== "pass")
    .map((finding) => FINDING_QUESTIONS[finding.id])
    .filter((question): question is InterviewQuestion => question !== undefined);
  return [...targeted, ...BASE_QUESTIONS];
}

export async function conductInterview(options: {
  config: LorelineConfig;
  report: ReadinessReport;
  reportPath: string;
  interviewee?: string;
  interviewer: string;
  answersPath?: string;
  outputDirectory: string;
  resume?: string;
  revise?: boolean;
  onSessionStart?: (session: InterviewSession) => void;
}): Promise<InterviewRecord> {
  const suppliedAnswers = options.answersPath
    ? await loadSuppliedAnswers(options.answersPath)
    : undefined;
  const terminal = suppliedAnswers ? undefined : createInterface({ input, output });

  try {
    const session: InterviewSession = options.resume
      ? await loadSession(options.outputDirectory, options.resume)
      : createSession({
          project: options.config.project.name,
          interviewee: requireInterviewee(options.interviewee),
          interviewer: options.interviewer,
          sourceReport: options.reportPath,
          questions: buildInterviewQuestions(options.report),
        });
    options.onSessionStart?.(session);

    // Persist immediately so an interruption before the first answer still
    // leaves a resumable session on disk.
    await saveSession(options.outputDirectory, session);

    for (const question of session.questions) {
      const existing = session.answers.find((entry) => entry.id === question.id);
      const shouldPrompt = !existing || options.revise === true;
      if (!shouldPrompt) {
        continue;
      }

      const supplied = suppliedAnswers?.[question.id];
      const raw = supplied ?? (await terminal?.question(`\n${question.question}\n> `)) ?? "";
      const trimmed = raw.trim();
      if (!trimmed) {
        continue;
      }

      recordAnswer(session, question.id, trimmed, options.interviewer, {
        revise: existing !== undefined,
      });
      // Persist after every accepted answer so interruption or a thrown
      // provider error mid-interview leaves the open session on disk.
      await saveSession(options.outputDirectory, session);
    }

    session.status = "completed";
    session.updatedAt = new Date().toISOString();
    await saveSession(options.outputDirectory, session);

    return toInterviewRecord(session);
  } finally {
    terminal?.close();
  }
}

function requireInterviewee(interviewee: string | undefined): string {
  if (!interviewee) {
    throw new Error("--interviewee is required to start a new interview.");
  }
  return interviewee;
}

export async function writeInterview(
  record: InterviewRecord,
  outputDirectory: string,
): Promise<{ jsonPath: string; markdownPath: string }> {
  const interviewsDirectory = path.join(outputDirectory, "interviews");
  await mkdir(interviewsDirectory, { recursive: true });
  const stamp = record.generatedAt.replace(/[:.]/g, "-");
  const baseName = `${stamp}-${slug(record.interviewee)}`;
  const jsonPath = path.join(interviewsDirectory, `${baseName}.json`);
  const markdownPath = path.join(interviewsDirectory, `${baseName}.md`);
  await validateArtifact<InterviewRecord>("interview", record, jsonPath);
  await Promise.all([
    writeFile(jsonPath, `${JSON.stringify(record, null, 2)}\n`),
    writeFile(markdownPath, renderInterview(record)),
  ]);
  return { jsonPath, markdownPath };
}

async function loadSuppliedAnswers(file: string): Promise<Record<string, string>> {
  const value: unknown = JSON.parse(await readFile(file, "utf8"));
  if (
    typeof value !== "object" ||
    value === null ||
    Object.values(value).some((answer) => typeof answer !== "string")
  ) {
    throw new Error(`Answers file must be a JSON object of string values: ${file}`);
  }
  return value as Record<string, string>;
}

export function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "unknown";
}

function renderInterview(record: InterviewRecord): string {
  const entries = record.answers
    .map(
      (answer) => `## ${answer.question}

**Category:** ${answer.category}
**Why asked:** ${answer.reason}

${answer.answer || "_Unanswered_"}
`,
    )
    .join("\n");
  return `# Knowledge Interview: ${record.interviewee}

**Project:** ${record.project}
**Interviewed:** ${record.generatedAt}
**Interviewer:** ${record.interviewer}

${entries}
`;
}
