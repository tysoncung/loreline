#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { initialize, loadConfig } from "./config.js";
import { conductInterview, writeInterview } from "./interview.js";
import { scanRepository, writeReport } from "./scanner.js";
import type { ReadinessReport } from "./types.js";

const VERSION = "0.1.0";

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
    },
  });
  const root = path.resolve(values.path);
  const config = await loadConfig(root);
  const report = await scanRepository(root, config);
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
    },
  });
  if (!values.interviewee) {
    throw new Error("--interviewee is required.");
  }

  const root = path.resolve(values.path);
  const config = await loadConfig(root);
  const reportPath = path.join(root, config.output.directory, "readiness.json");
  let report: ReadinessReport;
  try {
    report = JSON.parse(await readFile(reportPath, "utf8")) as ReadinessReport;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
    report = await scanRepository(root, config);
    await writeReport(report, path.join(root, config.output.directory));
  }

  const record = await conductInterview({
    config,
    report,
    reportPath: path.relative(root, reportPath),
    interviewee: values.interviewee,
    interviewer: values.interviewer,
    ...(values.answers ? { answersPath: path.resolve(values.answers) } : {}),
  });
  const output = await writeInterview(record, path.join(root, config.output.directory));
  console.log(`Captured ${record.answers.length} answers (${record.unanswered.length} unanswered).`);
  console.log(`Knowledge record: ${output.markdownPath}`);
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
  loreline scan [--path <directory>] [--json] [--fail-under <score>]
  loreline interview --interviewee <name> [--path <directory>] [--answers <file>]

Commands:
  init       Create loreline.yaml and the knowledge workspace
  scan       Assess a repository and write machine-readable readiness reports
  interview  Run an adaptive knowledge-transfer interview
`);
}

main().catch((error: unknown) => {
  console.error(`Loreline error: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
