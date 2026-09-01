#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { initialize, loadConfig, loadRequiredConfig } from "./config.js";
import { analyzeHistory } from "./history.js";
import { conductInterview, writeInterview } from "./interview.js";
import {
  compileKnowledge,
  verifyKnowledge,
  writeVerificationReport,
} from "./knowledge.js";
import { scanDocuments } from "./docscan.js";
import { applyReview } from "./review.js";
import { scanRepository, writeReport } from "./scanner.js";
import { selectInteractively, type InterviewScope } from "./scope.js";
import type { ReadinessReport } from "./types.js";
import { validateArtifact } from "./validation.js";

const VERSION = "0.2.0";

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);
  if (!command || command === "help" || command === "--help" || command === "-h") {
    printHelp();
    return;
  }
  if (command === "--version" || command === "-v") {
    console.log(VERSION);
    return;
  }

  switch (command) {
    case "init":
      await initCommand(args);
      break;
    case "scan":
      await scanCommand(args);
      break;
    case "interview":
      await interviewCommand(args);
      break;
    case "compile":
      await compileCommand(args);
      break;
    case "verify":
      await verifyCommand(args);
      break;
    case "review":
      await reviewCommand(args);
      break;
    default:
      throw new Error(`Unknown command "${command}". Run "loreline help" for usage.`);
  }

}

async function initCommand(args: string[]): Promise<void> {
  const { values } = parseArgs({
    args,
    options: { path: { type: "string", short: "p", default: "." } },
  });
  const root = path.resolve(values.path);
  const result = await initialize(root);
  console.log(result.created ? `Created ${result.configPath}` : `Already initialized: ${result.configPath}`);
}

async function scanCommand(args: string[]): Promise<void> {
  const { values } = parseArgs({
    args,
    options: {
      path: { type: "string", short: "p", default: "." },
      json: { type: "boolean", default: false },
      "fail-under": { type: "string" },
      include: { type: "string", multiple: true, default: [] },
      exclude: { type: "string", multiple: true, default: [] },
      "no-history": { type: "boolean", default: false },
      "exclude-identity": { type: "string", multiple: true, default: [] },
      mode: { type: "string", default: "repository" },
    },
  });
  if (values.mode !== "repository" && values.mode !== "documents") {
    throw new Error('--mode must be "repository" or "documents".');
  }

  const root = path.resolve(values.path);
  const config = await loadConfig(root);

  let report: ReadinessReport;
  if (values.mode === "documents") {
    // Document mode inspects a documentation collection rather than the
    // whole repository, so git history analysis (which characterizes
    // ownership across source files) does not apply and is skipped entirely.
    report = await scanDocuments(root, config);
  } else {
    const history = values["no-history"]
      ? undefined
      : await analyzeHistory(root, { excludeIdentities: values["exclude-identity"] });
    report = await scanRepository(
      root,
      config,
      {
        include: values.include,
        exclude: values.exclude,
      },
      history ? { history } : undefined,
    );
  }
  const output = await writeReport(report, path.join(root, config.output.directory));

  if (values.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    printReport(report, output.markdownPath);
  }

  if (values["fail-under"] !== undefined) {
    const threshold = Number(values["fail-under"]);
    if (!Number.isFinite(threshold) || threshold < 0 || threshold > 100) {
      throw new Error("--fail-under must be a number from 0 to 100.");
    }
    if (report.score < threshold) {
      process.exitCode = 2;
    }
  }
}

