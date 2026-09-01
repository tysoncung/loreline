import { mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { slug } from "./interview.js";
import type { InterviewScope } from "./scope.js";
import type { InterviewQuestion, InterviewRecord } from "./types.js";
import { validateArtifact } from "./validation.js";

export interface SessionAnswer {
  id: string;
  answer: string;
  answeredAt: string;
  author: string;
  revisions: Array<{ answer: string; answeredAt: string; author: string }>;
}

export interface InterviewSession {
  schemaVersion: 1;
  sessionId: string;
  createdAt: string;
  updatedAt: string;
  project: string;
  interviewee: string;
  interviewer: string;
  sourceReport: string;
  status: "open" | "completed";
  questions: InterviewQuestion[];
  answers: SessionAnswer[];
  scope?: InterviewScope;
}

export function createSession(options: {
  project: string;
  interviewee: string;
  interviewer: string;
  sourceReport: string;
  questions: InterviewQuestion[];
  scope?: InterviewScope;
}): InterviewSession {
  const now = new Date().toISOString();
  return {
    schemaVersion: 1,
    sessionId: `${stamp(now)}-${slug(options.interviewee)}`,
    createdAt: now,
    updatedAt: now,
    project: options.project,
    interviewee: options.interviewee,
    interviewer: options.interviewer,
    sourceReport: options.sourceReport,
    status: "open",
    questions: options.questions,
    answers: [],
    ...(options.scope ? { scope: options.scope } : {}),
  };
}

export async function saveSession(
  outputDirectory: string,
  session: InterviewSession,
): Promise<string> {
  const sessionsDirectory = path.join(outputDirectory, "sessions");
  await mkdir(sessionsDirectory, { recursive: true });
  const sessionPath = path.join(sessionsDirectory, `${session.sessionId}.json`);
  const tempPath = `${sessionPath}.tmp`;
  await validateArtifact<InterviewSession>("session", session, sessionPath);
  await writeFile(tempPath, `${JSON.stringify(session, null, 2)}\n`);
  await rename(tempPath, sessionPath);
  return sessionPath;
}

export async function loadSession(
  outputDirectory: string,
  sessionId: string,
): Promise<InterviewSession> {
  const sessionsDirectory = path.join(outputDirectory, "sessions");
  const sessionPath = path.join(sessionsDirectory, `${sessionId}.json`);
  try {
    const value: unknown = JSON.parse(await readFile(sessionPath, "utf8"));
    return await validateArtifact<InterviewSession>("session", value, sessionPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      const available = await listSessionIds(sessionsDirectory);
      const list = available.length > 0 ? available.join(", ") : "none";
      throw new Error(`Session "${sessionId}" not found. Available sessions: ${list}`);
    }
    throw error;
  }
}

export function recordAnswer(
  session: InterviewSession,
  questionId: string,
  answer: string,
  author: string,
  options?: { revise?: boolean },
): void {
  const now = new Date().toISOString();
  const existing = session.answers.find((entry) => entry.id === questionId);
  if (existing) {
    if (!options?.revise) {
      throw new Error(`Question "${questionId}" is already answered; pass --revise to change it.`);
    }
    existing.revisions.push({
      answer: existing.answer,
      answeredAt: existing.answeredAt,
      author: existing.author,
    });
    existing.answer = answer;
    existing.answeredAt = now;
    existing.author = author;
  } else {
    session.answers.push({ id: questionId, answer, answeredAt: now, author, revisions: [] });
  }
  session.updatedAt = now;
}

export function toInterviewRecord(session: InterviewSession): InterviewRecord {
  const answers = session.questions.map((question) => {
    const recorded = session.answers.find((entry) => entry.id === question.id);
    return { ...question, answer: recorded?.answer ?? "" };
  });
  return {
    schemaVersion: 2,
    generatedAt: session.updatedAt,
    project: session.project,
    interviewee: session.interviewee,
    interviewer: session.interviewer,
    sourceReport: session.sourceReport,
    answers,
    unanswered: answers.filter((answer) => !answer.answer.trim()).map((answer) => answer.id),
    ...(session.scope ? { scope: session.scope } : {}),
  };
}

async function listSessionIds(sessionsDirectory: string): Promise<string[]> {
  try {
    const entries = await readdir(sessionsDirectory);
    return entries
      .filter((entry) => entry.endsWith(".json"))
      .map((entry) => entry.replace(/\.json$/, ""))
      .sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

function stamp(iso: string): string {
  return iso.slice(0, 19).replace(/[-:T]/g, "");
}
