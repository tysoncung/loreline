import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { KnowledgeContext } from "./types.js";
import { validateArtifact } from "./validation.js";

export interface ReviewEntry {
  entryId: string;
  answerFingerprint: string;
  status: "approved" | "disputed";
  owner: string;
  reviewers: string[];
  reason?: string;
  reviewedAt: string;
  dueDate?: string;
}

export interface ReviewLog {
  schemaVersion: 1;
  project: string;
  entries: ReviewEntry[];
}

const REVIEWS_FILE = "reviews.json";

export async function loadReviews(outputDirectory: string): Promise<ReviewLog | undefined> {
  const reviewsPath = path.join(outputDirectory, REVIEWS_FILE);
  try {
    const value: unknown = JSON.parse(await readFile(reviewsPath, "utf8"));
    return await validateArtifact<ReviewLog>("reviews", value, reviewsPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

export async function saveReviews(outputDirectory: string, log: ReviewLog): Promise<string> {
  await mkdir(outputDirectory, { recursive: true });
  const reviewsPath = path.join(outputDirectory, REVIEWS_FILE);
  await validateArtifact<ReviewLog>("reviews", log, reviewsPath);
  const tempPath = `${reviewsPath}.tmp`;
  await writeFile(tempPath, `${JSON.stringify(log, null, 2)}\n`);
  await rename(tempPath, reviewsPath);
  return reviewsPath;
}

// Appends a review to the log. History is never overwritten or mutated: every
// call to `recordReview` for the same entryId/answerFingerprint adds a new,
// independent entry so the full approval/dispute trail stays visible.
// AI-origin answers are never auto-approved: approval only ever comes through
// this function, and it refuses an owner of "ai" (case-insensitive) or an
// empty/whitespace owner, so nothing can record a review without a real
// accountable human.
export function recordReview(log: ReviewLog, entry: ReviewEntry): void {
  const owner = entry.owner.trim();
  if (!owner || owner.toLowerCase() === "ai") {
    throw new Error(
      `Invalid review owner "${entry.owner}": reviews must be recorded by a named human owner.`,
    );
  }
  log.entries.push({ ...entry, owner });
}

export interface EffectiveReview {
  entry?: ReviewEntry;
  stale: boolean;
  conflicting: boolean;
}

// Resolves the review that currently applies to one compiled entry:
// - Only reviews recorded against `entryId` are considered.
// - "Current" reviews are the ones whose answerFingerprint matches the
//   entry's present-day answer; the latest of those (by reviewedAt) wins.
// - If reviews exist for the entryId but none are current, the answer has
//   changed since it was last reviewed: `stale` is true and no entry is
//   returned (a stale review is not authoritative for the current answer).
// - `conflicting` is true when the current reviews include both an approved
//   and a disputed entry for the same answer; both stay in the log, but the
//   latest one is what `entry` reports.
export function effectiveReview(
  log: ReviewLog | undefined,
  entryId: string,
  answerFingerprint: string,
): EffectiveReview {
  const forEntry = (log?.entries ?? []).filter((review) => review.entryId === entryId);
  if (forEntry.length === 0) {
    return { stale: false, conflicting: false };
  }

  const current = forEntry.filter((review) => review.answerFingerprint === answerFingerprint);
  if (current.length === 0) {
    return { stale: true, conflicting: false };
  }

  const latest = current.reduce((best, review) =>
    new Date(review.reviewedAt).getTime() >= new Date(best.reviewedAt).getTime() ? review : best,
  );
  const conflicting =
    current.some((review) => review.status === "approved") &&
    current.some((review) => review.status === "disputed");

  return { entry: latest, stale: false, conflicting };
}

export function fingerprintAnswer(answer: string): string {
  return createHash("sha256").update(answer).digest("hex");
}

export interface ApplyReviewOptions {
  entryId: string;
  status: "approved" | "disputed";
  owner: string;
  reviewers: string[];
  reason?: string;
  dueDate?: string;
  reviewedAt?: string;
}

export interface ApplyReviewResult {
  reviewsPath: string;
  entriesReviewed: number;
}

// Drives the `loreline review` command: loads the compiled context, finds
// every compiled entry matching `entryId` (an id can be ambiguous across
// interview records answering the same question differently), and records
// one review per distinct answer version so effectiveReview can later
// disambiguate by fingerprint.
export async function applyReview(
  outputDirectory: string,
  options: ApplyReviewOptions,
): Promise<ApplyReviewResult> {
  const contextPath = path.join(outputDirectory, "context.json");
  let context: KnowledgeContext;
  try {
    const value: unknown = JSON.parse(await readFile(contextPath, "utf8"));
    context = await validateArtifact<KnowledgeContext>("context", value, contextPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(
        `No compiled knowledge context found at ${contextPath}. Run "loreline compile" first.`,
      );
    }
    throw error;
  }

  const matches = context.entries.filter((entry) => entry.id === options.entryId);
  if (matches.length === 0) {
    throw new Error(
      `Unknown entry id "${options.entryId}". Run "loreline compile" first, or check the id in ${contextPath}.`,
    );
  }

  const fingerprints = new Set(matches.map((entry) => fingerprintAnswer(entry.answer)));
  const log = (await loadReviews(outputDirectory)) ?? {
    schemaVersion: 1 as const,
    project: context.project,
    entries: [],
  };
  const reviewedAt = options.reviewedAt ?? new Date().toISOString();

  for (const fingerprint of fingerprints) {
    recordReview(log, {
      entryId: options.entryId,
      answerFingerprint: fingerprint,
      status: options.status,
      owner: options.owner,
      reviewers: options.reviewers,
      reviewedAt,
      ...(options.reason ? { reason: options.reason } : {}),
      ...(options.dueDate ? { dueDate: options.dueDate } : {}),
    });
  }

  const reviewsPath = await saveReviews(outputDirectory, log);
  return { reviewsPath, entriesReviewed: fingerprints.size };
}
