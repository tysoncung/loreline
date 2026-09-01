import type { Citation } from "./citations.js";
import type { HistoryInsights } from "./history.js";
import type { InterviewScope, ScanScope } from "./scope.js";

export type FindingStatus = "pass" | "missing" | "partial";

export interface Finding {
  id: string;
  title: string;
  status: FindingStatus;
  weight: number;
  evidence: string[];
  recommendation: string;
  citations?: Citation[];
}

export interface ReadinessReport {
  schemaVersion: 1 | 2;
  generatedAt: string;
  root: string;
  score: number;
  summary: {
    passed: number;
    partial: number;
    missing: number;
    filesScanned: number;
  };
  scope?: ScanScope;
  findings: Finding[];
  history?: HistoryInsights;
}

export interface LorelineConfig {
  schemaVersion: 1;
  project: {
    name: string;
    owner: string;
  };
  scan: {
    include: string[];
    exclude: string[];
    maxFiles: number;
  };
  output: {
    directory: string;
  };
}

export interface InterviewQuestion {
  id: string;
  category: string;
  question: string;
  reason: string;
  sourceFinding?: string;
}

export interface InterviewRecord {
  schemaVersion: 1 | 2;
  generatedAt: string;
  project: string;
  interviewee: string;
  interviewer: string;
  sourceReport: string;
  answers: Array<InterviewQuestion & { answer: string }>;
  unanswered: string[];
  scope?: InterviewScope;
}

export interface KnowledgeEntryReview {
  status: "approved" | "disputed";
  owner: string;
  reviewedAt: string;
  dueDate?: string;
  reason?: string;
  stale: boolean;
  conflicting: boolean;
}

export interface KnowledgeEntry {
  id: string;
  category: string;
  question: string;
  answer: string;
  source: {
    file: string;
    interviewee: string;
    generatedAt: string;
  };
  review?: KnowledgeEntryReview;
}

export interface KnowledgeContext {
  schemaVersion: 1 | 2;
  generatedAt: string;
  project: string;
  owner: string;
  entries: KnowledgeEntry[];
  unresolved: Array<{
    id: string;
    question: string;
    sourceFile: string;
  }>;
  sources: Array<{
    file: string;
    interviewee: string;
    generatedAt: string;
  }>;
}

export interface VerificationIssue {
  file: string;
  severity: "error" | "warning";
  message: string;
}

export interface VerificationReport {
  schemaVersion: 1;
  generatedAt: string;
  project: string;
  recordsChecked: number;
  valid: boolean;
  issues: VerificationIssue[];
}
