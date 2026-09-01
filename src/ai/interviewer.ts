import type { AiMessage, AiProvider } from "../providers/types.js";
import { ProviderError } from "../providers/types.js";
import type { InterviewQuestion, ReadinessReport } from "../types.js";

export const PROMPT_VERSION = "interview-v1";

export interface AiInterviewOptions {
  provider: AiProvider;
  report: ReadinessReport;
  evidence: Array<{ file: string; excerpt: string }>;
  maxQuestions?: number;
  maxFollowups?: number;
}

interface RawQuestion {
  question: string;
  category: string;
  reason: string;
  sourceFinding?: string;
}

const DEFAULT_MAX_QUESTIONS = 5;

const QUESTIONS_SYSTEM_PROMPT = `You are helping run a knowledge-transfer interview for a software project.
Read the readiness findings and evidence excerpts in the user message, then propose interview questions
that would surface knowledge missing from the findings and evidence. Return ONLY a JSON array of objects,
each shaped as {"question": string, "category": string, "reason": string, "sourceFinding": string (optional)}.
Do not include any prose, explanation, or markdown code fences. Return only the raw JSON array.`;

const FOLLOWUP_SYSTEM_PROMPT = `You are helping run a knowledge-transfer interview for a software project.
The interviewee gave a brief answer to a question. Decide whether one short follow-up question would help
get a more complete answer. If so, reply with ONLY that follow-up question and nothing else. If not, reply
with exactly the single word NONE and nothing else.`;

const CONTRADICTION_SYSTEM_PROMPT = `You are reviewing the answers from a knowledge-transfer interview for
contradictions between different answers. Return ONLY a JSON array of strings, each describing one possible
contradiction between two answers. If there are no contradictions, return an empty JSON array: [].
Do not include any prose, explanation, or markdown code fences.`;

const RETRY_INSTRUCTION =
  'Your previous response was not a valid JSON array. Reply again with ONLY a JSON array of objects shaped ' +
  'as {"question": string, "category": string, "reason": string, "sourceFinding": string (optional)}. ' +
  "Do not include any prose or markdown code fences.";

/**
 * Asks the provider for candidate interview questions grounded in the
 * report's non-passing findings and the (already secret-redacted) evidence
 * excerpts. Invalid model output is retried once with a corrective
 * instruction appended to the conversation; a second invalid response
 * raises a ProviderError. Accepted questions are assigned sequential
 * `ai-<n>` ids in acceptance order and stamped with provenance.
 */
export async function generateQuestions(options: AiInterviewOptions): Promise<InterviewQuestion[]> {
  const { provider, report, evidence } = options;
  const maxQuestions = options.maxQuestions ?? DEFAULT_MAX_QUESTIONS;
  const findingIds = new Set(report.findings.map((finding) => finding.id));

  const messages: AiMessage[] = [
    { role: "system", content: QUESTIONS_SYSTEM_PROMPT },
    { role: "user", content: buildQuestionsUserMessage(report, evidence) },
  ];

  let items = await requestQuestionArray(provider, messages);
  if (items === undefined) {
    messages.push({ role: "user", content: RETRY_INSTRUCTION });
    items = await requestQuestionArray(provider, messages);
  }
  if (items === undefined) {
    throw new ProviderError("provider returned invalid question JSON");
  }

  const accepted: InterviewQuestion[] = [];
  const acceptedTexts = new Set<string>();

  for (const item of items) {
    if (accepted.length >= maxQuestions) {
      break;
    }
    if (!isValidRawQuestion(item)) {
      continue;
    }
    if (item.sourceFinding !== undefined && !findingIds.has(item.sourceFinding)) {
      continue;
    }
    const normalized = item.question.trim().toLowerCase();
    if (acceptedTexts.has(normalized)) {
      continue;
    }
    acceptedTexts.add(normalized);

    const question: InterviewQuestion = {
      id: `ai-${accepted.length + 1}`,
      category: item.category,
      question: item.question,
      reason: item.reason,
      ...(item.sourceFinding !== undefined ? { sourceFinding: item.sourceFinding } : {}),
      origin: stampOrigin(provider),
    };
    accepted.push(question);
  }

  return accepted;
}