async function interviewCommand(args: string[]): Promise<void> {
  const { values } = parseArgs({
    args,
    options: {
      path: { type: "string", short: "p", default: "." },
      interviewee: { type: "string" },
      interviewer: { type: "string", default: "Loreline" },
      answers: { type: "string" },
      resume: { type: "string" },
      revise: { type: "boolean", default: false },
      categories: { type: "string" },
      findings: { type: "string" },
      interactive: { type: "boolean", default: false },
    },
  });
  if (!values.interviewee && !values.resume) {
    throw new Error("--interviewee is required.");
  }

  const root = path.resolve(values.path);
  const config = await loadConfig(root);
  const reportPath = path.join(root, config.output.directory, "readiness.json");
  let report: ReadinessReport;
  try {
    const value: unknown = JSON.parse(await readFile(reportPath, "utf8"));
    report = await validateArtifact<ReadinessReport>("readiness", value, reportPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
    report = await scanRepository(root, config);
    await writeReport(report, path.join(root, config.output.directory));
  }

  let findings = values.findings ? splitList(values.findings) : undefined;
  const categories = values.categories ? splitList(values.categories) : undefined;

  if (values.interactive) {
    if (!process.stdin.isTTY) {
      throw new Error("--interactive requires an interactive terminal (TTY) for stdin.");
    }
    const items = report.findings
      .filter((finding) => finding.status !== "pass")
      .map((finding) => ({ id: finding.id, label: `${finding.title} (${finding.status})` }));
    findings = await selectInteractively("Select findings to focus the interview on", items);
  }

  const scope: InterviewScope | undefined =
    categories || findings ? { ...(categories ? { categories } : {}), ...(findings ? { findings } : {}) } : undefined;

  const record = await conductInterview({
    config,
    report,
    reportPath: path.relative(root, reportPath),
    ...(values.interviewee ? { interviewee: values.interviewee } : {}),
    interviewer: values.interviewer,
    outputDirectory: path.join(root, config.output.directory),
    ...(values.answers ? { answersPath: path.resolve(values.answers) } : {}),
    ...(values.resume ? { resume: values.resume } : {}),
    revise: values.revise,
    ...(scope ? { scope } : {}),
    onSessionStart: (session) => {
      console.log(`Session: ${session.sessionId} (resume with --resume ${session.sessionId})`);
    },
  });
  const output = await writeInterview(record, path.join(root, config.output.directory));
  console.log(`Captured ${record.answers.length} answers (${record.unanswered.length} unanswered).`);
  console.log(`Knowledge record: ${output.markdownPath}`);
}

async function compileCommand(args: string[]): Promise<void> {
  const { values } = parseArgs({
    args,
    options: { path: { type: "string", short: "p", default: "." } },
  });
  const root = path.resolve(values.path);
  const config = await loadRequiredConfig(root);
  const result = await compileKnowledge(config, path.join(root, config.output.directory));
  console.log(`Compiled ${result.answers} answers from ${result.records} interview record(s).`);
  console.log(`AI context: ${result.markdownPath}`);
  console.log(`Structured context: ${result.jsonPath}`);
}

async function verifyCommand(args: string[]): Promise<void> {
  const { values } = parseArgs({
    args,
    options: {
      path: { type: "string", short: "p", default: "." },
      "max-age": { type: "string", default: "180" },
      json: { type: "boolean", default: false },
      "require-approval": { type: "boolean", default: false },
    },
  });
  const maxAgeDays = Number(values["max-age"]);
  if (!Number.isInteger(maxAgeDays) || maxAgeDays < 1) {
    throw new Error("--max-age must be a positive whole number of days.");
  }

  const root = path.resolve(values.path);
  const config = await loadRequiredConfig(root);
  const outputDirectory = path.join(root, config.output.directory);
  const report = await verifyKnowledge(config, outputDirectory, maxAgeDays, root, new Date(), {
    requireApproval: values["require-approval"],
  });
  const reportPath = await writeVerificationReport(report, outputDirectory);
  if (values.json) {
    console.log(JSON.stringify(report, null, 2));
  } else if (report.valid) {
    console.log(`Knowledge verification passed (${report.recordsChecked} record(s)).`);
    console.log(`Report: ${reportPath}`);
  } else {
    console.log(`Knowledge verification found ${report.issues.length} issue(s):`);
    for (const issue of report.issues) {
      console.log(`- ${issue.severity.toUpperCase()} ${issue.file}: ${issue.message}`);
    }
    console.log(`Report: ${reportPath}`);
  }
  if (!report.valid) {
    process.exitCode = 2;
  }
}

async function reviewCommand(args: string[]): Promise<void> {
  const { values } = parseArgs({
    args,
    options: {
      path: { type: "string", short: "p", default: "." },
      entry: { type: "string" },
      approve: { type: "boolean", default: false },
      dispute: { type: "boolean", default: false },
      owner: { type: "string" },
      reviewer: { type: "string", multiple: true, default: [] },
      reason: { type: "string" },
      due: { type: "string" },
    },
  });

  if (!values.entry) {
    throw new Error("--entry is required.");
  }
  if (values.approve === values.dispute) {
    throw new Error("Exactly one of --approve or --dispute is required.");
  }
  if (!values.owner) {
    throw new Error("--owner is required.");
  }

  const root = path.resolve(values.path);
  const config = await loadRequiredConfig(root);
  const outputDirectory = path.join(root, config.output.directory);
  const status = values.approve ? "approved" : "disputed";
  const result = await applyReview(outputDirectory, {
    entryId: values.entry,
    status,
    owner: values.owner,
    reviewers: values.reviewer,
    ...(values.reason ? { reason: values.reason } : {}),
    ...(values.due ? { dueDate: values.due } : {}),
  });

  console.log(
    `Recorded ${status} review for "${values.entry}" (${result.entriesReviewed} answer version(s)).`,
  );
  console.log(`Reviews: ${result.reviewsPath}`);
}

function splitList(value: string): string[] {
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

function printReport(report: ReadinessReport, outputPath: string): void {
  console.log(`\nLoreline AI readiness: ${report.score}/100\n`);
  for (const finding of report.findings) {
    const marker = finding.status === "pass" ? "✓" : finding.status === "partial" ? "~" : "✗";
    console.log(`${marker} ${finding.title}: ${finding.status}`);
  }
  console.log(`\nReport: ${outputPath}`);
}

function printHelp(): void {
  console.log(`Loreline ${VERSION}
Turn undocumented organizational knowledge into verified, AI-ready context.

Usage:
  loreline init [--path <directory>]
  loreline scan [--path <directory>] [--json] [--fail-under <score>] [--include <glob>] [--exclude <glob>]
  loreline scan [...] [--no-history] [--exclude-identity <name>]
  loreline scan [...] [--mode repository|documents]
  loreline interview --interviewee <name> [--path <directory>] [--answers <file>]
  loreline interview --resume <sessionId> [--revise] [--path <directory>] [--answers <file>]
  loreline interview [...] [--categories <list>] [--findings <list>] [--interactive]
  loreline compile [--path <directory>]
  loreline verify [--path <directory>] [--max-age <days>] [--json] [--require-approval]
  loreline review --entry <id> --approve|--dispute --owner <name> [--reviewer <name> ...] [--reason <text>] [--due <YYYY-MM-DD>]

Commands:
  init       Create loreline.yaml and the knowledge workspace
  scan       Assess a repository and write machine-readable readiness reports
             --mode repository (default) scans the whole project; --mode
             documents scans a documentation collection (README/index
             structure, ownership, freshness, linkage, terminology,
             operational docs) and skips git history analysis
  interview  Run an adaptive knowledge-transfer interview
  compile    Compile interview records into reviewable AI context
  verify     Check knowledge records for completeness and freshness
  review     Record human approval or dispute for a compiled knowledge entry
`);
}

main().catch((error: unknown) => {
  console.error(`Loreline error: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
