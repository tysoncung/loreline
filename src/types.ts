export type FindingStatus = "pass" | "missing" | "partial";

export interface Finding {
  id: string;
  title: string;
  status: FindingStatus;
  weight: number;
  evidence: string[];
  recommendation: string;
}

export interface ReadinessReport {
  schemaVersion: 1;
  generatedAt: string;
  root: string;
  score: number;
  summary: {
    passed: number;
    partial: number;
    missing: number;
    filesScanned: number;
  };
  findings: Finding[];
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
  schemaVersion: 1;
  generatedAt: string;
  project: string;
  interviewee: string;
  interviewer: string;
  sourceReport: string;
  answers: Array<InterviewQuestion & { answer: string }>;
  unanswered: string[];
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