/**
 * Asks the provider whether a brief answer deserves a follow-up. Callers
 * decide when to invoke this (typically when the trimmed answer is under
 * 60 characters); the provider itself decides whether a follow-up is
 * warranted by replying with the literal word NONE when it is not.
 */
export async function generateFollowup(
  provider: AiProvider,
  question: InterviewQuestion,
  answer: string,
): Promise<InterviewQuestion | undefined> {
  const result = await provider.complete({
    messages: [
      { role: "system", content: FOLLOWUP_SYSTEM_PROMPT },
      {
        role: "user",
        content: `Question: ${question.question}\nAnswer: ${answer}\n\nReply with ONE short follow-up question, or the single word NONE if no follow-up is needed.`,
      },
    ],
  });

  const text = result.text.trim();
  if (text.toUpperCase() === "NONE") {
    return undefined;
  }

  return {
    id: `${question.id}-followup`,
    category: question.category,
    question: text,
    reason: "Follow-up: the previous answer was brief.",
    origin: stampOrigin(provider),
  };
}

/**
 * Asks the provider to flag possible contradictions across every
 * question/answer pair. Parses leniently and never throws: any failure
 * (provider error, invalid JSON, unexpected shape) resolves to an empty
 * list rather than interrupting the interview, since contradiction
 * detection is advisory and never auto-resolved.
 */
export async function detectContradictions(
  provider: AiProvider,
  answers: Array<{ question: string; answer: string }>,
): Promise<string[]> {
  if (answers.length === 0) {
    return [];
  }

  try {
    const userContent = answers
      .map((entry, index) => `${index + 1}. Q: ${entry.question}\n   A: ${entry.answer}`)
      .join("\n");
    const result = await provider.complete({
      messages: [
        { role: "system", content: CONTRADICTION_SYSTEM_PROMPT },
        { role: "user", content: userContent },
      ],
    });

    const parsed: unknown = JSON.parse(stripCodeFences(result.text));
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
  } catch {
    return [];
  }
}

function buildQuestionsUserMessage(
  report: ReadinessReport,
  evidence: Array<{ file: string; excerpt: string }>,
): string {
  const findings = report.findings
    .filter((finding) => finding.status !== "pass")
    .map((finding) => ({ id: finding.id, title: finding.title, recommendation: finding.recommendation }));

  const evidenceBlock =
    evidence.length > 0
      ? evidence.map((item) => `### ${item.file}\n${item.excerpt}`).join("\n\n")
      : "(no evidence files provided)";

  return `Readiness findings that are not passing:\n${JSON.stringify(findings, null, 2)}\n\nEvidence excerpts:\n${evidenceBlock}`;
}

async function requestQuestionArray(
  provider: AiProvider,
  messages: AiMessage[],
): Promise<unknown[] | undefined> {
  const result = await provider.complete({ messages });
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripCodeFences(result.text));
  } catch {
    return undefined;
  }
  return Array.isArray(parsed) ? parsed : undefined;
}

function isValidRawQuestion(value: unknown): value is RawQuestion {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.question === "string" &&
    candidate.question.trim().length > 0 &&
    typeof candidate.category === "string" &&
    candidate.category.trim().length > 0 &&
    typeof candidate.reason === "string" &&
    candidate.reason.trim().length > 0 &&
    (candidate.sourceFinding === undefined || typeof candidate.sourceFinding === "string")
  );
}

function stampOrigin(provider: AiProvider): NonNullable<InterviewQuestion["origin"]> {
  return { type: "ai", provider: provider.name, model: provider.model, promptVersion: PROMPT_VERSION };
}

// Strips a single leading/trailing markdown code fence (```json ... ``` or
// ``` ... ```) if present, so a model response wrapped in a fence still
// parses as JSON. Leaves unfenced text untouched.
export function stripCodeFences(text: string): string {
  const trimmed = text.trim();
  const match = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return match ? (match[1] ?? "").trim() : trimmed;
}
